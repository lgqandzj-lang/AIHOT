// Free material preparation only. This entry never accepts or executes model authorizations.
import {readFile,writeFile,mkdir,readdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {sha256,stableJson} from '../packages/backend/src/lib/ids.ts';
import {sql,closeDb} from '../packages/backend/src/db.ts';
import {researchDatabase} from '../packages/backend/src/research/postgres.ts';
import {readChineseReadings,fulltextSnapshot,type FulltextSnapshot} from '../packages/backend/src/research/chinese-reading.ts';
import {genericFulltextSnapshot} from '../packages/backend/src/research/reading-materials.ts';
import {parseReadingQueue} from '../packages/backend/src/research/reading-jobs.ts';

const {positionals,values}=parseArgs({allowPositionals:true,strict:true,options:{limit:{type:'string'}}});
const mode=positionals[0],limit=Number(values.limit||'2');
if(positionals.length!==1||!['plan','prepare'].includes(mode||'')||!Number.isSafeInteger(limit)||limit<1||limit>3)throw new Error('Use plan|prepare [--limit 1..3]');
const database=new URL(process.env.DATABASE_URL||'');
if(process.env.NODE_ENV==='production'||process.env.MODEL_CALLS_ENABLED!=='false'||process.env.COLLECT_ENABLED!=='false'||process.env.INDEXNOW_SUBMIT_ENABLED!=='false'
  ||database.hostname!=='127.0.0.1'||database.pathname!=='/epvoice_content_20261002')throw new Error('Explicit free-preparation flags and the separate local content database are required');
const root=process.cwd(),base=path.join(root,'.data/ep-chinese-reading'),queueFile=path.join(base,'queue.json');
type Queue=ReturnType<typeof parseReadingQueue>;
type Job=Queue['jobs'][number];
type SourcePaper={id:string;title:string;doi:string|null;pmid:string|null;privateResearch?:{recordId:string;readerVersion:number;product:{id:string;status:string};display?:{titleZh:string}}};
const optional=async(file:string):Promise<Record<string,unknown>|null>=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
const saveQueue=async(queue:Queue)=>{parseReadingQueue(queue);const temporary=queueFile+'.tmp';await writeFile(temporary,JSON.stringify(queue,null,2)+'\n','utf8');await rename(temporary,queueFile);};
const reasonCode=(message:string):Job['reason']=> /licen[cs]e|permission|copyright/i.test(message)?'license_unavailable'
  : /identity|different paper|bibliography|metadata requires/i.test(message)?'identity_conflict'
  : /HTTP|fetch failed|timeout|redirect/i.test(message)?'source_unavailable'
  : /abstract|full.text|fragments|coverage/i.test(message)?'materials_incomplete':'preparation_failed';

async function reconcile(job:Job,saved:Awaited<ReturnType<typeof readChineseReadings>>):Promise<Job>{
  const reading=saved.find(reading=>reading.pmid===job.pmid&&reading.doi===job.doi&&reading.originalTitle===job.originalTitle);
  if(reading)return {...job,status:'saved',titleZh:reading.titleZh,updatedAt:reading.generatedAt,reason:null};
  const directory=path.resolve(root,job.directory),state=await optional(path.join(directory,'job-status.json'));
  if(state&&state.pmid!==job.pmid)throw new Error('Queue directory belongs to another paper');
  if(state?.status==='execution_blocked'||state?.status==='in_flight')return {...job,status:'blocked',reason:'execution_uncertain',updatedAt:String(state.updatedAt)};
  if(state?.status==='materials_blocked')return {...job,status:'blocked',reason:reasonCode(String(state.error)),updatedAt:String(state.updatedAt)};
  if(state?.status==='preparing_materials')return {...job,status:'in_flight',reason:null,updatedAt:String(state.updatedAt)};
  const prepared=await optional(path.join(directory,'preflight.json'));
  if(!prepared)return job;
  try{
    if(prepared.pmid!==job.pmid||typeof prepared.recordId!=='string'||typeof prepared.readerId!=='string')throw new Error('Preparation identity mismatch');
    const [record]=await sql<{id:string;title:string;doi:string}[]>`SELECT r.id::text,r.title,r.doi FROM ep_research_records r JOIN ep_research_external_ids x ON x.record_id=r.id WHERE x.kind='pmid' AND x.value=${job.pmid}`;
    if(record?.id!==prepared.recordId||record.title!==job.originalTitle||record.doi!==job.doi)throw new Error('Preparation bibliography changed');
    const fulltext=await optional(path.join(directory,'fulltext.json')) as unknown as FulltextSnapshot;
    const html=await readFile(path.join(directory,'pmc-fulltext.html'),'utf8');
    const identity={pmid:job.pmid,doi:job.doi,pmcid:new URL(fulltext.sourceUrl).pathname.split('/')[2]!};
    const extracted=prepared.promptVersion==='ep-chinese-reading-v2'?genericFulltextSnapshot(html,identity,fulltext.acquiredAt):fulltextSnapshot(html,identity,fulltext.acquiredAt);
    const input=await optional(path.join(directory,'provided-input.json')),request=await optional(path.join(directory,'request-body.json'));
    if(stableJson(extracted)!==stableJson(fulltext)||sha256(html)!==prepared.fulltextHash||sha256(stableJson(input))!==prepared.inputHash||sha256(stableJson(request))!==prepared.requestHash)throw new Error('Prepared source artifacts changed');
    return {...job,recordId:record.id,status:'ready',reason:null,updatedAt:typeof state?.updatedAt==='string'?state.updatedAt:fulltext.acquiredAt};
  }catch{return {...job,status:'blocked',reason:'identity_conflict',updatedAt:new Date().toISOString()};}
}

await mkdir(base,{recursive:true});
const lock=path.join(base,'queue.lock');
let lockHeld=false;
try{
  await writeFile(lock,String(process.pid),{flag:'wx'});lockHeld=true;
  const previous=await optional(queueFile),queue:Queue=previous?parseReadingQueue(previous):{version:'ep-reading-queue-v1',jobs:[]};
  const response=await fetch('http://127.0.0.1:3201/api/research-preview/experience',{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Private bibliography is unavailable');
  const feed=await response.json() as {preview:boolean;papers:SourcePaper[]};
  if(feed.preview!==true||!Array.isArray(feed.papers)||feed.papers.length>100)throw new Error('Invalid private bibliography');
  const selected=new Map<string,SourcePaper>();
  for(const paper of feed.papers){
    const entry=paper.privateResearch;
    if(entry?.product.id!=='varipulse'||entry.product.status!=='confirmed'||!paper.pmid||!paper.doi||!/^[1-9]\d{0,9}$/.test(paper.pmid))continue;
    const prior=selected.get(paper.pmid);
    if(prior&&(prior.title!==paper.title||prior.doi!==paper.doi||prior.privateResearch!.recordId!==entry.recordId))throw new Error('Conflicting bibliography identities');
    if(!prior||entry.readerVersion>prior.privateResearch!.readerVersion)selected.set(paper.pmid,paper);
  }
  const artifacts=new Map<string,string>();
  for(const item of await readdir(base,{withFileTypes:true})){
    if(!item.isDirectory()||!/^[a-z0-9-]+$/.test(item.name)||['work','queue'].includes(item.name))continue;
    const prepared=await optional(path.join(base,item.name,'preflight.json'));
    if(typeof prepared?.pmid==='string'&&!artifacts.has(prepared.pmid))artifacts.set(prepared.pmid,'.data/ep-chinese-reading/'+item.name);
  }
  let added=0;
  for(const paper of selected.values()){
    const existing=queue.jobs.find(job=>job.pmid===paper.pmid);
    if(existing){if(existing.originalTitle!==paper.title||existing.doi!==paper.doi)throw new Error('Queued paper identity changed');existing.readerId=paper.id;continue;}
    queue.jobs.push({pmid:paper.pmid!,doi:paper.doi!,originalTitle:paper.title,titleZh:paper.privateResearch!.display?.titleZh||null,
      readerId:paper.id,recordId:paper.privateResearch!.recordId,directory:artifacts.get(paper.pmid!)||'.data/ep-chinese-reading/pmid-'+paper.pmid,
      status:'pending',updatedAt:null,reason:null});added++;
  }
  const saved=await readChineseReadings(researchDatabase(sql));
  for(let index=0;index<queue.jobs.length;index++)queue.jobs[index]=await reconcile(queue.jobs[index]!,saved);
  await saveQueue(queue);
  let attempted=0;
  if(mode==='prepare')for(let index=0;index<queue.jobs.length&&attempted<limit;index++){
    const job=queue.jobs[index]!;
    if(job.status!=='pending'||!selected.has(job.pmid))continue;
    attempted++;queue.jobs[index]={...job,status:'in_flight',updatedAt:new Date().toISOString(),reason:null};await saveQueue(queue);
    await mkdir(path.resolve(root,job.directory),{recursive:true});
    const executed=spawnSync(process.execPath,['--env-file=.env','scripts/ep-chinese-reading.ts','prepare',job.pmid,'--directory',job.directory],{
      cwd:root,env:{...process.env,NODE_ENV:'development',MODEL_CALLS_ENABLED:'false',COLLECT_ENABLED:'false',INDEXNOW_SUBMIT_ENABLED:'false'},encoding:'utf8',timeout:110000});
    await writeFile(path.resolve(root,job.directory,'queue-prepare.log'),(executed.stdout||'')+(executed.stderr||''));
    queue.jobs[index]=executed.status===0?await reconcile(job,saved):{...job,status:'blocked',reason:reasonCode(executed.stderr||String(executed.error)),updatedAt:new Date().toISOString()};
    await saveQueue(queue);
    if(queue.jobs[index]!.reason==='source_unavailable')break; // Stop this batch; no retry or switch around an unavailable source.
  }
  const counts=Object.fromEntries(['saved','ready','blocked','pending','in_flight'].map(status=>[status,queue.jobs.filter(job=>job.status===status).length]));
  console.log(JSON.stringify({status:'private_preparation_queue',added,attempted,counts,modelRequests:0,automaticRetries:0}));
}finally{
  if(lockHeld){const {unlink}=await import('node:fs/promises');await unlink(lock);}
  await closeDb();
}
