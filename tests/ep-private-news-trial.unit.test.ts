import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEWS_SOURCES, PRIVATE_NEWS_PROMPT, newsDisplay, productFromTitle } from '../packages/backend/src/research/private-news.ts';
import { validateNewsTrial, canClaimTrialBatch, assertTrialReservation, trialStopReason, trialHash, parseTrialPrice, beijingDay } from '../packages/backend/src/research/private-news-trial.ts';
import type { NewsTrial, TrialLedger, TrialRequest } from '../packages/backend/src/research/private-news-trial.ts';
const start = Date.parse('2026-10-02T01:00:00Z');
const trial: NewsTrial = { version: 'ep-private-news-seven-days-v1', startedAt: new Date(start).toISOString(), endsAt: new Date(start + 7 * 86400000).toISOString(),
  timezone: 'Asia/Shanghai', databaseUrl: 'postgres://127.0.0.1:55433/epvoice_private_news_20261002', modelKey: 'deepseek-flash', modelName: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com', credentialHash: 'a'.repeat(64), sourceIds: NEWS_SOURCES.map(source => source.id), promptVersion: PRIVATE_NEWS_PROMPT,
  maxRequests: 35, dailyRequests: 5, maxBatches: 7, dailyBatches: 1, maxMicros: 5000000, automaticRetries: 0, automaticModelChanges: 0,
  humanRequest: 'Synthetic explicit seven day authorization with no retry and no renewal', frozenFiles: [{ file: 'synthetic-owned-file', hash: 'b'.repeat(64) }] };
const makeLedger = (): TrialLedger => ({ startedAt: trial.startedAt, endsAt: trial.endsAt, manifestHash: trialHash(trial), status: 'active', stopReason: null, stoppedAt: null,
  baselineArticleIds: [], baselineReceiptIds: [], batches: [{ window: 0, day: beijingDay(start), startedAt: trial.startedAt, finishedAt: null,
    directory: 'synthetic', status: 'running', sources: [], created: 0, duplicates: 0, revised: 0, pending: 0, error: null }], requests: [], interventions: [] });
const price = { currency: 'CNY' as const, modelName: 'deepseek-flash' as const, basisUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  verifiedAt: trial.startedAt, validUntil: new Date(start + 3600000).toISOString(), bodyHash: 'c'.repeat(64), inputMicrosPerMillion: 2000000, outputMicrosPerMillion: 8000000 };
const request = (n: number): TrialRequest => ({ key: 'owned-' + n, articleId: 'owned-' + n, revision: 1, requestHash: 'd'.repeat(64), day: beijingDay(start), window: 0,
  reservedAt: trial.startedAt, sentAt: null, upperMicros: 10000, inputTokenUpperBound: 2000, price, status: 'reserved', receiptId: null, estimateMicros: null, error: null });
test('only the explicitly bound private non-test database and immutable seven day scope are accepted', () => {
  validateNewsTrial(trial, trial.databaseUrl, false);
  for (const databaseUrl of ['postgres://127.0.0.1/epvoice_private_news_20261002_test', 'postgres://remote/epvoice_private_news_20261002', trial.databaseUrl + '?schema=other']) assert.throws(() => validateNewsTrial({ ...trial, databaseUrl }, databaseUrl, false));
  assert.throws(() => validateNewsTrial(trial, trial.databaseUrl, true));
  assert.throws(() => validateNewsTrial({ ...trial, maxMicros: 5000001 } as never, trial.databaseUrl, false));
  assert.throws(() => validateNewsTrial({ ...trial, endsAt: new Date(start + 8 * 86400000).toISOString() }, trial.databaseUrl, false));
  assert.throws(() => validateNewsTrial({ ...trial, sourceIds: [...trial.sourceIds, 'example-ai'] }, trial.databaseUrl, false));
});
test('restart retains one batch per trial day and Beijing date, without missed-day catchup', () => {
  const saved = JSON.parse(JSON.stringify(makeLedger()));
  assert.equal(canClaimTrialBatch(trial, saved, start + 1000), false);
  assert.equal(canClaimTrialBatch(trial, saved, start + 16 * 3600000), false);
  assert.equal(canClaimTrialBatch(trial, saved, start + 86400000), true);
  assert.equal(canClaimTrialBatch(trial, saved, start + 7 * 86400000), false);
});
test('failed, unknown and unsent reservations retain daily count, money and logical-key exclusion', () => {
  const ledger = makeLedger();
  for (let n = 0; n < 5; n++) { const next = request(n); assertTrialReservation(trial, ledger, next, start + 1000); ledger.requests.push(next); }
  ledger.requests[0]!.status = 'unknown'; ledger.requests[1]!.status = 'failed'; ledger.requests[2]!.status = 'not_sent';
  const restarted = JSON.parse(JSON.stringify(ledger));
  assert.throws(() => assertTrialReservation(trial, restarted, request(5), start + 2000));
  assert.throws(() => assertTrialReservation(trial, restarted, request(0), start + 2000));
  assert.equal(restarted.requests.reduce((sum: number, saved: TrialRequest) => sum + saved.upperMicros, 0), 50000);
});
test('time, total count and conservative monetary ceiling each stop the trial', () => {
  const ledger = makeLedger();
  assert.equal(trialStopReason(trial, ledger, start + 7 * 86400000), 'seven_days_ended');
  ledger.requests = Array.from({ length: 35 }, (_, n) => request(n));
  assert.equal(trialStopReason(trial, ledger, start), 'request_limit');
  ledger.requests = [ { ...request(0), upperMicros: 4995000 } ];
  assert.throws(() => assertTrialReservation(trial, ledger, request(1), start));
  ledger.requests[0]!.upperMicros = 5000000;
  assert.equal(trialStopReason(trial, ledger, start), 'monetary_limit');
});
test('official peak pricing is scoped to the named column and cannot fall back after layout or currency changes', () => {
  const html = '<table><tr><td>模型</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro</td></tr>'
    + '<tr><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr><tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>'
    + '<tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr><tr><td>高峰时段</td><td>2元</td><td>9元</td></tr>'
    + '<tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr><tr><td>高峰时段</td><td>8元</td><td>27元</td></tr></table>';
  const parsed = parseTrialPrice(html, start);
  assert.equal(parsed.inputMicrosPerMillion, 2000000); assert.equal(parsed.outputMicrosPerMillion, 8000000);
  assert.throws(() => parseTrialPrice(html.replace('deepseek-flash', 'unknown-model'), start));
  assert.throws(() => parseTrialPrice(html.replace('<td>2元</td>', '<td>$2</td>'), start));
  assert.throws(() => parseTrialPrice('<html>upstream error</html>', start));
});
test('the reviewed disease-background error cannot enter a new title-only draft', () => {
  const title = 'Pulsed Field Ablation in Cor Triatriatum Sinister.', url = 'https://www.jnj.com/owned-synthetic';
  const material = { version: 'ep-private-news-v1' as const, kind: 'official' as const, scope: 'title' as const, sourceId: NEWS_SOURCES[1]!.id,
    sourceName: NEWS_SOURCES[1]!.name, title, url, acquiredAt: trial.startedAt, metadata: null, recordId: null, relatedResearch: null, product: productFromTitle(title, url) };
  assert.throws(() => newsDisplay({ titleZh: '脉冲场消融', leadZh: '讨论这一罕见先天性心脏异常。', basisQuote: title }, material, trial.startedAt));
});
