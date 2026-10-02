import assert from 'node:assert/strict';
import { test } from 'node:test';
import { structuredExtractionFixture, ambiguousStructuredFixture } from './fixtures/ep-extraction-structure.ts';
import { extractionPrompt } from '../packages/backend/src/research/extraction-schema.ts';
import { structuredPrivateReadingView } from '../packages/backend/src/research/private-reading-view.ts';

test('read organization preserves distinct count containers and one record per result without mutating saved values', () => {
  const fixture = structuredExtractionFixture(), input = extractionPrompt(fixture.bundle, '[SYNTHETIC TEST ONLY]').input;
  const before = structuredClone(fixture.output), view = structuredPrivateReadingView(fixture.output, input);
  assert.deepEqual(view.overallCounts.map(count => [count.quantity.value, count.unit.value]), [[22, 'participants'], [88, 'pulmonary veins']]);
  assert.deepEqual(view.groups.map(group => group.counts.map(count => count.quantity.value)), [[9, 36], [13, 52]]);
  assert.deepEqual(view.results.map(result => [result.id, result.groupId, result.resultValue.value]), [['r1', 'g1', 48], ['r2', 'g2', 26], ['r3', 'g1', 78.4]]);
  assert.equal(view.results[2].outcomeDenominator.value, null);
  assert.equal(view.results[2].outcomeDenominator.absence, 'not_reported');
  assert.equal(view.results[2].windows.length, 1);
  assert.equal(view.groups[0].contexts.length, 1);
  assert.equal(view.groups[0].methods.length, 0);
  assert.deepEqual(fixture.output, before);
});

test('outcome quantity is retained in its result, never converted into a sample or an invented denominator', () => {
  const fixture = structuredExtractionFixture(), input = extractionPrompt(fixture.bundle, '[SYNTHETIC TEST ONLY]').input;
  Object.assign(fixture.output.results[2], { population: fixture.cite({ scope: 'overall' }), metric: fixture.cite('treated vessels'),
    resultValue: fixture.cite(61), unit: fixture.cite('vessels'), numerator: fixture.cite(61), countUnit: fixture.cite('vessels') });
  const view = structuredPrivateReadingView(fixture.output, input);
  const result = view.results.find(result => result.id === 'r3')!;
  assert.equal(result.groupId, 'overall');assert.equal(result.numerator.value, 61);assert.equal(result.outcomeDenominator.value, null);
  assert.ok(!view.overallCounts.some(count => count.quantity.value === 61));
  assert.equal(view.results.filter(result => result.id === 'r3').length, 1);
});

test('unknown ownership and duplicate IDs never become readable group-linked results', () => {
  const fixture = ambiguousStructuredFixture(), input = extractionPrompt(fixture.bundle, '[SYNTHETIC TEST ONLY]').input;
  assert.deepEqual(structuredPrivateReadingView(fixture.output, input).results, []);
  const known = structuredExtractionFixture(), knownInput = extractionPrompt(known.bundle, '[SYNTHETIC TEST ONLY]').input;
  known.output.results[1].resultId = known.output.results[0].resultId;
  const view = structuredPrivateReadingView(known.output, knownInput);
  assert.ok(!view.results.some(result => result.id === 'r1'));assert.deepEqual(view.comparisons, []);
});

test('an invalid optional field only leaves that field out, and one group uses the same projection', () => {
  const fixture = structuredExtractionFixture(), input = extractionPrompt(fixture.bundle, '[SYNTHETIC TEST ONLY]').input;
  const raw: any = structuredClone(fixture.output);
  raw.groups = raw.groups.slice(0, 1);raw.groups[0].imagingMethods = { value: 'bad wrapper', citations: [] };
  raw.results = [raw.results[0]];raw.comparisons = fixture.absent();raw.observationTimes = fixture.absent();
  const view = structuredPrivateReadingView(raw, input);
  assert.equal(view.groups.length, 1);assert.equal(view.results.length, 1);assert.equal(view.groups[0].methods.length, 0);
  assert.equal(view.results[0].groupId, 'g1');
});
