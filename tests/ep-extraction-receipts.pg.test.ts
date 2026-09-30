// All HTTP requests in this file go to the in-process loopback stub with a fake key.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import { stub } from './setup.ts';
import { assertEpTestDatabase } from './fixtures/ep-test-safety.ts';
assertEpTestDatabase(process.env.DATABASE_URL);
process.env.MODEL_CALLS_ENABLED = 'false'; process.env.COLLECT_ENABLED = 'false'; process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
const {sql,closeDb} = await import('../packages/backend/src/db.ts');
const {config} = await import('../packages/backend/src/config.ts');
const {chatJson,prepareChatJsonRequest,ModelOutputError} = await import('../packages/backend/src/providers/llm.ts');
const {ReceiptRetryForbiddenError,ReceiptUnknownError} = await import('../packages/backend/src/providers/receipts.ts');
const {autoReleaseUnknownReceipts,releaseReceipt} = await import('../packages/backend/src/admin/runs.ts');
let content = '{"ok":true}'; let delay = 0;
const provider = await stub(async (_hit,request) => {
  const body = JSON.parse(request.body); assert.equal(body.max_tokens,512); assert.equal(body.model,'synthetic-model');
  if (delay) await new Promise(resolve => setTimeout(resolve,delay));
  return {id:'synthetic-receipt',choices:[{message:{content}}],usage:{prompt_tokens:11,completion_tokens:7,total_tokens:18}};
});
process.env.LLM_MODEL = 'synthetic-model'; process.env.LLM_BASE_URL = provider.url + '/v1'; process.env.LLM_API_KEY = 'synthetic-not-a-secret';
delete process.env.LLM_EXTRA_JSON;
const run = 'ep-transport-' + randomUUID();
function opts(name: string) {
  return {model:'default',purpose:'ep_abstract_extraction',subject:run + ':' + name,promptVersion:'synthetic-v1',system:'Synthetic system',user:'Synthetic material ' + name,
    schema:z.object({ok:z.boolean()}).strict(),maxTokens:1,retryPolicy:'never' as const};
}
after(async () => {
  config.modelCallsEnabled = false;
  await provider.close();
  await sql`DELETE FROM receipts WHERE subject LIKE ${run + ':%'}`;
  await closeDb();
});
test('default valve stops requests; the exact final snapshot passes through chatJson and its receipt',async () => {
  config.modelCallsEnabled = false;
  await assert.rejects(chatJson(opts('valve')),/disabled/); assert.equal(provider.hits(),0);
  config.modelCallsEnabled = true; // loopback-only transport verification, no real provider.
  const request = opts('valid'); const snapshot = prepareChatJsonRequest(request);
  const result = await chatJson({...request,approvedRequest:{bodyHash:snapshot.bodyHash,baseUrl:provider.url + '/v1'}});
  assert.equal(provider.hits(),1); assert.deepEqual(result.data,{ok:true});
  const [receipt] = await sql<{retry_policy:string;request:{bodyHash:string};cost:number|null}[]>`SELECT retry_policy,request,cost FROM receipts WHERE id=${result.receiptId}`;
  assert.equal(receipt!.retry_policy,'never'); assert.equal(receipt!.request.bodyHash,snapshot.bodyHash);
  assert.equal(receipt!.cost,null,'existing receipt has no verified actual monetary cost');
});
test('changing final parameters after preflight is rejected before HTTP or receipt creation',async () => {
  const request = opts('changed'); const snapshot = prepareChatJsonRequest(request); const before = provider.hits();
  process.env.LLM_EXTRA_JSON = '{"max_tokens":4096}';
  try { await assert.rejects(chatJson({...request,approvedRequest:{bodyHash:snapshot.bodyHash,baseUrl:provider.url + '/v1'}}),/differs/); }
  finally { delete process.env.LLM_EXTRA_JSON; }
  assert.equal(provider.hits(),before);
  assert.equal((await sql<{n:number}[]>`SELECT count(*)::int AS n FROM receipts WHERE subject=${request.subject}`)[0]!.n,0);
});
test('unusable output keeps one attempt and forbids a second paid request',async () => {
  content = 'not JSON'; const before = provider.hits(); const request = opts('invalid');
  await assert.rejects(chatJson(request),ModelOutputError);
  await assert.rejects(chatJson(request),ReceiptRetryForbiddenError);
  assert.equal(provider.hits() - before,1);
  const [receipt] = await sql<{attempts:number;status:string}[]>`SELECT attempts,status FROM receipts WHERE subject=${request.subject}`;
  assert.deepEqual(receipt,{attempts:1,status:'failed'}); content = '{"ok":true}';
});
test('timeout remains unknown, cannot auto/manual-release to another send, and has one durable attempt',async () => {
  delay = 200; const before = provider.hits(); const request = {...opts('timeout'),timeoutMs:70};
  await assert.rejects(chatJson(request));
  const [receipt] = await sql<{id:number;status:string;attempts:number}[]>`SELECT id,status,attempts FROM receipts WHERE subject=${request.subject}`;
  assert.equal(receipt!.status,'unknown'); assert.equal(receipt!.attempts,1);
  await sql`UPDATE receipts SET updated_at=now() - interval '2 hours' WHERE id=${receipt!.id}`;
  await autoReleaseUnknownReceipts();
  assert.equal((await sql<{status:string}[]>`SELECT status FROM receipts WHERE id=${receipt!.id}`)[0]!.status,'unknown');
  await assert.rejects(releaseReceipt(receipt!.id,{billed:false,note:'Synthetic test only'},'fixture'),/单次试跑/);
  await assert.rejects(chatJson(request),ReceiptUnknownError);
  assert.equal(provider.hits() - before,1);
  delay = 0;
});
test('a one-request trial refuses redirects rather than sending a second POST',async () => {
  let hits = 0;
  const server = http.createServer((_request,response) => {
    hits++; response.writeHead(307,{location:'/v1/another-paid-endpoint'}); response.end();
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address() as {port:number};
  process.env.LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  try {
    await assert.rejects(chatJson(opts('no-redirect')));
    assert.equal(hits,1);
    const [row] = await sql<{status:string;attempts:number}[]>`SELECT status,attempts FROM receipts WHERE subject=${run + ':no-redirect'}`;
    assert.deepEqual(row,{status:'unknown',attempts:1});
  } finally {
    process.env.LLM_BASE_URL = provider.url + '/v1';
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
test('a never-retry upgrade commits durably and cannot be downgraded by a later caller',async () => {
  const request = opts('upgrade-policy'); const before = provider.hits(); content = 'not JSON';
  try {
    await assert.rejects(chatJson({...request,retryPolicy:'existing'}),ModelOutputError);
    await assert.rejects(chatJson(request),ReceiptRetryForbiddenError);
    const [row] = await sql<{retry_policy:string;attempts:number}[]>`SELECT retry_policy,attempts FROM receipts WHERE subject=${request.subject}`;
    assert.deepEqual(row,{retry_policy:'never',attempts:1});
    await assert.rejects(chatJson({...request,retryPolicy:'existing'}),ReceiptRetryForbiddenError);
    assert.equal(provider.hits() - before,1);
  } finally { content = '{"ok":true}'; }
});
