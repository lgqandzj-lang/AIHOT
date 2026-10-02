// A local read-only adapter for the existing frontend. It never starts a worker or sends a model request.
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { localExtractionDatabase } from './ep-pr2b-extract-one.ts';

const {values} = parseArgs({strict:true,options:{'base-experience':{type:'string'},'content-supplement':{type:'string'},trial:{type:'string'}}});
if (!values['base-experience'] || process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED!=='true'
  || process.env.EP_RESEARCH_PREVIEW_ENABLED!=='true') throw new Error('Explicit private local flags and prior bibliography are required');
if (values.trial) {
  const {loadNewsTrial}=await import('../packages/backend/src/research/private-news-trial.ts');
  await loadNewsTrial(process.cwd(),values.trial);
} else localExtractionDatabase(process.env.DATABASE_URL);
process.env.MODEL_CALLS_ENABLED='false';process.env.COLLECT_ENABLED='false';process.env.INDEXNOW_SUBMIT_ENABLED='false';
for (const flag of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(flag)) process.env[flag]='false';
const {sql,closeDb} = await import('../packages/backend/src/db.ts');
const {researchDatabase} = await import('../packages/backend/src/research/postgres.ts');
const {readPrivateReadingPapers,readPrivateReadingDiagnostic} = await import('../packages/backend/src/research/private-reading.ts');
const {privateProductEntry} = await import('../packages/backend/src/research/private-product.ts');
const {parsePrivateProductContent,applyPrivateProductContent} = await import('../packages/backend/src/research/private-product-content.ts');
const {readPrivateNews} = await import('../packages/backend/src/research/private-news-store.ts');
const original = JSON.parse((await readFile(values['base-experience'],'utf8')).replace(/^\uFEFF/,''));
const contents = values['content-supplement'] ? parsePrivateProductContent(JSON.parse((await readFile(values['content-supplement'],'utf8')).replace(/^\uFEFF/,''))) : [];
const db = researchDatabase(sql);
const loopback = new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
// Use the same live-session check as the existing login service, not this trial database's users.
const confirmedAdminSession=(cookie:string|undefined)=>new Promise<boolean>((resolve,reject)=>{
  const check=request({host:'127.0.0.1',port:3001,path:'/api/auth/check',method:'GET',headers:{cookie:cookie??''}},response=>{
    response.resume();response.on('end',()=>resolve(response.statusCode===204));
  });
  check.setTimeout(5000,()=>check.destroy(new Error('Admin session check timed out')));
  check.on('error',reject);check.end();
});
const server = createServer(async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Robots-Tag','noindex');
  try {
    const target = new URL('http://'+req.headers.host);
    const privatePath = req.url?.startsWith('/api/research-preview');
    const forwarded = req.headers['x-forwarded-for'];
    const forwardedNames = Object.keys(req.headers).filter(name=>name==='forwarded'||name.startsWith('x-forwarded-'));
    const publicLoopbackProxy = !privatePath && typeof forwarded==='string' && loopback.has(forwarded)
      && forwardedNames.length===1 && forwardedNames[0]==='x-forwarded-for';
    if (!req.socket.remoteAddress || !loopback.has(req.socket.remoteAddress)
      || !['127.0.0.1','localhost','[::1]'].includes(target.hostname) || target.username || target.password
      || req.headers.origin && new URL(req.headers.origin).origin!==target.origin
      || forwardedNames.length && !publicLoopbackProxy) {
      res.writeHead(403);return res.end();
    }
    if (!['GET','HEAD'].includes(req.method||'')) {res.writeHead(405);return res.end();}
    const pathname = new URL(req.url||'/',target).pathname;
    if(pathname.startsWith('/api/research-preview/admin/diagnostics/')){
      if(!await confirmedAdminSession(req.headers.cookie)){res.writeHead(401,{'Content-Type':'application/json'});return res.end('{"detail":"Sign in to the admin first."}');}
      const diagnostic=await readPrivateReadingDiagnostic(db,pathname.slice('/api/research-preview/admin/diagnostics/'.length));
      res.writeHead(diagnostic?200:404,{'Content-Type':'application/json'});
      return res.end(req.method==='HEAD'?undefined:JSON.stringify(diagnostic??{}));
    }
    if (pathname==='/api/research-preview/experience') {
      const papers = await readPrivateReadingPapers(db);
      const identities = new Set(papers.map(paper=>paper.doi?'doi:'+paper.doi:'pmid:'+paper.pmid));
      const bibliography = original.papers.filter((paper:{doi?:string;pmid?:string;title:string})=>
        !/(?:TEST COPY|SYNTHETIC|DELETED[- ]EVIDENCE)/i.test(paper.title)
        && !identities.has(paper.doi?'doi:'+paper.doi:'pmid:'+paper.pmid));
      res.writeHead(200,{'Content-Type':'application/json'});
      const entries = [...papers,...bibliography.map((paper:Parameters<typeof privateProductEntry>[0] & {doi:string|null;pmid:string|null})=>({...paper,privateResearch:privateProductEntry(paper)}))];
      const news = await readPrivateNews().catch(()=>null);
      const newsReaderIds = new Set((news?.items??[]).map(item=>item.researchUrl?.split('/').at(-1)));
      const visibleEntries = entries.map(paper=>{
        const projected = applyPrivateProductContent(paper,contents);
        if (newsReaderIds.has(projected.id) && projected.privateDraft?.state==='index_only') {
          // A discovered title has no abstract extraction or AI review to display.
          const {privateDraft:_draft,...bibliographyOnly} = projected;
          return {...bibliographyOnly,sources:projected.sources.map((source:{name:string;url:string;acquiredAt:string})=>({...source,
            name:source.name==='PubMed · 摘要来源'?'PubMed · 书目信息':source.name}))};
        }
        return projected;
      });
      return res.end(req.method==='HEAD'?undefined:JSON.stringify({preview:true,papers:visibleEntries,example:original.example,...(news?{news}:{newsUnavailable:true})}));
    }
    if (privatePath || pathname.includes('.data') || pathname.includes('private-card')) {res.writeHead(404);return res.end();}
    const upstream = request({host:'127.0.0.1',port:3001,path:req.url,method:req.method,headers:{accept:'application/json'}},up=>{res.writeHead(up.statusCode||503,up.headers);up.pipe(res);});
    upstream.on('error',()=>{res.writeHead(503,{'Content-Type':'application/json'});res.end('{"ok":false}');});upstream.end();
  } catch {res.writeHead(503,{'Content-Type':'application/json'});res.end('{"ok":false}');}
});
server.listen(3201,'127.0.0.1',()=>console.log('Persisted private research adapter: 127.0.0.1:3201; model/collection valves closed'));
process.once('SIGTERM',()=>server.close(async()=>{await closeDb();process.exit(0);}));
