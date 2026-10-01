// Local, private, single-material entry point. No worker, scheduler or retry loop.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

/** A saved execution is immutable; later preparation gets a separate directory. */
export async function extractionOutputDirectory(root: string, bundleId: string, mode: 'prepare'|'run') {
  const directory = path.resolve(root,'.data/ep-pr2b','live-' + bundleId);
  let completed = false;
  try { await readFile(path.join(directory,'execution.json'),'utf8'); completed = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (completed && mode === 'run') throw new Error('Saved execution exists; original authorization is consumed.');
  return completed ? path.join(directory,'preparation-' + randomUUID()) : directory;
}

export function extractionCliArguments(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    material: { type: 'string' }, bundle: { type: 'string' }, model: { type: 'string' },
    approval: { type: 'string' }, 'execute-once': { type: 'boolean', default: false },
  } });
  const mode = positionals[0];
  if (positionals.length !== 1 || !['prepare', 'run'].includes(mode ?? '')) throw new Error('Use prepare or run with one material/bundle.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!!values.material === !!values.bundle || !uuid.test(values.material ?? values.bundle ?? '')) throw new Error('Supply exactly one valid --material or --bundle UUID.');
  if (mode === 'prepare' && values['execute-once']) throw new Error('prepare never permits --execute-once.');
  if (mode === 'run' && (!values.bundle || !values.approval || !values['execute-once'] || values.model)) throw new Error('run requires --bundle, --approval and --execute-once; the approval supplies the model.');
  return { ...values, mode: mode as 'prepare' | 'run' };
}

export function localExtractionDatabase(value: string | undefined, production = process.env.NODE_ENV === 'production') {
  if (!value || production) throw new Error('An explicit local test database is required.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.search || url.hash || !/^[a-zA-Z0-9_]+_(test|ci)$/.test(decodeURIComponent(url.pathname.slice(1)))) {
    throw new Error('Use a loopback PostgreSQL database ending in _test or _ci, without query overrides.');
  }
}

export function privateApprovalPath(root: string, value: string) {
  const directory = path.resolve(root, '.data');
  const result = path.resolve(root, value);
  const relative = path.relative(directory, result);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(result) !== '.json') throw new Error('Approval JSON must stay inside the ignored .data directory.');
  return result;
}

/** Diagnostic display only. Never normalizes an invalid response into a draft. */
export function rawExtractionDiagnosticRows(output: unknown) {
  const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const groups = object(output)?.groups;
  const rows: Array<{ groupId: string; path: string; value: unknown; rawNode: unknown; citations: unknown[] }> = [];
  if (!Array.isArray(groups)) return rows;
  for (const [index, rawGroup] of groups.slice(0,20).entries()) {
    const group = object(rawGroup); if (!group) continue;
    const groupId = typeof group.groupId === 'string' ? group.groupId : 'raw-group-' + index;
    const add = (path: string, node: unknown) => {
      const value = object(node);
      const cited = value && Object.hasOwn(value,'value');
      rows.push({ groupId, path, value: cited ? value.value : node ?? null, rawNode: node ?? null,
        citations: cited && Array.isArray(value.citations) ? value.citations : [] });
    };
    const list = (name: string, node: unknown) => {
      if (Array.isArray(node) && node.length) node.slice(0,20).forEach((item,i) => add(`${name}[${i}]`,item));
      else add(name,node);
    };
    add('groupLabel',group.groupLabel); list('productRoles',group.productRoles); add('researchSubjects',group.researchSubjects);
    const sample = object(group.sample);
    for (const name of ['quantity','unit','denominator']) add('sample.' + name,sample?.[name]);
    list('imagingMethods',group.imagingMethods); add('radiationStrategy',group.radiationStrategy);
    if (Array.isArray(group.observationTimes) && group.observationTimes.length) {
      group.observationTimes.slice(0,20).forEach((item,i) => {
        const observation = object(item);
        add(`observationTimes[${i}].time`,observation?.time); add(`observationTimes[${i}].purpose`,observation?.purpose);
      });
    } else add('observationTimes',group.observationTimes);
  }
  return rows;
}

const fieldLabels = ['产品及角色', '研究对象', '样本数量', '数量单位', '人数分母口径', '影像方式', '射线策略', '观察时间及其用途'];
const blockedReport = (reasons: string[]) => `# 私有摘要提取准备\n\n工程链路已准备，模型效果尚未验证。真实模型试验未执行；没有模型输出。\n\n`
  + `| 字段 | 模型输出 | 原文引用 | 是否支持 | 错误或缺失原因 |\n|---|---|---|---|---|\n`
  + fieldLabels.map(label => `| ${label} | 未调用，无输出 | — | 未评估 | 尚未执行真实请求 |`).join('\n')
  + '\n\n待补齐：\n' + reasons.map(reason => '- ' + reason).join('\n') + '\n';

export async function extractionCli(args = process.argv.slice(2)) {
  const options = extractionCliArguments(args);
  localExtractionDatabase(process.env.DATABASE_URL);
  const explicitValve = /^(1|true)$/i.test(process.env.MODEL_CALLS_ENABLED ?? '');
  process.env.MODEL_CALLS_ENABLED = options.mode === 'run' && explicitValve ? 'true' : 'false';
  process.env.COLLECT_ENABLED = 'false'; process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
  for (const name of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(name)) process.env[name] = 'false';
  const { sql, closeDb } = await import('../packages/backend/src/db.ts');
  const { researchDatabase } = await import('../packages/backend/src/research/postgres.ts');
  const { buildAbstractMaterialBundle, readAbstractMaterialBundle, readAbstractFragment } = await import('../packages/backend/src/research/abstract-evidence.ts');
  const { extractionLivePreflight, prepareExtractionRequest, executeExtractionTrial, extractionFieldReport } = await import('../packages/backend/src/research/abstract-extraction.ts');
  const { reserveExtractionTrial, liveApprovalSchema } = await import('../packages/backend/src/research/extraction-budget.ts');
  const { MODELS } = await import('../packages/backend/src/providers/llm.ts');
  const { credential } = await import('../packages/backend/src/config.ts');
  const { extractionPrompt } = await import('../packages/backend/src/research/extraction-schema.ts');
  const db = researchDatabase(sql);
  try {
    const bundle = options.material ? await buildAbstractMaterialBundle(db, options.material) : await readAbstractMaterialBundle(db, options.bundle!);
    const directory = await extractionOutputDirectory(process.cwd(),bundle.id,options.mode);
    await mkdir(directory, { recursive: true });
    const approval = options.approval ? JSON.parse(await readFile(privateApprovalPath(process.cwd(), options.approval), 'utf8')) as unknown : undefined;
    const parsed = liveApprovalSchema.safeParse(approval);
    const modelKey = options.mode === 'run' ? parsed.success ? parsed.data.modelKey : undefined : options.model;
    const preflight = await extractionLivePreflight(db, bundle.id, { modelKey, approval });
    const reasons = [...preflight.reasons];
    const spec = modelKey ? MODELS[modelKey] : undefined;
    if (!spec || !credential('models', spec.apiKeyEnv)) reasons.push('No configured credential for the selected model.');
    if (options.mode === 'run' && !explicitValve) reasons.push('MODEL_CALLS_ENABLED must be explicitly enabled for this one request.');
    let prepared: Awaited<ReturnType<typeof prepareExtractionRequest>> | null = null;
    if (modelKey && spec) {
      try { prepared = await prepareExtractionRequest(db, bundle.id, modelKey); }
      catch { /* The read-only preflight already records the configuration failure. */ }
    }
    if (prepared) await writeFile(path.join(directory, 'final-request.json'), JSON.stringify(prepared.request, null, 2), 'utf8');
    const [material] = await sql<{ metadata: { title?: string; pmid?: string; doi?: string } }[]>`SELECT metadata FROM ep_research_materials WHERE id=${bundle.materialId}`;
    const input = extractionPrompt(bundle, material?.metadata.title ?? null);
    await writeFile(path.join(directory, 'provided-input.json'), JSON.stringify(input, null, 2), 'utf8');
    const summary = { ...preflight, stage: 'preflight_no_request', ready: reasons.length === 0, reasons, source: bundle.source,
      requestHash: prepared?.request.bodyHash ?? null,
      pmid: material?.metadata.pmid ?? null, doi: material?.metadata.doi ?? null,
      processingAuthorization: parsed.success ? 'declared_in_approval' : 'not_granted',
      directory, actualRequests: 0, actualInputTokens: null, actualOutputTokens: null,
      actualCost: null, realModelTrialExecuted: false, requiresHumanReview: true };
    await writeFile(path.join(directory, 'preflight.json'), JSON.stringify(summary, null, 2), 'utf8');
    if (options.mode === 'prepare' || reasons.length) {
      await writeFile(path.join(directory, 'preparation-status.md'), blockedReport(reasons), 'utf8');
      console.log(JSON.stringify(summary, null, 2));
      return options.mode === 'run' ? 2 : 0;
    }
    if (!prepared) throw new Error('No final prepared request.');
    const trial = await reserveExtractionTrial(db, prepared.bundle, prepared.request, approval);
    const draft = await executeExtractionTrial(db, trial.id, { enableRealRequest: true });
    const report = await extractionFieldReport(db, draft.id);
    const [receipt] = draft.receiptId === null ? [] : await sql<{ attempts: number; usage: Record<string, unknown> | null; cost: number | null; response: unknown; status: string }[]>`SELECT attempts,usage,cost,response,status FROM receipts WHERE id=${draft.receiptId}`;
    let rawDiagnosticRows: ReturnType<typeof rawExtractionDiagnosticRows> = [];
    const displayFields = [...report.fields];
    // JSON syntax can be valid while field shape is invalid. Keep those values
    // reviewable without promoting them into parsed_output or changing checks.
    if (draft.formatStatus === 'invalid' && !displayFields.length) {
      try {
        const envelope = receipt?.response as { choices?: Array<{ message?: { content?: unknown } }> } | undefined;
        const content = envelope?.choices?.[0]?.message?.content;
        if (typeof content === 'string') rawDiagnosticRows = rawExtractionDiagnosticRows(JSON.parse(content));
      } catch { /* An unparseable response remains available in the private receipt. */ }
      for (const field of rawDiagnosticRows) {
        const evidence = [];
        for (const raw of field.citations) {
          const reference = raw as Parameters<typeof readAbstractFragment>[2];
          try {
            const item = await readAbstractFragment(db,bundle.id,reference);
            evidence.push({reference,identity:'valid' as const,scope:item.scope,label:item.sectionLabel,text:item.text});
          } catch { evidence.push({reference,identity:'invalid' as const,scope:'abstract' as const,label:null,text:null}); }
        }
        displayFields.push({groupId:field.groupId,path:field.path,value:field.value,
          citations:field.citations as Parameters<typeof readAbstractFragment>[2][],evidence,semanticStatus:'not_performed' as const});
      }
    }
    const escape = (value: unknown) => String(typeof value === 'string' ? value : JSON.stringify(value)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    const rows = displayFields.map(field => `| ${escape(field.groupId + ' / ' + field.path)} | ${field.value === null ? ({unknown:'未知',not_reported:'提供摘要未报告',not_applicable:'不适用（引用待核查）'}[field.absenceStatus ?? 'unknown']) : escape(field.value)} | ${field.evidence.map(item => escape(item.reference?.fragmentId) + '<br>' + escape(item.text ?? '引用被拒绝')).join('<br>') || '—'} | 待人工核对 | ${rawDiagnosticRows.length ? '整体结构被拒绝；仅展示原始诊断值，未自动修复。' : ''}${field.value === null ? '缺失状态按模型原值保留；尚未人工判断' : field.evidence.some(item => item.identity !== 'valid') ? '引用身份不合法' : !field.evidence.length ? '非空值缺少模型引用' : '引用存在；语义支持尚未核查'} |`);
    const text = `# 私有实际模型提取\n\n格式：${draft.formatStatus}；引用身份：${draft.citationStatus}；语义：未核查。仍需人工判断是否支持及是否需要修改。\n\n| 字段 | 模型输出 | 原文引用 | 是否支持 | 错误或缺失原因 |\n|---|---|---|---|---|\n`
      + (rows.length ? rows.join('\n') : fieldLabels.map(label => `| ${label} | 未形成可用结构化结果 | — | 未评估 | ${escape(draft.issues.join('; '))} |`).join('\n')) + '\n';
    const metrics = { trialId: trial.id, draftId: draft.id, receiptId: draft.receiptId,
      networkAttemptsRecorded: receipt?.attempts ?? 0, providerResultStatus: receipt?.status ?? null,
      usage: receipt?.usage ?? null, currency: parsed.success ? parsed.data.currency : null,
      reservedCeilingMicros: trial.reserved_micros, actualReceiptCost: receipt?.cost ?? null,
      costNote: 'The reserved ceiling is not an invoice; null cost is unknown, not free.',
      modelOutputReceived: draft.formatStatus !== 'not_received', semanticStatus: 'not_performed',
      realModelEffectValidated: false, requiresHumanReview: true, automaticRetries: 0,
      rawDiagnosticFieldCount: rawDiagnosticRows.length };
    await writeFile(path.join(directory, 'field-report.md'), text, 'utf8');
    await writeFile(path.join(directory, 'field-report.json'), JSON.stringify({ ...report, rawDiagnosticRows }, null, 2), 'utf8');
    await writeFile(path.join(directory, 'provider-receipt.json'), JSON.stringify(receipt ?? null, null, 2), 'utf8');
    await writeFile(path.join(directory, 'execution.json'), JSON.stringify(metrics, null, 2), 'utf8');
    console.log(JSON.stringify({ ...metrics, directory }, null, 2));
    return draft.state === 'private_draft' ? 0 : 2;
  } finally { await closeDb(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await extractionCli(); }
  catch (error) {
    console.error(JSON.stringify({ status: 'stopped', errorType: error instanceof Error ? error.name : 'UnknownError',
      message: 'Extraction stopped. No automatic retry; inspect the private preflight and database trial state.' }));
    process.exitCode = 2;
  }
}
