import { stub, tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import http from 'node:http';
import postgres from 'postgres';
import { z } from 'zod';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { config } from '../packages/backend/src/config.ts';
import { chatJson, prepareChatJsonRequest } from '../packages/backend/src/providers/llm.ts';
import { fetchRss } from '../packages/backend/src/sources/rss.ts';
import { TRIAL_KEY, trialHash, readTrialLedger, changeTrialLedger, canClaimTrialBatch, assertTrialReservation } from '../packages/backend/src/research/private-news-trial.ts';
import type { NewsTrial, TrialLedger, TrialRequest } from '../packages/backend/src/research/private-news-trial.ts';
import type { Sql } from '../packages/backend/src/db.ts';
const trial = { version: 'ep-private-news-seven-days-v1', startedAt: '2026-10-02T01:00:00.000Z', endsAt: '2026-10-09T01:00:00.000Z',
  databaseUrl: process.env.DATABASE_URL, timezone: 'Asia/Shanghai', modelKey: 'deepseek-flash', modelName: 'deepseek-flash', baseUrl: 'https://api.deepseek.com',
  credentialHash: 'a'.repeat(64), sourceIds: ['ep-private-pubmed-varipulse','ep-private-jnj-varipulse'], promptVersion: 'ep-private-news-title-v1',
  maxRequests: 35, dailyRequests: 5, maxBatches: 7, dailyBatches: 1, maxMicros: 5000000, automaticRetries: 0, automaticModelChanges: 0,
  humanRequest: 'Synthetic owned test authorization only', frozenFiles: [{ file: 'owned', hash: 'b'.repeat(64) }] } as NewsTrial;
const ledger: TrialLedger = { startedAt: trial.startedAt, endsAt: trial.endsAt, manifestHash: trialHash(trial), status: 'active', stopReason: null, stoppedAt: null, baselineArticleIds: [], baselineReceiptIds: [], interventions: [],
  batches: [{ window: 0, day: '2026-10-02', startedAt: trial.startedAt, finishedAt: null, directory: 'owned', status: 'running', sources: [], created: 0, duplicates: 0, revised: 0, pending: 0, error: null }], requests: [] };
after(async () => { config.modelCallsEnabled = false; await sql`DELETE FROM settings WHERE key=${TRIAL_KEY}`; await closeDb(); });
test('quota and failed/unknown reservations survive a separate PostgreSQL session', async () => {
  await sql`INSERT INTO settings(key,value) VALUES(${TRIAL_KEY},${sql.json(ledger as never)})`;
  const start = Date.parse(trial.startedAt);
  for (let n = 0; n < 5; n++) {
    const request = { key: 'owned-' + n, articleId: 'owned-' + n, revision: 1, requestHash: 'c'.repeat(64), day: '2026-10-02', window: 0,
      reservedAt: trial.startedAt, sentAt: n < 2 ? trial.startedAt : null, upperMicros: 10000, inputTokenUpperBound: 2000,
      price: { currency: 'CNY', modelName: 'deepseek-flash', basisUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', verifiedAt: trial.startedAt,
        validUntil: trial.endsAt, bodyHash: 'd'.repeat(64), inputMicrosPerMillion: 2000000, outputMicrosPerMillion: 8000000 },
      status: n === 0 ? 'unknown' : n === 1 ? 'failed' : 'not_sent', receiptId: null, estimateMicros: null, error: 'owned test' } as TrialRequest;
    await changeTrialLedger(sql, trial, saved => { assertTrialReservation(trial, saved, request, start); saved.requests.push(request); });
  }
  const restarted = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const saved = await readTrialLedger(restarted as unknown as Sql, trial);
    assert.equal(saved.requests.length, 5); assert.equal(saved.requests.reduce((sum, request) => sum + request.upperMicros, 0), 50000);
    assert.equal(canClaimTrialBatch(trial, saved, start + 1000), false);
    assert.throws(() => assertTrialReservation(trial, saved, { ...saved.requests[0]!, key: 'sixth' }, start + 1000));
  } finally { await restarted.end(); }
});
test('the existing service quota runs first, then the final guard blocks any actual model send', async () => {
  const [savedBudget] = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='deepseek'`;
  const provider = await stub(() => ({ model: 'deepseek-flash', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const oldBase = process.env.DEEPSEEK_BASE_URL, oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_BASE_URL = provider.url; process.env.DEEPSEEK_API_KEY = 'owned-test-key'; config.modelCallsEnabled = true;
  const subject = 'trial-final-send-' + tag(); let guardCalls = 0;
  const ask = () => chatJson({ model: 'deepseek-flash', purpose: 'owned_trial_test', subject, promptVersion: 'owned-v1', system: 'owned', user: subject,
    schema: z.object({ ok: z.boolean() }), retryPolicy: 'never', beforeSend: async () => { guardCalls++; throw new Error('Owned expired trial'); } });
  try {
    await sql`UPDATE budgets SET per_minute=0,per_hour=0,per_day=0 WHERE service='deepseek'`;
    await assert.rejects(ask, /stopped/); assert.equal(guardCalls, 0); assert.equal(provider.hits(), 0);
    await sql`UPDATE budgets SET per_minute=100,per_hour=100,per_day=100 WHERE service='deepseek'`;
    await assert.rejects(ask, /Owned expired trial/); assert.equal(guardCalls, 1); assert.equal(provider.hits(), 0);
    await assert.rejects(ask, /another request is forbidden/); assert.equal(guardCalls, 1); assert.equal(provider.hits(), 0);
    const [receipt] = await sql`SELECT status,attempts,retry_policy FROM receipts WHERE subject=${subject}`;
    assert.equal(receipt.status, 'unknown'); assert.equal(receipt.attempts, 1); assert.equal(receipt.retry_policy, 'never');
  } finally { await sql`UPDATE budgets SET per_minute=${savedBudget.per_minute},per_hour=${savedBudget.per_hour},per_day=${savedBudget.per_day} WHERE service='deepseek'`;
    config.modelCallsEnabled = false; if (oldBase === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = oldBase;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey; await provider.close(); }
});
test('strict official RSS reads distinguish a genuine empty feed from broken XML and unusable entries', async () => {
  const oldPrivate = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  let body = '<rss><channel><title>Owned empty feed</title></channel></rss>';
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const source = { id: 'owned-official', name: 'owned', kind: 'rss', config: { feedUrl: `http://127.0.0.1:${address.port}/owned` },
    tier: 'T1', participation_mode: 'isolated', first_party: true, interval_minutes: 1440, enabled: false, cursor: null, fail_count: 0 } as const;
  try {
    assert.equal((await fetchRss(source, { force: true, strict: true })).candidates.length, 0);
    body = '<rss><channel><item><title>Owned broken'; await assert.rejects(() => fetchRss(source, { force: true, strict: true }), /Invalid XML/);
    body = '<rss><channel><item><title>Owned missing link</title></item></channel></rss>'; await assert.rejects(() => fetchRss(source, { force: true, strict: true }), /no usable/);
  } finally { config.allowPrivateNetworkFetch = oldPrivate; await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('copied historical live receipts do not consume the new trial daily quota and cannot erase the reservation requirement', async () => {
  const [savedBudget] = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='deepseek'`;
  const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
  const oldBase = process.env.DEEPSEEK_BASE_URL, oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_BASE_URL = provider.url; process.env.DEEPSEEK_API_KEY = 'owned-test-key'; config.modelCallsEnabled = true;
  const subject = 'copied-trial-epoch-' + tag(), since = new Date().toISOString(), until = new Date(Date.parse(since) + 7 * 86400000).toISOString();
  let guardCalls = 0;
  const options = { model: 'deepseek-flash', purpose: 'ep_private_news', subject, promptVersion: 'owned-epoch', system: 'owned', user: subject,
    schema: z.object({ ok: z.boolean() }), retryPolicy: 'never' as const, beforeSend: async () => { guardCalls++; throw new Error('Owned final guard'); } };
  const prepared = prepareChatJsonRequest(options);
  try {
    await sql`UPDATE budgets SET per_minute=5,per_hour=5,per_day=5 WHERE service='deepseek'`;
    const scoped = { ...ledger, status: 'active', startedAt: since, endsAt: until, requests: [ { articleId: subject, requestHash: prepared.bodyHash, status: 'reserved', sentAt: null, window: 0 } ] };
    await sql`UPDATE settings SET value=${sql.json(scoped as never)} WHERE key=${TRIAL_KEY}`;
    await assert.rejects(() => chatJson(options), /Budget for deepseek exhausted/); assert.equal(guardCalls, 0); assert.equal(provider.hits(), 0);
    await assert.rejects(() => chatJson({ ...options, budgetSince: new Date(Date.parse(since) - 1000).toISOString() }), /no active persistent request reservation/);
    assert.equal(provider.hits(), 0);
    await assert.rejects(() => chatJson({ ...options, budgetSince: since }), /Owned final guard/);
    assert.equal(guardCalls, 1); assert.equal(provider.hits(), 0);
    const [receipt] = await sql`SELECT attempts,retry_policy FROM receipts WHERE subject=${subject}`;
    assert.equal(receipt.attempts, 1); assert.equal(receipt.retry_policy, 'never');
  } finally {
    await sql`UPDATE budgets SET per_minute=${savedBudget.per_minute},per_hour=${savedBudget.per_hour},per_day=${savedBudget.per_day} WHERE service='deepseek'`;
    config.modelCallsEnabled = false; if (oldBase === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = oldBase;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey; await provider.close();
  }
});
test('previous trial-day sends within the rolling 24 hours cannot consume the next authorization day', async () => {
  const [savedBudget] = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='deepseek'`;
  const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
  const oldBase = process.env.DEEPSEEK_BASE_URL, oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_BASE_URL = provider.url; process.env.DEEPSEEK_API_KEY = 'owned-test-key'; config.modelCallsEnabled = true;
  const subject = 'next-trial-day-' + tag(), start = Date.now() - 86400000, since = new Date(start).toISOString();
  const options = { model: 'deepseek-flash', purpose: 'ep_private_news', subject, promptVersion: 'owned-day-boundary', system: 'owned', user: subject,
    schema: z.object({ ok: z.boolean() }), retryPolicy: 'never' as const, beforeSend: async () => { throw new Error('Owned next-day final guard'); } };
  const prepared = prepareChatJsonRequest(options);
  try {
    await sql`UPDATE budgets SET per_minute=5,per_hour=5,per_day=5 WHERE service='deepseek'`;
    for (let n = 0; n < 5; n++) {
      const [receipt] = await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,request,attempts,retry_policy)
        VALUES(${subject + ':yesterday:' + n},'deepseek','deepseek-flash','owned_test',${subject},'failed','{}',1,'never') RETURNING id`;
      await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,started_at,origin)
        VALUES(${receipt.id},1,'deepseek','deepseek-flash','failed',${new Date(start + 7 * 60000)},'live')`;
    }
    const scoped = { ...ledger, status: 'active', startedAt: since, endsAt: new Date(start + 7 * 86400000).toISOString(),
      requests: [{ articleId: subject, requestHash: prepared.bodyHash, status: 'reserved', sentAt: null, window: 1 }] };
    await sql`UPDATE settings SET value=${sql.json(scoped as never)} WHERE key=${TRIAL_KEY}`;
    await assert.rejects(() => chatJson({ ...options, budgetSince: since }), /Owned next-day final guard/);
    assert.equal(provider.hits(), 0);
  } finally {
    await sql`UPDATE budgets SET per_minute=${savedBudget.per_minute},per_hour=${savedBudget.per_hour},per_day=${savedBudget.per_day} WHERE service='deepseek'`;
    config.modelCallsEnabled = false; if (oldBase === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = oldBase;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey; await provider.close();
  }
});
