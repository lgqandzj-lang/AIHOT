// Seven-day authorization and accounting only. No worker, queue, schema or UI.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sql, Tx } from '../db.ts';
import { sha256, stableJson } from '../lib/ids.ts';
import { stripTags } from '../lib/text.ts';
import { NEWS_SOURCES, PRIVATE_NEWS_PROMPT, newsCostCeiling } from './private-news.ts';
import type { SourceDiscovery } from './private-news-store.ts';

export const TRIAL_KEY = 'ep.private_news.trial.20261002';
const DAY = 86400000;
export interface NewsTrial {
  version: 'ep-private-news-seven-days-v1'; startedAt: string; endsAt: string; timezone: 'Asia/Shanghai';
  databaseUrl: string; modelKey: 'deepseek-flash'; modelName: 'deepseek-flash'; baseUrl: 'https://api.deepseek.com';
  credentialHash: string; sourceIds: string[]; promptVersion: string;
  maxRequests: 35; dailyRequests: 5; maxBatches: 7; dailyBatches: 1; maxMicros: 5000000;
  automaticRetries: 0; automaticModelChanges: 0; humanRequest: string;
  frozenFiles: { file: string; hash: string }[];
}
export interface TrialPrice {
  currency: 'CNY'; modelName: 'deepseek-flash'; basisUrl: string; verifiedAt: string; validUntil: string; bodyHash: string;
  inputMicrosPerMillion: number; outputMicrosPerMillion: number;
}
export interface TrialRequest {
  key: string; articleId: string; revision: number; requestHash: string; day: string; window: number;
  reservedAt: string; sentAt: string | null; upperMicros: number; inputTokenUpperBound: number;
  price: TrialPrice; status: 'reserved' | 'sending' | 'completed' | 'failed' | 'unknown' | 'not_sent';
  receiptId: number | null; estimateMicros: number | null; error: string | null;
}
export interface TrialBatch {
  window: number; day: string; startedAt: string; finishedAt: string | null; directory: string;
  status: 'running' | 'ok' | 'source_error' | 'stopped'; sources: Omit<SourceDiscovery, 'candidates'>[];
  created: number; duplicates: number; revised: number; pending: number; error: string | null;
}
export interface TrialLedger {
  startedAt: string; endsAt: string;
  manifestHash: string; status: 'active' | 'stopped'; stopReason: string | null; stoppedAt: string | null;
  baselineArticleIds: string[]; baselineReceiptIds: number[]; batches: TrialBatch[]; requests: TrialRequest[];
  interventions: { at: string; actor: 'assistant' | 'human'; reason: string; minutes: number | null }[];
}
export const beijingDay = (now: number) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export const trialHash = (trial: NewsTrial) => sha256(stableJson(trial));

export function validateNewsTrial(trial: NewsTrial, databaseUrl: string | undefined, production = process.env.NODE_ENV === 'production') {
  const url = new URL(trial?.databaseUrl ?? 'https://invalid');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (production || !databaseUrl || databaseUrl !== trial.databaseUrl || trial.version !== 'ep-private-news-seven-days-v1'
    || !['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.search || url.hash || !/^epvoice_private_news_[0-9]{8}$/.test(name) || /_(test|ci)$/.test(name)
    || !Number.isFinite(Date.parse(trial.startedAt)) || Date.parse(trial.endsAt) - Date.parse(trial.startedAt) !== 7 * DAY
    || trial.timezone !== 'Asia/Shanghai' || trial.maxRequests !== 35 || trial.dailyRequests !== 5
    || trial.maxBatches !== 7 || trial.dailyBatches !== 1 || trial.maxMicros !== 5000000
    || trial.automaticRetries !== 0 || trial.automaticModelChanges !== 0 || trial.modelKey !== 'deepseek-flash'
    || trial.modelName !== 'deepseek-flash' || trial.baseUrl !== 'https://api.deepseek.com' || !/^[a-f0-9]{64}$/.test(trial.credentialHash)
    || trial.promptVersion !== PRIVATE_NEWS_PROMPT || stableJson(trial.sourceIds) !== stableJson(NEWS_SOURCES.map(source => source.id))
    || typeof trial.humanRequest !== 'string' || trial.humanRequest.length < 30 || !trial.frozenFiles?.length) throw new Error('Invalid private seven-day authorization or database binding');
}
export async function loadNewsTrial(root: string, file: string, databaseUrl = process.env.DATABASE_URL) {
  const absolute = path.resolve(root, file), relative = path.relative(path.join(root, '.data'), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(absolute) !== '.json') throw new Error('Trial manifest must stay in ignored .data');
  const trial = JSON.parse((await readFile(absolute, 'utf8')).replace(/^\uFEFF/, '')) as NewsTrial;
  validateNewsTrial(trial, databaseUrl);
  return { trial, file: absolute, directory: path.dirname(absolute) };
}
export async function assertTrialFiles(trial: NewsTrial, root: string) {
  for (const entry of trial.frozenFiles) {
    const absolute = path.resolve(root, entry.file), relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || sha256(await readFile(absolute)) !== entry.hash) throw new Error('Frozen trial input changed: ' + entry.file);
  }
}
export function trialStopReason(trial: NewsTrial, ledger: TrialLedger, now = Date.now()) {
  if (ledger.status === 'stopped') return ledger.stopReason ?? 'already_stopped';
  if (now >= Date.parse(trial.endsAt)) return 'seven_days_ended';
  if (ledger.requests.length >= trial.maxRequests) return 'request_limit';
  if (ledger.requests.reduce((sum, request) => sum + request.upperMicros, 0) >= trial.maxMicros) return 'monetary_limit';
  return null;
}
export function trialWindow(trial: NewsTrial, now = Date.now()) {
  const window = Math.floor((now - Date.parse(trial.startedAt)) / DAY);
  if (window < 0 || window >= trial.maxBatches) throw new Error('Outside authorized trial time');
  return { window, day: beijingDay(now) };
}
export function canClaimTrialBatch(trial: NewsTrial, ledger: TrialLedger, now = Date.now()) {
  if (trialStopReason(trial, ledger, now)) return false;
  const current = trialWindow(trial, now);
  return !ledger.batches.some(batch => batch.window === current.window || batch.day === current.day);
}
export function assertTrialReservation(trial: NewsTrial, ledger: TrialLedger, request: TrialRequest, now = Date.now()) {
  const reason = trialStopReason(trial, ledger, now);
  if (reason) throw new Error('Trial stopped: ' + reason);
  const current = trialWindow(trial, now);
  if (request.window !== current.window || request.day !== current.day || !ledger.batches.some(batch => batch.window === current.window && batch.status === 'running')
    || ledger.requests.some(saved => saved.key === request.key)
    || ledger.requests.filter(saved => saved.day === current.day || saved.window === current.window).length >= trial.dailyRequests
    || !Number.isSafeInteger(request.upperMicros) || request.upperMicros <= 0
    || ledger.requests.reduce((sum, saved) => sum + saved.upperMicros, 0) + request.upperMicros > trial.maxMicros) throw new Error('Trial request/day/money reservation rejected');
}
export async function readTrialLedger(db: Sql | Tx, trial: NewsTrial, lock = false): Promise<TrialLedger> {
  const rows = lock ? await db`SELECT value FROM settings WHERE key=${TRIAL_KEY} FOR UPDATE` : await db`SELECT value FROM settings WHERE key=${TRIAL_KEY}`;
  const ledger = rows[0]?.value as TrialLedger | undefined;
  if (!ledger || ledger.manifestHash !== trialHash(trial) || ledger.startedAt !== trial.startedAt || ledger.endsAt !== trial.endsAt
    || !Array.isArray(ledger.requests) || !Array.isArray(ledger.batches)) throw new Error('Persistent trial ledger absent or authorization changed; never reset automatically');
  return ledger;
}
export async function changeTrialLedger(db: Sql, trial: NewsTrial, update: (ledger: TrialLedger) => void) {
  return db.begin(async tx => {
    const ledger = await readTrialLedger(tx, trial, true); update(ledger);
    await tx`UPDATE settings SET value=${tx.json(ledger as never)},updated_at=now(),updated_by='ep_private_news_trial' WHERE key=${TRIAL_KEY}`;
    return ledger;
  }) as Promise<TrialLedger>;
}
export function stopTrial(ledger: TrialLedger, reason: string, now = Date.now()) {
  if (ledger.status === 'active') { ledger.status = 'stopped'; ledger.stopReason = reason; ledger.stoppedAt = new Date(now).toISOString(); }
}

/** Only the named model column and three explicit peak-price cells are accepted. Unknown layouts stop paid processing. */
export function parseTrialPrice(html: string, now = Date.now()): TrialPrice {
  const table = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw new Error('Official price table missing');
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => [...match[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => stripTags(cell[1]!).replace(/\s+/g, '')));
  if (rows[0]?.[1] !== 'deepseek-flash(1)' || rows[0]?.[2] !== 'deepseek-v4-pro') throw new Error('Official model pricing columns changed');
  let category = '', cached: number | null = null, input: number | null = null, output: number | null = null;
  for (const row of rows) {
    const label = row.find(cell => /^百万tokens(?:输入|输出)/.test(cell));
    if (label) category = label.includes('缓存未命中') ? 'input' : label.includes('缓存命中') ? 'cached' : label.includes('输出') ? 'output' : '';
    const peak = row.indexOf('高峰时段'); if (peak < 0) continue;
    const cell = row[peak + 1]; if (!cell || !/^\d+(?:\.\d+)?元$/.test(cell)) throw new Error('Official peak price is not an explicit CNY amount');
    const value = Math.round(Number(cell.slice(0, -1)) * 1000000);
    if (category === 'input' && input === null) input = value;
    else if (category === 'cached' && cached === null) cached = value;
    else if (category === 'output' && output === null) output = value;
    else throw new Error('Ambiguous official peak price');
  }
  if (cached === null || input === null || output === null || input < cached || ![input, output].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Cannot reliably bound the official model fee');
  return { currency: 'CNY', modelName: 'deepseek-flash', basisUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    verifiedAt: new Date(now).toISOString(), validUntil: new Date(now + 3600000).toISOString(), bodyHash: sha256(html), inputMicrosPerMillion: input, outputMicrosPerMillion: output };
}
export async function fetchTrialPrice() {
  const response = await fetch('https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', { signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new Error('Official pricing HTTP ' + response.status);
  const html = await response.text(); if (Buffer.byteLength(html) > 500000) throw new Error('Official pricing response too large');
  return parseTrialPrice(html);
}
export async function reconcileTrialRequests(db: Sql, trial: NewsTrial) {
  const ledger = await readTrialLedger(db, trial);
  const updates = new Map<string, Partial<TrialRequest>>();
  for (const request of ledger.requests.filter(request => !['completed', 'failed', 'not_sent'].includes(request.status))) {
    const [receipt] = await db`SELECT id,status,usage,response,error,attempts,retry_policy FROM receipts
      WHERE subject=${request.articleId} AND purpose='ep_private_news' AND request->>'bodyHash'=${request.requestHash}
      AND created_at>=${trial.startedAt} ORDER BY id DESC LIMIT 1`;
    const usage = receipt?.usage;
    const known = receipt && receipt.attempts === 1 && receipt.retry_policy === 'never' && receipt.response?.model === trial.modelName
      && Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && usage.prompt_tokens <= request.inputTokenUpperBound
      && Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0 && usage.completion_tokens <= 512;
    updates.set(request.key, { receiptId: receipt?.id ?? null,
      status: !request.sentAt ? 'not_sent' : receipt?.status === 'completed' ? 'completed' : receipt?.status === 'failed' ? 'failed' : 'unknown',
      estimateMicros: known ? newsCostCeiling(Math.max(1, usage.prompt_tokens), Math.max(1, usage.completion_tokens), request.price.inputMicrosPerMillion, request.price.outputMicrosPerMillion) : null,
      error: receipt?.error ?? (request.sentAt ? 'No completed result; original monetary reservation retained, retry forbidden' : 'Reservation has no send marker; capacity retained') });
  }
  return changeTrialLedger(db, trial, saved => {
    for (const request of saved.requests) Object.assign(request, updates.get(request.key) ?? {});
  });
}

export async function writeTrialReport(db: Sql, trial: NewsTrial, directory: string) {
  const ledger = await readTrialLedger(db, trial);
  const { readPrivateNews } = await import('./private-news-store.ts');
  const feed = await readPrivateNews(db), newItems = feed.items.filter(item => !ledger.baselineArticleIds.includes(item.id));
  const sent = ledger.requests.filter(request => request.sentAt), known = sent.filter(request => request.estimateMicros !== null);
  const estimate = known.reduce((sum, request) => sum + request.estimateMicros!, 0), bound = ledger.requests.reduce((sum, request) => sum + request.upperMicros, 0);
  const rows = Array.from({ length: 7 }, (_, window) => {
    const batch = ledger.batches.find(batch => batch.window === window);
    return batch ? `| ${window + 1} / ${batch.day} | ${batch.status === 'running' ? '运行中或中断' : batch.status === 'source_error' ? '来源异常' : batch.status === 'stopped' ? '停止' : batch.created ? '正常有新增' : '正常无相关新增'} | ${batch.sources.map(source => `${source.sourceId.includes('pubmed') ? 'PubMed' : '官方 RSS'}：${source.outcome}，返回 ${source.returnedCount ?? '未知'} / 匹配 ${source.found}`).join('；')} | ${batch.created}/${batch.duplicates}/${batch.revised} | ${sent.filter(request => request.window === window).length} |`
      : `| ${window + 1} | 未运行 | — | — | 0 |`;
  });
  const money = (micros: number) => (micros / 1000000).toFixed(6);
  const lines = [ '# 7 天私有资讯试运行报告', '', `状态：${ledger.status === 'active' ? '试运行中（阶段记录）' : '已停止'}；起止：${trial.startedAt} → ${trial.endsAt}（UTC，北京时间加 8 小时）。`,
    `实际启动 ${ledger.batches.length} 个日批次；完成 ${ledger.batches.filter(batch => batch.finishedAt).length} 天；未运行 ${7 - ledger.batches.length} 天。停止原因：${ledger.stopReason ?? '尚未到期'}。`, '',
    '| 天 / 北京日期 | 运行结果 | 来源 | 新增/重复/修订 | 实际或可能已发送请求 |', '|---|---|---|---|---|', ...rows, '',
    `内容：试运行前历史补录 ${ledger.baselineArticleIds.length} 条；本轮新增 ${newItems.length} 条（历史 ${newItems.filter(item => item.historical).length}，按原发表日期列为近期 ${newItems.filter(item => !item.historical).length}）。`,
    ...newItems.map(item => `- ${item.titleZh ?? item.originalTitle}；原发表 ${item.publishedAt ?? '未知'}；${item.historical ? '历史补录' : '近期'}；产品${item.product.status === 'confirmed' ? '原题明确关联' : '候选关联'}；${item.source.url}`), '',
    `请求：${sent.length}/35；成功 ${sent.filter(request => request.status === 'completed').length}；失败 ${sent.filter(request => request.status === 'failed').length}；结果不明 ${sent.filter(request => request.status === 'unknown' || request.status === 'sending').length}；保守占位 ${ledger.requests.length}；自动模型重试 0，自动换模型 0。试运行前回执 ${ledger.baselineReceiptIds.length} 条不计入本轮。`,
    `费用：已知用量按官方高峰未命中单价估算 ${money(estimate)} CNY（${known.length} 次）；含未知结果、失败和未发送占位的累计保守上界 ${money(bound)} / 5 CNY。供应商实际扣费：未提供账单，不能把估算写作实扣。`, '',
    `明确错误与介入：${ledger.interventions.map(event => `${event.actor === 'assistant' ? 'Agent' : '人工'}：${event.reason}；人工分钟${event.minutes === null ? '未测量' : event.minutes}`).join('；') || '本轮未记录额外介入'}。日批次异常：${ledger.batches.filter(batch => batch.error).map(batch => batch.error).join('；') || '无'}。`,
    '人工耗时：未采集真实人工计时；不能用 Agent 执行耗时代替。当前没有逐篇批准步骤。',
    `来源异常：${ledger.batches.flatMap(batch => batch.sources.filter(source => source.status === 'unavailable').map(source => source.sourceId + '：' + source.error)).join('；') || '已运行批次未出现'}。遗漏口径：只检索现有 PubMed 查询最近 30 天前 20 个结果、每来源最多 5 条；这是有界试验，不能声称覆盖全部文献或证明没有其他遗漏。`,
    '两来源、题名范围、私有资讯页；未购买全文。到期或触及次数/金额限制停止，无续期。', '' ];
  await writeFile(path.join(directory, '7天私有试运行报告.md'), lines.join('\n'), 'utf8');
  await writeFile(path.join(directory, 'latest-ledger.json'), JSON.stringify({ trial, ledger }, null, 2), 'utf8');
  return { status: ledger.status, startedAt: trial.startedAt, endsAt: trial.endsAt, actualDays: ledger.batches.length,
    requests: sent.length, capacityReservations: ledger.requests.length, estimatedMicros: estimate, reservedUpperMicros: bound, actualDeduction: null, stopReason: ledger.stopReason };
}
