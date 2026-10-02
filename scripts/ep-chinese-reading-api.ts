// Existing private research/news adapter remains running and unchanged. This reads saved prose only.
import { createServer } from 'node:http';
if (process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED !== 'true' || process.env.MODEL_CALLS_ENABLED !== 'false') throw new Error('Explicit private read-only flags required');
const database = new URL(process.env.DATABASE_URL || '');
if (database.hostname !== '127.0.0.1' || database.pathname !== '/epvoice_content_20261002') throw new Error('Use the separate private content database');
process.env.COLLECT_ENABLED = 'false'; process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
const { sql, closeDb } = await import('../packages/backend/src/db.ts');
const { researchDatabase } = await import('../packages/backend/src/research/postgres.ts');
const { readChineseReadings, readChineseReadingPapers } = await import('../packages/backend/src/research/chinese-reading.ts');
const { readReadingJobs } = await import('../packages/backend/src/research/reading-jobs.ts');
const db = researchDatabase(sql), loopback = new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const server = createServer(async (request,response) => {
  response.setHeader('Cache-Control','private, no-store'); response.setHeader('X-Robots-Tag','noindex');
  try {
    const target = new URL('http://'+request.headers.host);
    if (!loopback.has(request.socket.remoteAddress || '') || !['127.0.0.1','localhost','[::1]'].includes(target.hostname)
      || Object.keys(request.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-'))
      || request.headers.origin && new URL(request.headers.origin).origin !== target.origin) { response.writeHead(403); response.end(); return; }
    if (!['GET','HEAD'].includes(request.method || '')) { response.writeHead(405); response.end(); return; }
    const endpoint = new URL(request.url || '/',target);
    if (!['/api/research-preview/chinese-readings','/api/research-preview/reading-jobs'].includes(endpoint.pathname) || endpoint.search) { response.writeHead(404); response.end(); return; }
    if (endpoint.pathname === '/api/research-preview/reading-jobs') {
      const jobs = await readReadingJobs(process.cwd(),await readChineseReadings(db));
      response.writeHead(200,{'Content-Type':'application/json'}); response.end(request.method === 'HEAD' ? undefined : JSON.stringify(jobs)); return;
    }
    const [readings,papers] = await Promise.all([readChineseReadings(db),readChineseReadingPapers(db)]);
    response.writeHead(200,{'Content-Type':'application/json'});
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ private:true,readings,papers }));
  } catch { response.writeHead(503,{'Content-Type':'application/json'}); response.end('{"private":true,"readings":[],"unavailable":true}'); }
});
server.listen(3202,'127.0.0.1',()=>console.log('Saved Chinese research prose: 127.0.0.1:3202; no model execution on reads'));
process.once('SIGTERM',()=>server.close(async()=>{await closeDb();process.exit(0);}));
