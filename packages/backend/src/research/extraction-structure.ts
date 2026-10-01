import { z } from 'zod';

export const STRUCTURED_EXTRACTION_VERSION = 'ep-abstract-extract-v4';

// One definition builds both the model wire shape and the saved private shape.
// References are local to this response and its exact material bundle, never PR1 IDs.
export function structuredExtractionSchema<R extends z.ZodType>(reference: R, text: z.ZodType<string>) {
  const cited = <V extends z.ZodType>(value: V) => z.object({ value, citations: z.array(reference).min(1).max(20) }).strict();
  const absence = z.union([
    z.object({ value: z.null(), citations: z.array(reference).max(0), status: z.enum(['unknown', 'not_reported']) }).strict(),
    z.object({ value: z.null(), citations: z.array(reference).min(1).max(20), status: z.literal('not_applicable') }).strict(),
  ]);
  const field = <V extends z.ZodType>(value: V) => z.union([cited(value), absence]);
  const collection = <V extends z.ZodType>(value: V, max = 20) => z.union([z.array(value).min(1).max(max), absence]);
  const groupId = z.string().regex(/^g[1-9][0-9]?$/);
  const resultId = z.string().regex(/^r[1-9][0-9]?$/);
  const countNumber = z.number().int().min(0).max(1_000_000_000);
  const sample = z.object({
    quantity: field(countNumber), unit: field(text),
    denominator: field(text).describe('This count\'s own population/inclusion scope, not an outcome denominator; owner is its overallSample or group container'),
  }).strict();
  const population = field(z.discriminatedUnion('scope', [
    z.object({ scope: z.literal('overall') }).strict(),
    z.object({ scope: z.literal('group'), groupId }).strict(),
  ])).describe('Cited ownership within THIS response/material bundle. Use value:null,status:unknown when number-to-group attribution is unclear; never choose by order or magnitude');
  const group = z.object({
    groupId, groupLabel: field(text), researchSubjects: field(text),
    productRoles: collection(cited(z.object({ product: text, role: text }).strict())),
    sample: collection(sample).describe('Independent counts for THIS group/situation; each unit/scope/citation is its own. Never copy or split overall counts'),
    imagingMethods: collection(cited(text)), radiationStrategy: field(text),
  }).strict();
  const result = z.object({
    resultId, kind: z.enum(['duration', 'outcome']), population,
    metric: field(text),
    resultValue: field(z.number().min(-1e12).max(1e12)).describe('Reported standalone numeric result; decimals/percentages are allowed here, not coerced into PR1 counts'),
    unit: field(text), statistic: field(text).describe('Only a reported statistic label such as median/mean; no reconstructed HR/OR/CI/survival model'),
    numerator: field(countNumber),
    outcomeDenominator: field(countNumber).describe('Only this result\'s explicitly reported assessed count; unknown if not reported, never inherited or reverse calculated'),
    countUnit: field(text).describe('Counting unit of a reported numerator/outcomeDenominator; not the result value unit'),
  }).strict();
  const window = z.object({
    kind: z.literal('observation_window'), start: z.number().min(0).max(1e9), end: z.number().min(0).max(1e9),
    unit: z.enum(['minutes', 'hours', 'days', 'weeks', 'months', 'years']),
    anchor: field(text).describe('Explicit origin of the observation window; keep unknown if not stated'),
  }).strict().describe('An explicit outcome observation interval/timepoint (start=end for a point); never a procedural stage or measured duration');
  return z.object({
    overallSample: collection(sample).describe('Overall population counts, kept independent from all research-group counts'),
    groups: z.array(group).max(20).describe('Reported research groups/situations only. May be empty if only an overall population is reported; no invented duplicate overall group'),
    results: collection(result, 80).describe('Separate reported results with explicit local ownership; keep unresolved ownership unknown and retain the number'),
    comparisons: collection(z.object({
      resultIds: cited(z.array(resultId).min(2).max(20)),
      description: cited(text).describe('Explicitly reported comparison relationship; a pair of numbers/order alone is insufficient'),
    }).strict()),
    proceduralContexts: collection(z.object({
      kind: z.literal('procedural_stage'), population, stage: cited(text),
    }).strict()).describe('Workflow context only; no migration into follow-up windows'),
    observationTimes: collection(z.object({ resultId, time: cited(window) }).strict())
      .describe('Every observation window must reference a local kind:outcome result; duration results cannot be follow-up windows'),
  }).strict();
}

export const STRUCTURED_EXTRACTION_RULES = {
  sample_scope_missing: 'Each known count needs its own cited unit and population scope. overallSample and each group.sample are independent lists; never aggregate, apportion, inherit or substitute one for another.',
  local_population_required: 'A result must cite its population: overall or a groupId declared in THIS response. Group IDs are local to this material bundle, not database record IDs. Unclear ownership stays unknown and pending; never use group order, numeric order, magnitude or clinical knowledge.',
  result_fields_required: 'Keep each group\'s metric, resultValue, unit and reported statistic separately. Missing numerator/outcomeDenominator stays unknown; percentages do not authorize a reverse-calculated count. countUnit belongs only to explicitly reported counts. Decimal results never go into integer count fields or PR1 facts.',
  explicit_comparison_required: 'comparisons require cited explicit source relationships and local resultIds with resolved populations. Do not automatically pair numbers or create comparisons from adjacency/order.',
  time_roles_separate: 'proceduralContexts stores workflow stages; results with kind:duration stores measured procedure time; observationTimes stores only explicit observation_window intervals linked to a kind:outcome result. Never treat a duration/stage as follow-up or convert legacy time strings.',
  local_identifiers_distinct: 'Group IDs and result IDs must each be distinct; referenced groups/results must exist in this same response. Cross-record references are forbidden.',
  observation_pair_missing: 'Each observationTimes window must reference an existing kind:outcome result with its own cited metric and population; no procedural duration or context is an outcome observation window.',
  outcome_denominator: 'A result outcomeDenominator is an explicitly assessed integer count, separate from every overall/group sample count. Keep absence when not reported; never copy or reverse-calculate it.',
} as const;
export type StructuredRuleCode = keyof typeof STRUCTURED_EXTRACTION_RULES;
export interface StructuredRuleIssue { path: string; code: StructuredRuleCode }

// Referential/conditional checks do not assert semantic support or repair values.
export function structuredExtractionIssues(output: unknown): StructuredRuleIssue[] {
  const issues: StructuredRuleIssue[] = [];
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const value = (field: unknown): unknown => object(field).value;
  const known = (field: unknown): boolean => value(field) !== null && value(field) !== undefined;
  const add = (path: string, code: StructuredRuleCode) => issues.push({ path, code });
  const root = object(output), groups = list(root.groups), results = list(root.results);
  const ids = new Set<string>(), resultMap = new Map<string, Record<string, unknown>>();
  groups.forEach((node, i) => {
    const group = object(node), id = String(group.groupId);
    if (ids.has(id) || groups.length > 1 && !known(group.groupLabel)) add(`groups[${i}].groupId`, 'local_identifiers_distinct');
    ids.add(id);
  });
  const counts = (node: unknown, base: string) => list(node).forEach((item, i) => {
    const count = object(item);
    if (known(count.quantity)) for (const key of ['unit', 'denominator']) if (!known(count[key])) add(`${base}[${i}].${key}`, 'sample_scope_missing');
  });
  counts(root.overallSample, 'overallSample');
  groups.forEach((node, i) => counts(object(node).sample, `groups[${i}].sample`));
  const populationValid = (population: unknown): boolean => {
    const owner = object(value(population));
    return owner.scope === 'overall' || owner.scope === 'group' && typeof owner.groupId === 'string' && ids.has(owner.groupId);
  };
  results.forEach((node, i) => {
    const result = object(node), base = `results[${i}]`, id = String(result.resultId);
    if (resultMap.has(id)) add(base + '.resultId', 'local_identifiers_distinct');
    resultMap.set(id, result);
    if (!populationValid(result.population)) add(base + '.population', 'local_population_required');
    if (known(result.resultValue)) for (const key of ['metric', 'unit']) if (!known(result[key])) add(base + '.' + key, 'result_fields_required');
    if ((known(result.numerator) || known(result.outcomeDenominator)) && !known(result.countUnit)) add(base + '.countUnit', 'result_fields_required');
    const unit = value(result.unit), number = value(result.resultValue);
    if (result.kind === 'duration' && (typeof number === 'number' && number < 0 || typeof unit === 'string' && !/^(?:ms|milliseconds?|s|seconds?|min|minutes?|h|hours?|d|days?)$/i.test(unit))) add(base + '.unit', 'time_roles_separate');
  });
  list(root.comparisons).forEach((node, i) => {
    const references = list(value(object(node).resultIds));
    if (new Set(references).size !== references.length || references.some(id => !resultMap.has(String(id)) || !populationValid(resultMap.get(String(id))!.population)))
      add(`comparisons[${i}].resultIds`, 'explicit_comparison_required');
  });
  list(root.proceduralContexts).forEach((node, i) => {
    if (!populationValid(object(node).population)) add(`proceduralContexts[${i}].population`, 'local_population_required');
  });
  list(root.observationTimes).forEach((node, i) => {
    const observation = object(node), result = resultMap.get(String(observation.resultId)), window = object(value(observation.time));
    if (!result || result.kind !== 'outcome' || !populationValid(result.population) || typeof window.start !== 'number' || typeof window.end !== 'number' || window.start > window.end)
      add(`observationTimes[${i}]`, 'time_roles_separate');
    if (result && !known(result.metric)) add(`observationTimes[${i}]`, 'observation_pair_missing');
  });
  return issues;
}
