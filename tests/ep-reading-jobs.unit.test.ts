import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseReadingQueue, projectReadingJobs, readReadingJobs } from '../packages/backend/src/research/reading-jobs.ts';

const job = {
  pmid:'39820338',doi:'10.1093/europace/euaf007',originalTitle:'Synthetic VARIPULSE follow-up paper',titleZh:null,
  readerId:'39820338',recordId:'39820338',directory:'.data/ep-chinese-reading/pmid-39820338-20261002',
  status:'ready' as const,updatedAt:'2026-10-02T00:00:00.000Z',reason:null,
};
const queue = {version:'ep-reading-queue-v1' as const,jobs:[job]};
const saved = {
  pmid:job.pmid,doi:job.doi,originalTitle:job.originalTitle,titleZh:'合成论文的已保存中文解读',readerId:'draft-9f379619-63f6-4cb8-92bf-99c11a920053',
  status:'private_model_draft',humanApprovalGranted:false,materialScope:'fulltext',generatedAt:'2026-10-02T01:00:00.000Z',
};

test('queue accepts existing PMID reader IDs and strictly projects only reader-facing fields', () => {
  assert.deepEqual(parseReadingQueue(queue),queue);
  const before = structuredClone(queue);
  const projected = projectReadingJobs(queue);
  assert.deepEqual(Object.keys(projected),['private','jobs']);
  assert.deepEqual(Object.keys(projected.jobs[0]),['pmid','doi','originalTitle','titleZh','readerId','status','updatedAt','reason']);
  assert.equal(projected.private,true);
  assert.equal(projected.jobs[0].status,'ready');
  assert.equal(projected.jobs[0].titleZh,null);
  assert.equal(projected.jobs[0].readerId,job.readerId);
  assert.doesNotMatch(JSON.stringify(projected),/directory|recordId|ep-chinese-reading|\.data/);
  assert.deepEqual(queue,before);
});

test('matching private saved prose supplies its real Chinese title and reader route without diagnostics', () => {
  const blocked = {...queue,jobs:[{...job,status:'blocked',reason:'preparation_failed'}]};
  const marker = 'INTERNAL_CREDENTIAL_HASH_TOKEN_FILE_MUST_NOT_ESCAPE';
  const projected = projectReadingJobs(blocked,[{...saved,requestHash:marker,receipt:marker,credentials:marker,directory:marker}]);
  assert.equal(projected.jobs[0].status,'saved');
  assert.equal(projected.jobs[0].titleZh,saved.titleZh);
  assert.equal(projected.jobs[0].readerId,saved.readerId);
  assert.equal(projected.jobs[0].updatedAt,saved.generatedAt);
  assert.equal(projected.jobs[0].reason,null);
  assert.ok(!JSON.stringify(projected).includes(marker));
});

test('saved drafts cannot override a different paper or changed provenance', () => {
  for (const changed of [
    {pmid:'40566035'},{doi:'10.9999/another-paper'},{originalTitle:'Another synthetic paper'},
    {status:'public'},{humanApprovalGranted:true},{humanApprovalGranted:undefined},{publicApprovalGranted:true},
    {readerId:'../another-reader'},{titleZh:'English title only'},{materialScope:'abstract'},{generatedAt:'invalid'},
  ]) {
    const projected = projectReadingJobs(queue,[{...saved,...changed}]);
    assert.equal(projected.jobs[0].status,'ready');
    assert.equal(projected.jobs[0].titleZh,null);
    assert.equal(projected.jobs[0].readerId,job.readerId);
  }
});

test('internal reason codes have fixed Chinese copy and cannot contain raw errors', () => {
  for (const reason of ['source_unavailable','license_unavailable','identity_conflict','materials_incomplete','execution_uncertain','preparation_failed']) {
    const projected = projectReadingJobs({...queue,jobs:[{...job,status:'blocked',reason}]});
    assert.match(projected.jobs[0].reason!,/[\u3400-\u9fff]/);
    assert.doesNotMatch(projected.jobs[0].reason!,/hash|token|credentials|\.data|\.json|C:|E:/i);
  }
  assert.throws(()=>parseReadingQueue({...queue,jobs:[{...job,reason:'HTTP failed: E:/private/approval.json secret-token'}]}));
});

test('unsafe or non-job paths are rejected and safe relative nested directories are accepted', () => {
  for (const directory of [
    '../outside','.data/ep-chinese-reading/../outside','.data/ep-chinese-reading/a/../../outside',
    'E:/EPVOICE/.data/ep-chinese-reading/a','/tmp/a','\\\\server\\share\\a','.data\\ep-chinese-reading\\a',
    '.data/ep-chinese-reading/work','.data/ep-chinese-reading/guard','.data/ep-chinese-reading/a/work/b',
    '.data/ep-chinese-reading/a/guard/b','.data/ep-chinese-reading/a//b','.data/ep-chinese-reading/a%2fb',
    '.data/ep-chinese-reading/a.b','.data/ep-chinese-reading/','.data/ep-chinese-reading/A',
  ]) assert.throws(()=>parseReadingQueue({...queue,jobs:[{...job,directory}]}));
  assert.equal(parseReadingQueue({...queue,jobs:[{...job,directory:'.data/ep-chinese-reading/pmid-39820338/v2'}]}).jobs[0].directory,
    '.data/ep-chinese-reading/pmid-39820338/v2');
});

test('malformed fields, source identities, extensions and duplicate jobs are rejected', () => {
  for (const changed of [
    {pmid:39820338},{pmid:'039820338'},{doi:null},{doi:'https://doi.org/10.1093/europace/euaf007'},
    {doi:'10.1093/Europace/euaf007'},{recordId:39820338},{readerId:'a/b'},{recordId:'a?b'},
    {originalTitle:' '},{titleZh:42},{status:'authorized'},{updatedAt:'2026-02-30T00:00:00.000Z'},
    {automaticRetries:1},{authorizedMicros:500000},{requestHash:'0'.repeat(64)},{reason:'other'},
  ]) assert.throws(()=>parseReadingQueue({...queue,jobs:[{...job,...changed}]}));
  assert.throws(()=>parseReadingQueue({...queue,authorizationKey:'not-display-state'}));
  assert.throws(()=>parseReadingQueue({version:'ep-reading-queue-v2',jobs:[]}));
  assert.throws(()=>parseReadingQueue({...queue,jobs:[job,job]}));
  assert.throws(()=>parseReadingQueue({...queue,jobs:Array(101).fill(job)}));
});

test('file reader treats a missing queue as empty, reads without changing it and rejects malformed content', async context => {
  const root = await mkdtemp(path.join(tmpdir(),'ep-reading-jobs-'));
  context.after(async()=>{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));
    await rm(root,{recursive:true,force:true});
  });
  assert.deepEqual(await readReadingJobs(root,[saved]),{private:true,jobs:[]});
  const directory = path.join(root,'.data','ep-chinese-reading'), file = path.join(directory,'queue.json');
  await mkdir(directory,{recursive:true});
  const body = JSON.stringify(queue);
  await writeFile(file,body,'utf8');
  assert.deepEqual(await readReadingJobs(root,[saved]),projectReadingJobs(queue,[saved]));
  assert.equal(await readFile(file,'utf8'),body);
  await writeFile(file,'{"version":"ep-reading-queue-v1","jobs":[],"authorization":true}','utf8');
  await assert.rejects(readReadingJobs(root,[saved]));
  await writeFile(file,'invalid JSON','utf8');
  await assert.rejects(readReadingJobs(root,[saved]));
});
