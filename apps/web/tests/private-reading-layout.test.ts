import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readingResultRows } from '../app/features/research/private-reading-layout.ts';
import type { PrivateReadingView } from '../app/features/research/contracts.ts';

const value = (value: string | number | null) => ({ value, absence: value === null ? 'unknown' as const : null });
const result = (id: string, groupId: string, metric: string, amount: number, unit = 'minutes'): PrivateReadingView['results'][number] => ({ id, groupId, kind: 'duration',
  metric: value(metric), resultValue: value(amount), unit: value(unit), statistic: value(null), numerator: value(null), outcomeDenominator: value(null), countUnit: value(null), windows: [], evidence: [] });
const view = (results: PrivateReadingView['results']): PrivateReadingView => ({ overallCounts: [], comparisons: [], results,
  groups: ['g1', 'g2'].map(id => ({ id, label: id, subjects: null, counts: [], methods: [], contexts: [], evidence: [] })) });

test('exact metric and declared owners pair independently of result order and numeric magnitude', () => {
  const saved = view([result('r4', 'g2', 'dwell', 92), result('r1', 'g1', 'procedure', 8), result('r3', 'g1', 'dwell', 3), result('r2', 'g2', 'procedure', 120)]);
  const before = structuredClone(saved), rows = readingResultRows(saved);
  assert.deepEqual(rows.map(row => row.results.map(result => result.id)), [['r3', 'r4'], ['r1', 'r2']]);
  assert.ok(rows.every(row => row.paired));assert.deepEqual(saved, before);
  assert.equal(rows.flatMap(row => row.results).length, saved.results.length);
});

test('different metrics or units, ambiguous duplicates, and overall results cannot be aligned as group comparisons', () => {
  for (const results of [
    [result('r1', 'g1', 'procedure', 8), result('r2', 'g2', 'dwell', 8)],
    [result('r1', 'g1', 'procedure', 8, 'minutes'), result('r2', 'g2', 'procedure', 8, 'seconds')],
    [result('r1', 'g1', 'procedure', 8), result('r2', 'g1', 'procedure', 2), result('r3', 'g2', 'procedure', 12)],
    [result('r1', 'overall', 'procedure', 8), result('r2', 'g2', 'procedure', 8)],
  ]) { const rows = readingResultRows(view(results));assert.ok(rows.every(row => !row.paired));assert.equal(rows.flatMap(row => row.results).length, results.length); }
});

test('different reported statistics or outcome windows do not become comparable by sharing a metric name', () => {
  const first = result('r1', 'g1', 'procedure', 8), second = result('r2', 'g2', 'procedure', 12);
  first.statistic = value('mean');second.statistic = value('median');
  assert.ok(readingResultRows(view([first, second])).every(row => !row.paired));
  first.statistic = second.statistic;
  first.kind = second.kind = 'outcome';first.metric = second.metric = value('owned endpoint');
  first.windows = [{ key: 'owned-window-one', value: '3–3 months · after procedure', evidence: [] }];
  second.windows = [{ key: 'owned-window-two', value: '12–12 months · after procedure', evidence: [] }];
  assert.ok(readingResultRows(view([first, second])).every(row => !row.paired));
});
