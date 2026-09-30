import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Parameter, Session } from './contracts.ts';
import type { AbstractMaterialBundle } from './abstract-evidence.ts';
import { sha256, stableJson } from '../lib/ids.ts';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const basis = z.string().trim().min(1).max(2000);
export const liveApprovalSchema = z.object({
  authorizationKey: basis, authorizedBy: basis, approvedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  bundleId: z.uuid(), materialHash: hash, modelKey: basis, modelName: basis, endpoint: z.url(),
  requestHash: hash, currency: z.enum(['CNY','USD']), authorizedMicros: positive,
  materialProcessingBasis: basis,
  pricing: z.object({ basisUrl: z.url(), verifiedAt: z.iso.datetime(), validUntil: z.iso.datetime(),
    requestHash: hash, inputTokenUpperBound: positive, inputCountingBasis: basis,
    inputMicrosPerMillion: nonnegative, outputMicrosPerMillion: nonnegative, additionalFeeMicros: nonnegative,
    billingCoverage: z.literal('all_input_output_reasoning_and_additional_fees'),
    outputCapCoversAllBillableOutput: z.literal(true) }).strict(),
}).strict();
export type LiveTrialApproval = z.infer<typeof liveApprovalSchema>;
export interface FinalExtractionRequest {
  body: Record<string, unknown>; bodyHash: string; baseUrl: string | null;
  modelKey: string; modelName: unknown; service: string;
}
const json = (value: unknown): Parameter => JSON.parse(JSON.stringify(value)) as Parameter;
const q = <Row extends Record<string, unknown>>(tx: Session, text: string, values: Parameter[] = []) => tx.query<Row>({ text, values });

/** Values must come from a separately verified price/count contract; no guessed rates/counts. */
export function trialPreflight(bundle: AbstractMaterialBundle, request: FinalExtractionRequest | null,
  approval: unknown = null, now = Date.now()) {
  const reasons: string[] = [];
  const parsed = liveApprovalSchema.safeParse(approval);
  if (bundle.state !== 'ready') reasons.push('No provided abstract fragments');
  if (!request) reasons.push('No explicitly approved model/final request');
  if (!parsed.success) reasons.push('Missing valid human authorization, amount, material basis or verified pricing');
  let upperBoundMicros: number | null = null;
  const a = parsed.success ? parsed.data : null;
  if (a && request) {
    if (sha256(stableJson(request.body)) !== request.bodyHash || request.body.model !== request.modelName) reasons.push('Final body fingerprint/model mismatch');
    if (a.bundleId !== bundle.id || a.materialHash !== bundle.materialHash) reasons.push('Material authorization mismatch');
    if (a.requestHash !== request.bodyHash || a.pricing.requestHash !== request.bodyHash) reasons.push('Input/count/price authorization is for another final request');
    if (a.modelKey !== request.modelKey || a.modelName !== request.modelName || a.endpoint !== request.baseUrl) reasons.push('Model or service authorization mismatch');
    const endpoint = new URL(a.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) reasons.push('Endpoint must be HTTPS without embedded credentials/query');
    const priceUrl = new URL(a.pricing.basisUrl);
    if (priceUrl.protocol !== 'https:' || priceUrl.username || priceUrl.password || priceUrl.search || priceUrl.hash) reasons.push('Pricing basis must be a safe HTTPS source');
    if (Date.parse(a.approvedAt) > now || Date.parse(a.pricing.verifiedAt) > now
      || Date.parse(a.expiresAt) <= now || Date.parse(a.pricing.validUntil) <= now) reasons.push('Approval or pricing is expired/not yet valid');
    const permitted = new Set(['model','messages','temperature','max_tokens','response_format','thinking','reasoning_effort','enable_thinking','top_p']);
    if (Object.keys(request.body).some(key => !permitted.has(key))) reasons.push('Unsupported final billing/request parameters');
    const output = request.body.max_tokens;
    if (!Number.isSafeInteger(output) || (output as number) <= 0) reasons.push('No verified final output cap');
    else {
      const total = BigInt(a.pricing.inputTokenUpperBound) * BigInt(a.pricing.inputMicrosPerMillion)
        + BigInt(output as number) * BigInt(a.pricing.outputMicrosPerMillion);
      const ceiling = (total + 999_999n) / 1_000_000n + BigInt(a.pricing.additionalFeeMicros);
      if (ceiling <= 0n || ceiling > BigInt(Number.MAX_SAFE_INTEGER)) reasons.push('Invalid monetary ceiling');
      else { upperBoundMicros = Number(ceiling); if (upperBoundMicros > a.authorizedMicros) reasons.push('Fee ceiling exceeds approved amount'); }
    }
  }
  const messages = request?.body.messages;
  const serializedInput = Array.isArray(messages) ? JSON.stringify(messages) : '';
  return { ready: reasons.length === 0, reasons, modelKey: request?.modelKey ?? null,
    modelName: request?.modelName ?? null, materialId: bundle.materialId, materialHash: bundle.materialHash,
    bundleId: bundle.id, scope: 'abstract', providedFragmentIds: bundle.providedFragmentIds,
    inputChars: serializedInput.length, inputUtf8Bytes: Buffer.byteLength(serializedInput),
    inputTokenUpperBound: a?.pricing.inputTokenUpperBound ?? null,
    inputCountingBasis: a?.pricing.inputCountingBasis ?? null,
    outputTokenCap: request?.body.max_tokens ?? null, pricingBasis: a?.pricing.basisUrl ?? null,
    currency: a?.currency ?? null, upperBoundMicros, approvedMicros: a?.authorizedMicros ?? null,
    authorizationStatus: reasons.length === 0 ? 'approved_for_this_request' : a ? 'blocked_contract' : 'not_granted',
    semanticStatus: 'not_performed', maxActualRequests: 1, concurrency: 1, automaticRetries: 0 };
}
type TrialRow = { id: string; bundle_id: string; request_hash: string; approval: LiveTrialApproval;
  state: string; execution_count: number; reserved_micros: string; receipt_id: number | null };
export async function reserveExtractionTrial(db: Database, bundle: AbstractMaterialBundle,
  request: FinalExtractionRequest, approval: unknown) {
  const checked = trialPreflight(bundle, request, approval);
  if (!checked.ready) throw new Error('Live trial blocked: ' + checked.reasons.join('; '));
  const a = liveApprovalSchema.parse(approval);
  return db.transaction(async tx => {
    await q(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['ep-extraction-authorization:' + a.authorizationKey]);
    const [existing] = await q<TrialRow>(tx, 'SELECT * FROM ep_research_extraction_trials WHERE authorization_key=$1 FOR UPDATE', [a.authorizationKey]);
    if (existing) {
      const [same] = await q<{ same: boolean }>(tx, 'SELECT approval=$2::jsonb AS same FROM ep_research_extraction_trials WHERE id=$1::uuid', [existing.id,json(a)]);
      if (existing.request_hash !== request.bodyHash || existing.bundle_id !== bundle.id || !same?.same) throw new Error('Authorization already reserved for different parameters');
      return existing;
    }
    const [row] = await q<TrialRow>(tx, `INSERT INTO ep_research_extraction_trials
      (id,authorization_key,bundle_id,request_hash,model_key,model_name,endpoint,approval,currency,authorized_micros,reserved_micros)
      VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING *`,
      [randomUUID(),a.authorizationKey,bundle.id,request.bodyHash,a.modelKey,a.modelName,a.endpoint,json(a),a.currency,a.authorizedMicros,checked.upperBoundMicros!]);
    return row!;
  });
}
export async function loadExtractionTrial(db: Database, id: string) {
  const [row] = await q<TrialRow>(db, 'SELECT * FROM ep_research_extraction_trials WHERE id=$1::uuid',[z.uuid().parse(id)]);
  if (!row) throw new Error('Unknown extraction trial');
  return row;
}
export async function claimExtractionTrial(db: Database, id: string) {
  return db.transaction(async tx => {
    await q(tx,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['ep-extraction-single-concurrency']);
    const active = await q(tx, `SELECT id FROM ep_research_extraction_trials WHERE state IN ('in_flight','unknown')`);
    if (active.length) throw new Error('Another extraction trial is in flight or awaits reconciliation');
    const [row] = await q<TrialRow>(tx, `UPDATE ep_research_extraction_trials SET execution_count=1,state='in_flight',updated_at=now()
      WHERE id=$1::uuid AND execution_count=0 AND state='reserved' RETURNING *`,[z.uuid().parse(id)]);
    if (!row) throw new Error('Trial execution already consumed; restarting cannot authorize another request');
    return row;
  });
}
export async function finishExtractionTrial(db: Database, id: string, state: 'received'|'invalid_output'|'unknown'|'rejected', receiptId: number | null) {
  await q(db, `UPDATE ep_research_extraction_trials SET state=$2,receipt_id=$3,updated_at=now() WHERE id=$1::uuid AND execution_count=1`,[id,state,receiptId]);
  // Money remains reserved until an operator reconciles the provider's bill.
}
