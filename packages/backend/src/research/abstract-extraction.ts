import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Parameter } from './contracts.ts';
import { inputFingerprint } from './normalize.ts';
import { readAbstractMaterialBundle, readAbstractFragment, validateAbstractCitations } from './abstract-evidence.ts';
import { chatJson, prepareChatJsonRequest, markReceiptsCompleted, ModelOutputError } from '../providers/llm.ts';
import { BudgetExceededError, ProviderRejectedError } from '../providers/receipts.ts';
import { config } from '../config.ts';
import { extractionSchema, modelExtractionSchema, managedExtractionOutput, readStoredExtractionOutput,
  extractionRuleIssues, extractionFields, extractionPrompt, LEGACY_EXTRACTION_VERSION,
  EXTRACTION_PROMPT_VERSION, EXTRACTION_OUTPUT_TOKENS } from './extraction-schema.ts';
import type { ExtractionOutput } from './extraction-schema.ts';
import { trialPreflight, loadExtractionTrial, claimExtractionTrial, finishExtractionTrial } from './extraction-budget.ts';

const json = (value: unknown): Parameter => JSON.parse(JSON.stringify(value ?? null)) as Parameter;
const q = <Row extends Record<string, unknown>>(db: Database, text: string, values: Parameter[] = []) => db.query<Row>({ text, values });
export type DraftState = 'private_draft'|'invalid_output'|'unknown'|'empty_input';
export interface ExtractionDraft {
  id: string; bundleId: string; origin: 'offline_fixed'|'live'; trialId: string | null; receiptId: number | null;
  inputManifest: ReturnType<typeof extractionPrompt>['input']; output: ExtractionOutput | null;
  formatStatus: 'valid'|'invalid'|'not_received'; citationStatus: 'valid'|'invalid'|'not_checked';
  semanticStatus: 'not_performed'; state: DraftState; issues: string[];
}
export class ExtractionOutcomeUnknown extends Error {}
export type FixedExtractionResponse = (input: { system: string; user: string }) => Promise<unknown>;

async function loadInput(db: Database, bundleId: string) {
  const bundle = await readAbstractMaterialBundle(db, bundleId);
  const [material] = await q<{ metadata: Record<string, unknown>; payload_hash: string }>(db,
    'SELECT metadata,payload_hash FROM ep_research_materials WHERE id=$1::uuid',[bundle.materialId]);
  if (!material) throw new Error('Unknown extraction material');
  const { acquiredAt: _acquiredAt, ...content } = material.metadata;
  if (inputFingerprint(content) !== material.payload_hash || material.payload_hash !== bundle.materialHash) throw new Error('Extraction material fingerprint mismatch');
  const title = typeof material.metadata.title === 'string' ? material.metadata.title : null;
  return { bundle, ...extractionPrompt(bundle,title) };
}
export async function prepareExtractionRequest(db: Database, bundleId: string, modelKey: string) {
  const input = await loadInput(db,bundleId);
  const opts = { model: modelKey, purpose: 'ep_abstract_extraction', subject: 'bundle:' + bundleId,
    promptVersion: EXTRACTION_PROMPT_VERSION, system: input.system, user: input.user,
    schema: z.unknown(), parse: (value: string) => JSON.parse(value) as unknown,
    temperature: 0, maxTokens: EXTRACTION_OUTPUT_TOKENS, retryPolicy: 'never' as const };
  const request = prepareChatJsonRequest(opts);
  const expectedMessages = [{role:'system',content:input.system},{role:'user',content:input.user}];
  if (JSON.stringify(request.body.messages) !== JSON.stringify(expectedMessages)) {
    throw new Error('Preset changed the actual provided extraction material/messages');
  }
  return { ...input, opts, request };
}
/** Merely reading this report never sends a request or reserves money. */
export async function extractionLivePreflight(db: Database, bundleId: string,
  options: { modelKey?: string; approval?: unknown } = {}) {
  const input = await loadInput(db,bundleId);
  let request: ReturnType<typeof prepareChatJsonRequest> | null = null;
  let configurationIssue: string | null = null;
  if (options.modelKey) {
    try { request = (await prepareExtractionRequest(db,bundleId,options.modelKey)).request; }
    catch { configurationIssue = 'Explicit model is not configured'; }
  }
  const result = trialPreflight(input.bundle,request,options.approval);
  const serialized = JSON.stringify([{role:'system',content:input.system},{role:'user',content:input.user}]);
  return { ...result, ...(request ? {} : {inputChars:serialized.length,inputUtf8Bytes:Buffer.byteLength(serialized)}),
    requestedOutputTokens: EXTRACTION_OUTPUT_TOKENS,
    modelCallsEnabled: config.modelCallsEnabled, realRequestOptIn: false, canSendRealRequest: false,
    reasons: configurationIssue ? [...result.reasons,configurationIssue] : result.reasons };
}
async function persist(db: Database, input: Awaited<ReturnType<typeof loadInput>>, raw: unknown,
  origin: ExtractionDraft['origin'], trialId: string | null, receiptId: number | null,
  failure: 'unknown'|'invalid'|'rejected'|null = null) {
  const draft: ExtractionDraft = { id: randomUUID(), bundleId: input.bundle.id, origin, trialId, receiptId,
    inputManifest: input.input, output: null, formatStatus: 'not_received', citationStatus: 'not_checked',
    semanticStatus: 'not_performed', state: failure === 'unknown' ? 'unknown' : failure ? 'invalid_output' : 'empty_input', issues: [] };
  if (failure === 'unknown') draft.issues.push('Request outcome unknown; money and execution remain reserved; no resend');
  else if (failure === 'rejected') draft.issues.push('Request rejected; no model output received; no resend');
  else if (failure === 'invalid') { draft.formatStatus = 'invalid'; draft.issues.push('Provider output was not parseable as JSON; no resend'); }
  else if (input.bundle.state === 'ready') {
    // An explicitly injected historical fixture can use the frozen v1 contract.
    // A live response always uses the same research-only schema as the new prompt.
    const legacy = origin === 'offline_fixed' && raw !== null && typeof raw === 'object'
      && 'schemaVersion' in raw && raw.schemaVersion === LEGACY_EXTRACTION_VERSION;
    const parsed = legacy ? extractionSchema.safeParse(raw) : modelExtractionSchema.safeParse(raw);
    if (!parsed.success) {
      draft.formatStatus = 'invalid'; draft.state = 'invalid_output';
      draft.issues = parsed.error.issues.map(item => item.path.join('.') + ': ' + item.code);
    } else {
      draft.output = 'schemaVersion' in parsed.data ? parsed.data : managedExtractionOutput(parsed.data);
      draft.formatStatus = 'valid';
      const ruleIssues = extractionRuleIssues(draft.output);
      draft.issues.push(...ruleIssues.map(item => item.path + ': ' + item.code));
      const references = extractionFields(draft.output).flatMap(item => item.citations);
      // De-duplicate references while preserving exact identity checks for every field.
      const unique = [...new Map(references.map(item => [JSON.stringify(item),item])).values()];
      try {
        await validateAbstractCitations(db,input.bundle.id,unique);
        draft.citationStatus = 'valid'; draft.state = ruleIssues.length ? 'invalid_output' : 'private_draft';
      } catch (error) {
        draft.citationStatus = 'invalid'; draft.state = 'invalid_output';
        draft.issues.push('Citation identity rejected: ' + String(error));
      }
    }
  }
  // PostgreSQL JSONB cannot preserve NUL; the original provider envelope remains in its receipt.
  const storedRaw = JSON.stringify(raw ?? null).replace(/\\\\/g,'').includes('\\u0000') ? null : raw;
  if (storedRaw === null && raw !== null) draft.issues.push('Raw output contains NUL and cannot be stored as PostgreSQL JSONB');
  await q(db, `INSERT INTO ep_research_extraction_drafts
    (id,bundle_id,input_manifest,origin,trial_id,receipt_id,raw_output,parsed_output,format_status,citation_status,semantic_status,state,issues)
    VALUES ($1::uuid,$2::uuid,$3::jsonb,$4,$5::uuid,$6,$7::jsonb,$8::jsonb,$9,$10,'not_performed',$11,$12::jsonb)`,
    [draft.id,draft.bundleId,json(draft.inputManifest),origin,trialId,receiptId,json(storedRaw),json(draft.output),
     draft.formatStatus,draft.citationStatus,draft.state,json(draft.issues)]);
  return draft;
}
/** Requires an injected response. Has no provider/worker/retry fallback. */
export async function extractOfflineBundle(db: Database, bundleId: string, response: FixedExtractionResponse) {
  const input = await loadInput(db,bundleId);
  if (input.bundle.state !== 'ready') return persist(db,input,null,'offline_fixed',null,null);
  try { return await persist(db,input,await response({system:input.system,user:input.user}),'offline_fixed',null,null); }
  catch (error) {
    if (error instanceof ExtractionOutcomeUnknown) return persist(db,input,null,'offline_fixed',null,null,'unknown');
    throw error;
  }
}
/** Single explicit round; the default does not permit any real request. */
export async function executeExtractionTrial(db: Database, trialId: string,
  options: { enableRealRequest?: boolean; timeoutMs?: number } = {}) {
  if (options.enableRealRequest !== true || !config.modelCallsEnabled) throw new Error('Real extraction calls are disabled');
  const trial = await loadExtractionTrial(db,trialId);
  const prepared = await prepareExtractionRequest(db,trial.bundle_id,trial.approval.modelKey);
  const checked = trialPreflight(prepared.bundle,prepared.request,trial.approval);
  if (!checked.ready || trial.request_hash !== prepared.request.bodyHash) throw new Error('Live extraction preflight no longer matches');
  await claimExtractionTrial(db,trialId); // Persist before network; crash/timeout cannot reset it.
  let receiptId: number | null = null;
  let raw: unknown = null;
  try {
    const result = await chatJson({ ...prepared.opts, subject: 'ep-extraction-trial:' + trialId,
      attemptTag: trialId, timeoutMs: options.timeoutMs ?? 120_000,
      approvedRequest: {bodyHash:prepared.request.bodyHash,baseUrl:prepared.request.baseUrl!} });
    receiptId = result.receiptId; raw = result.data;
  } catch (error) {
    const [receipt] = await q<{id:number;status:string}>(db,
      "SELECT id,status FROM receipts WHERE purpose='ep_abstract_extraction' AND subject=$1 ORDER BY id DESC LIMIT 1",['ep-extraction-trial:' + trialId]);
    receiptId = receipt?.id ?? null;
    const failure = error instanceof ModelOutputError ? 'invalid'
      : error instanceof BudgetExceededError || error instanceof ProviderRejectedError ? 'rejected' : 'unknown';
    await finishExtractionTrial(db,trialId,failure === 'invalid' ? 'invalid_output' : failure,receiptId);
    return persist(db,prepared,null,'live',trialId,receiptId,failure);
  }
  // Saving failure leaves in_flight and the existing received receipt. It is never re-sent.
  const draft = await persist(db,prepared,raw,'live',trialId,receiptId);
  await finishExtractionTrial(db,trialId,draft.state === 'private_draft' ? 'received' : 'invalid_output',receiptId);
  await markReceiptsCompleted([receiptId]);
  return draft;
}
export async function readExtractionDraft(db: Database, id: string): Promise<ExtractionDraft> {
  const [row] = await q<{id:string;bundle_id:string;origin:ExtractionDraft['origin'];trial_id:string|null;receipt_id:number|null;
    input_manifest:ExtractionDraft['inputManifest'];parsed_output:ExtractionOutput|null;format_status:ExtractionDraft['formatStatus'];
    citation_status:ExtractionDraft['citationStatus'];state:DraftState;issues:string[]}>(db,
    'SELECT * FROM ep_research_extraction_drafts WHERE id=$1::uuid',[z.uuid().parse(id)]);
  if (!row) throw new Error('Unknown private extraction draft');
  return {id:row.id,bundleId:row.bundle_id,origin:row.origin,trialId:row.trial_id,receiptId:row.receipt_id,
    inputManifest:row.input_manifest,output:row.parsed_output ? readStoredExtractionOutput(row.parsed_output) : null,formatStatus:row.format_status,
    citationStatus:row.citation_status,semanticStatus:'not_performed',state:row.state,issues:row.issues};
}
/** Fixed template and exact private evidence readback; never a prose model call. */
export async function extractionFieldReport(db: Database, draftId: string) {
  const draft = await readExtractionDraft(db,draftId);
  const fields = [];
  for (const field of draft.output ? extractionFields(draft.output) : []) {
    const evidence = [];
    for (const reference of field.citations) {
      try {
        const item = await readAbstractFragment(db,draft.bundleId,reference);
        evidence.push({reference,identity:'valid' as const,scope:item.scope,label:item.sectionLabel,text:item.text});
      } catch { evidence.push({reference,identity:'invalid' as const,scope:'abstract' as const,label:null,text:null}); }
    }
    fields.push({...field,evidence,semanticStatus:'not_performed' as const});
  }
  return {draftId:draft.id,origin:draft.origin,state:draft.state,bundleId:draft.bundleId,
    materialId:draft.inputManifest.materialId,materialHash:draft.inputManifest.materialHash,
    providedFragmentIds:draft.inputManifest.providedFragmentIds,formatStatus:draft.formatStatus,
    citationStatus:draft.citationStatus,semanticStatus:draft.semanticStatus,
    realModelEffectValidated:false,fields,issues:draft.issues};
}
export function renderExtractionReport(report: Awaited<ReturnType<typeof extractionFieldReport>>) {
  const escape = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>');
  return `# 私有摘要提取逐字段核对\n\n来源：${report.origin}；草稿：${report.draftId}\n\n材料包：${report.bundleId}；材料版本：${report.materialHash}\n\n格式：${report.formatStatus}；引用身份：${report.citationStatus}；语义核查：尚未进行。\n真实模型效果尚未验证。引用存在不代表原文支持结论。\n\n| 组别 / 字段 | 草稿值 | 片段引用 | 原文回读 | 语义核查 |\n|---|---|---|---|---|\n`
    + report.fields.map(field => `| ${escape(field.groupId + ' / ' + field.path)} | ${field.value === null ? ({unknown:'未知',not_reported:'提供摘要未报告',not_applicable:'不适用（引用待核查）'}[field.absenceStatus ?? 'unknown']) : escape(field.value)} | ${field.evidence.map(item => escape(item.reference.fragmentId + ' (' + item.identity + ')')).join('<br>') || '—'} | ${field.evidence.map(item => escape(item.text ?? '引用被拒绝')).join('<br>') || '—'} | 尚未进行 |`).join('\n') + '\n';
}
