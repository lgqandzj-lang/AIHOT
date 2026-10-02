// Manual-only integration of the existing material entrance, model receipts and private reader.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { localExtractionDatabase, privateApprovalPath } from './ep-pr2b-extract-one.ts';
import { sha256, stableJson } from '../packages/backend/src/lib/ids.ts';
import { NEWS_SOURCES, PRIVATE_NEWS_VERSION, PRIVATE_NEWS_PROMPT, newsCostCeiling } from '../packages/backend/src/research/private-news.ts';

export function newsArguments(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: {
    days: { type: 'string', default: '30' }, limit: { type: 'string', default: '2' }, model: { type: 'string' },
    bibliography: { type: 'string' }, pricing: { type: 'string' }, authorization: { type: 'string' }, out: { type: 'string' }, trial: { type: 'string' },
    'resume-unsent': { type: 'boolean', default: false },
  } });
  const days = Number(values.days), limit = Number(values.limit);
  if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('Use --days 1–365 and --limit 1–5');
  return { ...values, days, limit };
}

export interface NewsAuthorization { version: 'ep-private-news-authorization-v1'; planHash: string; currency: 'CNY';
  authorizedMicros: number; maxRequests: number; requestHashes: string[]; expiresAt: string; humanRequest: string }
export function validateNewsAuthorization(approval: NewsAuthorization, plan: { hash: string; maxRequests: number; upperBoundMicros: number;
  requests: { requestHash: string }[] }, now = Date.now()) {
  if (!approval || approval.version !== 'ep-private-news-authorization-v1' || approval.currency !== 'CNY'
    || approval.planHash !== plan.hash || !Number.isSafeInteger(approval.authorizedMicros) || approval.authorizedMicros < plan.upperBoundMicros
    || approval.maxRequests !== plan.maxRequests || !Array.isArray(approval.requestHashes)
    || stableJson(approval.requestHashes) !== stableJson(plan.requests.map(request => request.requestHash))
    || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= now
    || typeof approval.humanRequest !== 'string' || approval.humanRequest.trim().length < 10) throw new Error('New human authorization for this exact news plan is required');
}

export async function privateNewsCli(args = process.argv.slice(2)) {
  const options = newsArguments(args);
  process.env.MODEL_CALLS_ENABLED = 'false'; process.env.COLLECT_ENABLED = 'false'; process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
  for (const flag of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(flag)) process.env[flag] = 'false';
  if (options.trial) {
    if (options.authorization || options.pricing || options.out || options.model || options.bibliography) throw new Error('--trial is bound to its manifest; other overrides are forbidden');
    const { privateNewsTrialRun } = await import('./ep-private-news-trial.ts');
    return privateNewsTrialRun(options.trial, options['resume-unsent']);
  }
  if (options['resume-unsent']) throw new Error('--resume-unsent only applies to an interrupted trial batch that sent no request');
  localExtractionDatabase(process.env.DATABASE_URL);
  const root = process.cwd(), dataRoot = path.resolve(root, '.data');
  const directory = path.resolve(options.out ?? path.join(dataRoot, 'ep-pr2b/private-news/runs', randomUUID()));
  const relative = path.relative(dataRoot, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('--out must remain inside ignored .data');
  await mkdir(directory, { recursive: true });
  const put = (name: string, value: unknown) => writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  const { sql, closeDb } = await import('../packages/backend/src/db.ts');
  const { modelFor } = await import('../packages/backend/src/editorial/models.ts');
  const { credential, config } = await import('../packages/backend/src/config.ts');
  config.modelCallsEnabled = false;
  const { MODELS } = await import('../packages/backend/src/providers/llm.ts');
  const { discoverPrivateNews, saveNewsDiscovery, pendingNews, prepareNewsRequest, executeNewsDraft, readPrivateNews } = await import('../packages/backend/src/research/private-news-store.ts');
  const reserved = await sql.reserve();
  let locked = false;
  try {
    const [lock] = await reserved`SELECT pg_try_advisory_lock(hashtext('ep-private-news-manual-v1')) AS acquired`;
    if (!lock?.acquired) throw new Error('Another manual news run is already active');
    locked = true;
    const oldIds = new Set<string>();
    const identifiers = await sql`SELECT e.kind,e.value FROM ep_research_external_ids e
      WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.raw->'epPrivateNews'->>'recordId'=e.record_id::text)`;
    for (const row of identifiers) if (row.value) oldIds.add(row.kind + ':' + row.value);
    if (options.bibliography) {
      const bibliography = JSON.parse((await readFile(path.resolve(options.bibliography), 'utf8')).replace(/^\uFEFF/, ''));
      if (!Array.isArray(bibliography.papers)) throw new Error('Historical bibliography is invalid');
      for (const paper of bibliography.papers) {
        if (paper.pmid) oldIds.add('pmid:' + paper.pmid);
        if (paper.doi) oldIds.add('doi:' + paper.doi);
      }
    }
    const discoveries = await discoverPrivateNews({ days: options.days, limit: options.limit, historicalIds: oldIds,
      contactEmail: process.env.NCBI_CONTACT_EMAIL });
    await put('discovery.json', discoveries);
    const intake = await saveNewsDiscovery(discoveries);
    let pending = await pendingNews();
    const model = options.model ?? await modelFor('summarize');
    const spec = MODELS[model];
    let pricing: { currency: string; modelKey: string; modelName: string; basisUrl: string; verifiedAt: string; validUntil: string;
      inputMicrosPerMillion: number; outputMicrosPerMillion: number } | null = null;
    if (options.pricing) pricing = JSON.parse((await readFile(privateApprovalPath(root, options.pricing), 'utf8')).replace(/^\uFEFF/, ''));
    const pricingReady = pricing?.currency === 'CNY' && pricing.modelKey === model && pricing.modelName === spec?.model
      && pricing.basisUrl === 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
      && Date.parse(pricing.verifiedAt) <= Date.now() && Date.parse(pricing.validUntil) > Date.now()
      && spec?.model === 'deepseek-flash' && stableJson(spec.extra) === stableJson({ thinking: { type: 'disabled' } });
    let approvedPlan: { hash: string; maxRequests: number; upperBoundMicros: number;
      requests: { articleId: string; requestHash: string; baseUrl: string; materialHash: string; upperBoundMicros: number }[] } | null = null;
    let authorization: NewsAuthorization | null = null;
    if (options.authorization) {
      const approvalFile = privateApprovalPath(root, options.authorization);
      authorization = JSON.parse((await readFile(approvalFile, 'utf8')).replace(/^\uFEFF/, ''));
      approvedPlan = JSON.parse((await readFile(path.join(path.dirname(approvalFile), 'plan.json'), 'utf8')).replace(/^\uFEFF/, ''));
      const { hash, ...content } = approvedPlan!;
      if (hash !== sha256(stableJson(content))) throw new Error('Saved news plan changed');
      validateNewsAuthorization(authorization!, approvedPlan!);
      pending = pending.filter(item => approvedPlan!.requests.some(request => request.articleId === item.articleId));
    }
    pending = pending.slice(0, options.limit);
    const requests = pending.map(item => {
      const prepared = prepareNewsRequest(item, model), bytes = Buffer.byteLength(JSON.stringify(prepared.request.body));
      // Verified existing byte-level BPE: full wire bytes plus 1024 bytes for chat/JSON framing is a conservative token ceiling.
      const inputTokenUpperBound = bytes + 1024;
      const bound = pricingReady ? newsCostCeiling(inputTokenUpperBound, prepared.request.maxTokens, pricing!.inputMicrosPerMillion, pricing!.outputMicrosPerMillion) : null;
      return { articleId: item.articleId, revision: item.revision, originalTitle: item.material.title, kind: item.material.kind,
        sourceUrl: item.material.url, materialScope: item.material.scope, materialHash: item.materialHash,
        requestHash: prepared.request.bodyHash, baseUrl: prepared.request.baseUrl, modelKey: model, modelName: spec?.model ?? null,
        inputUtf8Bytes: bytes, inputTokenUpperBound, outputTokenCap: prepared.request.maxTokens, upperBoundMicros: bound,
        credentialConfigured: !!spec && !!credential('models', spec.apiKeyEnv) };
    });
    const content = { version: PRIVATE_NEWS_VERSION, mode: 'manual', promptVersion: PRIVATE_NEWS_PROMPT, days: options.days,
      sources: NEWS_SOURCES, requests, maxRequests: requests.length, upperBoundMicros: requests.every(request => request.upperBoundMicros !== null)
        ? requests.reduce((sum, request) => sum + request.upperBoundMicros!, 0) : null,
      currency: 'CNY', automaticRetries: 0, automaticModelChanges: 0, pricing, processingScope: 'title',
      countingBasis: 'Existing pinned DeepSeek byte-level BPE; conservative wire-body UTF-8 bytes plus 1024 chat/JSON framing bytes. No actual usage implied.',
      createdAt: new Date().toISOString() };
    const plan = { ...content, hash: sha256(stableJson(content)) };
    await put('plan.json', plan);
    const sends = [];
    if (authorization && approvedPlan) {
      if (!pricingReady || requests.some(request => !request.credentialConfigured || request.baseUrl !== 'https://api.deepseek.com')) throw new Error('News model, endpoint, price or credentials are not ready');
      for (const request of requests) {
        const approved = approvedPlan.requests.find(item => item.articleId === request.articleId)!;
        if (approved.requestHash !== request.requestHash || approved.materialHash !== request.materialHash
          || approved.baseUrl !== request.baseUrl || request.upperBoundMicros! > approved.upperBoundMicros) throw new Error('Current news request differs from the authorized plan');
      }
      // Scoped to this foreground command. The persistent configuration and all other valves remain closed.
      process.env.MODEL_CALLS_ENABLED = 'true';
      config.modelCallsEnabled = true;
      for (const request of requests) {
        const item = pending.find(item => item.articleId === request.articleId)!;
        try {
          const send = await executeNewsDraft(item, model, { bodyHash: request.requestHash, baseUrl: request.baseUrl!, inputTokenUpperBound: request.inputTokenUpperBound });
          sends.push(send);
          await put('execution-' + item.articleId + '.json', send);
        } catch (error) {
          await put('stopped.json', { articleId: item.articleId, reason: String(error), sends, automaticRetries: 0 });
          throw error;
        }
      }
    }
    const summary = { ...intake, candidateCount: discoveries.reduce((sum, source) => sum + source.candidates.length, 0),
      modelRequests: sends.filter(send => !send.reused).length, receiptReuses: sends.filter(send => send.reused).length,
      awaitingAuthorization: !authorization && requests.length > 0, pendingCount: (await pendingNews()).length,
      planPath: path.join(directory, 'plan.json'), feedPath: path.join(directory, 'saved-feed.json'), sends,
      completedAt: new Date().toISOString(), scheduled: false, publicDeployment: false };
    await put('saved-feed.json', await readPrivateNews());
    await put('summary.json', summary);
    return summary;
  } finally {
    process.env.MODEL_CALLS_ENABLED = 'false';
    config.modelCallsEnabled = false;
    if (locked) await reserved`SELECT pg_advisory_unlock(hashtext('ep-private-news-manual-v1'))`;
    reserved.release(); await closeDb();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  privateNewsCli().then(result => console.log(JSON.stringify(result)), error => { console.error(String(error)); process.exitCode = 1; });
}
