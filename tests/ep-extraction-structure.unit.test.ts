import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { structuredExtractionSchema, structuredExtractionIssues } from '../packages/backend/src/research/extraction-structure.ts';
import { structuredExtractionFixture, ambiguousStructuredFixture } from './fixtures/ep-extraction-structure.ts';
import { extractionPrompt, extractionResponseSchema, readStoredExtractionOutput, extractionFields,
  structuredStoredExtractionSchema, EXTRACTION_PROMPT_VERSION, EXTRACTION_RULES } from '../packages/backend/src/research/extraction-schema.ts';
import { validateStructuredExtraction, validateCompactExtraction } from '../packages/backend/src/research/extraction-validation.ts';

// Prototype contract proof runs before connecting the new version to extraction.
const schema = structuredExtractionSchema(z.uuid(), z.string().min(1).max(2000).regex(/\S/));
function check(raw: unknown) {
  const parsed = schema.safeParse(raw);
  return { valid: parsed.success, issues: parsed.success ? structuredExtractionIssues(parsed.data) : ['format'], output: parsed.success ? parsed.data : null };
}

test('a/b: overall patient/PV counts and two group counts coexist independently with no sum or inheritance', () => {
  const { output } = structuredExtractionFixture(), before = JSON.stringify(output);
  const result = check(output);
  assert.equal(result.valid, true); assert.deepEqual(result.issues, []);
  assert.deepEqual((result.output!.overallSample as any[]).map(row => [row.quantity.value, row.unit.value]), [[22, 'participants'], [88, 'pulmonary veins']]);
  assert.deepEqual(result.output!.groups.map(group => (group.sample as any[])[0].quantity.value), [9, 13]);
  assert.deepEqual((result.output!.groups[0]!.sample as any[]).map(row => [row.quantity.value, row.unit.value]), [[9, 'participants'], [36, 'pulmonary veins']]);
  assert.ok((result.output!.results as any[]).every(row => row.outcomeDenominator.value === null));
  assert.equal(JSON.stringify(output), before);
  const changed = structuredClone(output); changed.groups[0]!.sample[0]!.quantity.value = 8;
  assert.deepEqual(check(changed).issues, [], 'no implicit sum-to-overall constraint');
  assert.equal((check(changed).output!.overallSample as any[])[0].quantity.value, 22);
});
test('c: duration result ownership must reference a declared local group; foreign record properties cannot pass', () => {
  const { output } = structuredExtractionFixture();
  const wrong = structuredClone(output) as any; wrong.results[0].population.value.groupId = 'g9';
  assert.ok(check(wrong).issues.some(issue => typeof issue !== 'string' && issue.code === 'local_population_required'));
  const foreign = structuredClone(output) as any; foreign.results[0].population.value.recordId = randomUUID();
  assert.equal(check(foreign).valid, false);
});
test('d: ambiguous paired numbers stay unassigned; no group-order, numeric-sort or comparison synthesis', () => {
  const pending = ambiguousStructuredFixture().output;
  const before = JSON.stringify(pending), checked = check(pending);
  assert.equal(checked.valid, true); assert.equal(checked.issues.filter(issue => typeof issue !== 'string' && issue.code === 'local_population_required').length, 2);
  assert.ok((checked.output!.results as any[]).every(result => result.population.value === null));
  assert.equal(JSON.stringify(pending), before); assert.equal((checked.output!.comparisons as any).value, null);
});
test('e: procedural stages and measured durations cannot be observation windows or window targets', () => {
  const { output, cite } = structuredExtractionFixture();
  const stage = structuredClone(output) as any; stage.observationTimes[0].time = cite({ kind: 'procedural_stage', stage: 'before ablation' });
  assert.equal(check(stage).valid, false);
  const duration = structuredClone(output) as any; duration.observationTimes[0].time = cite({ kind: 'duration', value: 48, unit: 'minutes' });
  assert.equal(check(duration).valid, false);
  const wrongTarget = structuredClone(output); wrongTarget.observationTimes[0]!.resultId = 'r1';
  assert.ok(check(wrongTarget).issues.some(issue => typeof issue !== 'string' && issue.code === 'time_roles_separate'));
  const oldString = structuredClone(output) as any; oldString.observationTimes[0].time = cite('48 minutes');
  assert.equal(check(oldString).valid, false);
  const missingOutcome = structuredClone(output) as any; missingOutcome.results[2].metric = { value: null, citations: [], status: 'unknown' };
  assert.ok(check(missingOutcome).issues.some(issue => typeof issue !== 'string' && issue.code === 'observation_pair_missing'));
});
test('f: percent value survives without numerator/denominator; decimal values cannot be coerced into count fields', () => {
  const { output } = structuredExtractionFixture(); const checked = check(output), percentage = (checked.output!.results as any[])[2];
  assert.equal(percentage.resultValue.value, 78.4); assert.equal(percentage.numerator.value, null); assert.equal(percentage.outcomeDenominator.value, null);
  const bad = structuredClone(output) as any; bad.results[2].outcomeDenominator = bad.results[2].resultValue;
  assert.equal(check(bad).valid, false);
});
test('counts require their own unit/scope; a comparison requires an explicit cited relation and valid result IDs', () => {
  const { output, absent } = structuredExtractionFixture();
  const scope = structuredClone(output) as any; scope.overallSample[1].denominator = absent();
  assert.ok(check(scope).issues.some(issue => typeof issue !== 'string' && issue.code === 'sample_scope_missing'));
  const relation = structuredClone(output) as any; relation.comparisons[0].description = absent();
  assert.equal(check(relation).valid, false);
  const reference = structuredClone(output); reference.comparisons[0]!.resultIds.value = ['r1', 'r9'];
  assert.ok(check(reference).issues.some(issue => typeof issue !== 'string' && issue.code === 'explicit_comparison_required'));
});
test('model payload cannot claim program version, permissions, verification or publication', () => {
  const { output } = structuredExtractionFixture();
  for (const key of ['schemaVersion', 'humanApprovalGranted', 'processingAllowed', 'publicationState']) assert.equal(check({ ...output, [key]: true }).valid, false);
});

test('g: every result citation is confined to the exact supplied bundle; invented/cross-bundle/duplicate IDs are rejected', () => {
  const { bundle, output } = structuredExtractionFixture(), other = structuredExtractionFixture();
  const { input } = extractionPrompt(bundle, '[SYNTHETIC TEST RECORD ONLY]');
  const accepted = validateStructuredExtraction(output, input);
  assert.equal(accepted.citationStatus, 'valid'); assert.equal(accepted.privateDraftAllowed, true);
  assert.equal(accepted.completeCardAllowed, false); assert.equal(accepted.qualified, false);
  assert.equal(accepted.semanticStatus, 'not_evaluated'); assert.equal(accepted.realModelEffectValidated, false);
  for (const key of ['population', 'metric', 'resultValue', 'unit', 'statistic']) {
    for (const id of [randomUUID(), other.bundle.fragments[0]!.id]) {
      const bad = structuredClone(output) as any; bad.results[0][key].citations = [id];
      const rejected = validateStructuredExtraction(bad, input);
      assert.equal(rejected.formatStatus, 'valid'); assert.equal(rejected.citationStatus, 'invalid');
      assert.equal(rejected.privateDraftAllowed, false); assert.equal(rejected.output, null);
    }
  }
  const duplicate = structuredClone(output); duplicate.results[0]!.metric.citations.push(bundle.fragments[0]!.id);
  assert.equal(validateStructuredExtraction(duplicate, input).citationStatus, 'invalid');
  const nested = structuredClone(output); nested.observationTimes[0]!.time.value.anchor.citations = [other.bundle.fragments[0]!.id];
  assert.equal(validateStructuredExtraction(nested, input).citationStatus, 'invalid');
  const fullIdentity = structuredClone(output) as any;
  fullIdentity.results[0].metric.citations = [input.fragments[0]!.citation];
  assert.equal(validateStructuredExtraction(fullIdentity, input).formatStatus, 'invalid', 'wire input only permits fragment IDs');
});

test('pending ownership preserves the raw numbers and cannot become a checked private card', () => {
  const { bundle, output } = ambiguousStructuredFixture(), { input } = extractionPrompt(bundle, '[SYNTHETIC TEST RECORD ONLY]');
  const before = JSON.stringify(output), checked = validateStructuredExtraction(output, input);
  assert.equal(checked.formatStatus, 'valid'); assert.equal(checked.citationStatus, 'valid');
  assert.equal(checked.fieldCompletenessStatus, 'missing_dependencies'); assert.equal(checked.privateDraftAllowed, false);
  assert.ok(Array.isArray(checked.output!.results));
  assert.deepEqual(checked.output!.results.map(result => [result.resultValue.value, result.population.value]), [[17, null], [29, null]]);
  assert.equal(JSON.stringify(output), before);
});

test('h: saved v1/v2/v3 fields/errors/time strings read under their own version; v4 is program managed', () => {
  const { bundle, output, absent } = structuredExtractionFixture(), { input } = extractionPrompt(bundle, '[SYNTHETIC TEST RECORD ONLY]');
  const legacyWire = { groups: output.groups.map(group => ({ ...group, sample: group.sample[0],
    observationTimes: [{ time: { value: 'during procedure', citations: [bundle.fragments[0]!.id] },
      purpose: { value: 'mapping stage', citations: [bundle.fragments[0]!.id] }, outcomeDenominator: absent() }] })) };
  const old = validateCompactExtraction(legacyWire, input).output!;
  assert.equal(old.schemaVersion, 'ep-abstract-extract-v3');
  for (const version of ['ep-abstract-extract-v1', 'ep-abstract-extract-v2', 'ep-abstract-extract-v3'] as const) {
    const saved = structuredClone(old) as any; saved.schemaVersion = version;
    if (version !== 'ep-abstract-extract-v3') for (const group of saved.groups) delete group.observationTimes[0].outcomeDenominator;
    if (version === 'ep-abstract-extract-v1') {
      const toNull = (node: any): any => Array.isArray(node) ? node.map(toNull) : node && typeof node === 'object'
        ? node.value === null ? null : Object.fromEntries(Object.entries(node).map(([key, value]) => [key, toNull(value)])) : node;
      saved.groups = toNull(saved.groups);
    }
    const before = JSON.stringify(saved), fields = extractionFields(readStoredExtractionOutput(saved));
    assert.deepEqual(readStoredExtractionOutput(saved), saved); assert.equal(JSON.stringify(saved), before);
    assert.equal(fields.find(row => row.path === 'observationTimes[0].time')!.value, 'during procedure');
    assert.equal(Object.hasOwn(readStoredExtractionOutput(saved), 'results'), false);
  }
  const checked = validateStructuredExtraction(output, input);
  assert.equal(checked.output!.schemaVersion, EXTRACTION_PROMPT_VERSION);
  assert.ok(structuredStoredExtractionSchema.safeParse(checked.output).success);
  assert.deepEqual(readStoredExtractionOutput(checked.output), checked.output);
  const truncated = validateStructuredExtraction(output, input, { finishReason: 'length' });
  assert.equal(truncated.output, null); assert.equal(truncated.privateDraftAllowed, false);
});

test('current prompt is generated from the same v4 wire definition; existing product guard stays active', () => {
  const { bundle, output, cite } = structuredExtractionFixture(), prompt = extractionPrompt(bundle, '[SYNTHETIC TEST RECORD ONLY]');
  const generated = JSON.parse(prompt.system.split('JSON_SCHEMA:\n')[1]!);
  assert.deepEqual(generated, extractionResponseSchema());
  assert.deepEqual(generated.required, ['overallSample', 'groups', 'results', 'comparisons', 'proceduralContexts', 'observationTimes']);
  assert.equal(JSON.stringify(generated.properties).includes('schemaVersion'), false);
  assert.ok(prompt.system.includes(EXTRACTION_RULES.technology_is_not_product));
  const bad = structuredClone(output) as any; bad.groups[0].productRoles = [cite({ product: 'PFA', role: 'study device' })];
  assert.ok(validateStructuredExtraction(bad, prompt.input).contentIssues.some(issue => issue.code === 'technology_is_not_product'));
});

test('delivered JSON is explicitly a synthetic test record and runs through the production validator without a model', () => {
  const example = JSON.parse(readFileSync(new URL('./fixtures/ep-extraction-structure.TEST.json', import.meta.url), 'utf8'));
  assert.equal(example.recordType, 'SYNTHETIC_TEST_RECORD_ONLY'); assert.equal(example.programValidation.modelRequests, 0);
  assert.equal(Object.hasOwn(example.modelOutput, 'schemaVersion'), false);
  const checked = validateStructuredExtraction(example.modelOutput, example.inputManifest);
  assert.equal(checked.privateDraftAllowed, true); assert.equal(checked.realModelEffectValidated, false);
  assert.equal(checked.output!.schemaVersion, example.programValidation.schemaVersion);
  assert.deepEqual(checked.contentIssues, []);
});
