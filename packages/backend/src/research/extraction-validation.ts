// Pure v3 wire validation. No provider, DB, configuration or execution imports.
import { compactExtractionSchema, currentExtractionSchema, EXTRACTION_PROMPT_VERSION,
  extractionRuleIssues, extractionFields } from './extraction-schema.ts';
import { validateReplayInput } from './extraction-replay.ts';
import type { ReplayInput } from './extraction-replay.ts';
import type { CurrentExtractionOutput } from './extraction-schema.ts';

export interface ExtractionCompletion {
  finishReason?: string | null; outputTokens?: number | null; maxTokens?: number | null;
}
export function extractionTruncation(completion: ExtractionCompletion = {}) {
  return {status:completion.finishReason === 'length' ? 'truncated' as const
    : completion.finishReason === 'stop' ? 'not_indicated' as const : 'unknown' as const,
    finishReason:completion.finishReason ?? null,outputTokens:completion.outputTokens ?? null,
    maxTokens:completion.maxTokens ?? null};
}
export class ExtractionTruncatedError extends Error {}
/** Never repair JSON, extract a prefix or accept even valid JSON after a length stop. */
export function parseExtractionContent(content: string, completion: ExtractionCompletion = {}) {
  if (extractionTruncation(completion).status === 'truncated') throw new ExtractionTruncatedError('output_truncated: finish_reason=length');
  return JSON.parse(content) as unknown;
}
export function validateCompactExtraction(raw: unknown, input: ReplayInput, completion: ExtractionCompletion = {}) {
  validateReplayInput(input);
  const truncation = extractionTruncation(completion);
  const parsed = compactExtractionSchema.safeParse(raw);
  const result = {formatStatus:parsed.success ? 'valid' as const : 'invalid' as const,
    formatErrors:parsed.success ? [] : parsed.error.issues.map(item=>item.path.join('.')+': '+item.code),
    citationStatus:'not_checked' as 'valid'|'invalid'|'not_checked',citationErrors:[] as string[],
    fieldCompletenessStatus:'not_checked' as 'required_fields_present'|'missing_dependencies'|'not_checked',
    sourceCoverageStatus:'not_evaluated' as const,semanticStatus:'not_evaluated' as const,
    truncation,contentIssues:[] as ReturnType<typeof extractionRuleIssues>,
    output:null as CurrentExtractionOutput|null,completeCardAllowed:false,qualified:false,realModelEffectValidated:false};
  if (!parsed.success || truncation.status === 'truncated') return result;
  const references = new Map(input.fragments.map(item=>[item.citation.fragmentId,item.citation]));
  const expand = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([key,value])=>[key,key === 'citations'
      ? (value as string[]).map(id=>{
        const identity = references.get(id);
        if (!identity) result.citationErrors.push('citation_not_in_exact_provided_manifest: '+id);
        return identity ? structuredClone(identity) : null;
      }) : expand(value)]));
  };
  const expanded = expand(parsed.data);
  result.citationStatus = result.citationErrors.length ? 'invalid' : 'valid';
  if (result.citationStatus === 'invalid') return result;
  // Only explicitly supplied IDs are resolved. Missing fields/claims/references
  // are never invented; this adapter is never applied to old saved responses.
  const output:CurrentExtractionOutput = {...currentExtractionSchema.parse(expanded),schemaVersion:EXTRACTION_PROMPT_VERSION};
  result.output = output;
  result.contentIssues = extractionRuleIssues(output);
  result.fieldCompletenessStatus = result.contentIssues.length ? 'missing_dependencies' : 'required_fields_present';
  result.completeCardAllowed = !result.contentIssues.length && extractionFields(output).some(item=>item.value !== null && item.path !== 'groupLabel');
  return result;
}
