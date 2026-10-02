import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { goldPhaseStatus, observedCounts, parseGoldSet, scoreGoldCounts, type GoldCount, type GoldSetFile } from '../packages/backend/src/research/gold-set.ts';
import { goldStatusText } from '../scripts/ep-gold-set.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = () => parseGoldSet(JSON.parse(readFileSync(path.join(root, 'docs/gold/varipulse-candidates.json'), 'utf8')));

function cited(value: string | number) {
  return { value, citations: ['fragment-1'] };
}
const count = (quantity: number, unit = 'patients', populationScope = 'consecutive patients undergoing pulmonary vein isolation'): GoldCount => ({
  materialScope: 'abstract',
  groupLabel: 'treated',
  quantity,
  unit,
  populationScope,
  locator: `abstract methods: ${quantity} consecutive patients`,
  source: 'pubmed-abstract',
  retrievedOn: '2026-10-02',
});
function study(counts: GoldCount[] = []): GoldSetFile {
  return {
    version: 'ep-gold-set-v2',
    productId: 'varipulse',
    query: 'VARIPULSE[Title]',
    retrievedOn: '2026-10-02',
    pubmedCount: 1,
    records: [{
      pmid: '41129023',
      doi: '10.1007/s10840-025-02162-0',
      title: 'Owned synthetic title',
      journal: 'Synthetic Journal',
      published: '2026 Mar',
      pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/41129023/',
      eligibility: 'study',
      exclusion: null,
      counts,
    }],
  };
}

test('checked-in VARIPULSE counts come from abstract sentences', () => {
  const gold = live();
  const status = goldPhaseStatus(gold);
  assert.equal(gold.version, 'ep-gold-set-v2');
  assert.equal(gold.query, 'VARIPULSE[Title/Abstract]');
  assert.equal(status.eligibleStudies, 63);
  assert.equal(status.papersWithCounts, 30);
  assert.equal(status.countRows, 48);
  assert.equal(gold.records.find(record => record.pmid === '41732239')?.counts[0]?.quantity, 387);
  assert.equal(gold.records.find(record => record.pmid === '41357273')?.counts[0]?.quantity, 38);
  assert.equal(gold.records.find(record => record.pmid === '39820338')?.counts[0]?.quantity, 169);
  assert.equal(gold.records.find(record => record.pmid === '42644576')?.counts.length, 0);
  assert.equal(gold.records.find(record => record.pmid === '41129023')?.counts.find(row => row.quantity === 121)?.unit, 'patients');
  for (const pmid of ['42360258', '41993940', '41854989', '40115621', '42739841', '41536863', '40412874', '39004800']) {
    assert.equal(gold.records.find(record => record.pmid === pmid)?.counts.length, 0);
  }
  assert.equal(gold.records.find(record => record.pmid === '3736805')?.eligibility, 'excluded');
  assert.equal(gold.records.find(record => record.pmid === '39702987')?.eligibility, 'excluded');
  assert.match(goldStatusText(JSON.stringify(gold)), /papers with counts: 30/);
});

test('a count without its abstract sentence is rejected', () => {
  assert.throws(() => parseGoldSet(study([{ ...count(35), locator: 'too short' }])));
  assert.throws(() => parseGoldSet(study([{ ...count(35), source: 'model' as 'pubmed-abstract' }])));
  const excluded = study([count(35)]);
  excluded.records[0].eligibility = 'excluded';
  excluded.records[0].exclusion = 'unrelated product';
  assert.throws(() => parseGoldSet(excluded));
});

test('recall matches a count only when quantity, unit and population scope agree', () => {
  const gold = study([
    count(35),
    { ...count(140, 'pulmonary veins', 'veins targeted in the same 35 patients'), groupLabel: 'veins', locator: 'abstract results: 140 pulmonary veins' },
  ]);
  const observed = observedCounts({
    overallSample: { value: null, citations: [], status: 'not_reported' },
    groups: [{
      sample: [
        { quantity: cited(35), unit: cited('Patients'), denominator: cited('Consecutive patients undergoing pulmonary vein isolation') },
        { quantity: cited(10), unit: cited('patients'), denominator: cited('a different cohort') },
      ],
    }],
  });
  const score = scoreGoldCounts(parseGoldSet(gold), observed);
  assert.equal(score.rows, 2);
  assert.equal(score.hits, 1);
  assert.equal(score.recall, 0.5);
  assert.equal(scoreGoldCounts(parseGoldSet(study()), observed).recall, null);
});
