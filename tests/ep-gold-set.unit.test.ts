import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { goldPhaseStatus, observedCounts, parseGoldSet, scoreGoldCounts, type GoldSetFile } from '../packages/backend/src/research/gold-set.ts';
import { goldStatusText } from '../scripts/ep-gold-set.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = () => parseGoldSet(JSON.parse(readFileSync(path.join(root, 'docs/gold/varipulse-candidates.json'), 'utf8')));

function cited(value: string | number) {
  return { value, citations: ['fragment-1'] };
}
function study(counts: GoldSetFile['records'][number]['counts'] = []): GoldSetFile {
  return {
    version: 'ep-gold-set-v1',
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
      proposals: [],
    }],
  };
}
const attested = {
  materialScope: 'abstract' as const,
  groupLabel: 'treated',
  quantity: 35,
  unit: 'patients',
  populationScope: 'consecutive patients undergoing pulmonary vein isolation',
  locator: 'abstract methods: 35 consecutive patients',
  attestor: 'Fixture Owner',
  attestedOn: '2026-10-02',
};

test('the checked-in VARIPULSE list has bibliography only and is not a completed gold set', () => {
  const gold = live();
  const status = goldPhaseStatus(gold);
  assert.equal(gold.query, 'VARIPULSE[Title]');
  assert.equal(status.eligibleStudies, 13);
  assert.equal(status.attestedPapers, 0);
  assert.equal(status.attestedRows, 0);
  assert.equal(status.complete, false);
  assert.equal(status.proposedPapers, 5);
  assert.equal(gold.records.find(record => record.pmid === '41129023')?.proposals.find(row => row.quantity === 121)?.unit, 'patients');
  for (const pmid of ['42360258', '41993940', '41854989', '40115621', '42739841', '41536863', '40412874', '39004800']) {
    assert.equal(gold.records.find(record => record.pmid === pmid)?.proposals.length, 0);
  }
  assert.equal(gold.records.find(record => record.pmid === '3736805')?.eligibility, 'excluded');
  assert.equal(gold.records.find(record => record.pmid === '39702987')?.eligibility, 'excluded');
  assert.ok(gold.records.filter(record => record.eligibility === 'study').every(record => record.counts.length === 0));
  assert.match(goldStatusText(JSON.stringify(gold)), /phase 3 complete: false/);
});

test('an agent cannot attest, and a partial count is rejected', () => {
  assert.throws(() => parseGoldSet(study([{ ...attested, attestor: 'extraction model' }])));
  assert.throws(() => parseGoldSet(study([{ ...attested, attestor: 'Cursor agent' }])));
  const partial = study([]);
  (partial.records[0].counts as unknown[]) = [{ ...attested, locator: '' }];
  assert.throws(() => parseGoldSet(partial));
  const excluded = study();
  excluded.records[0].eligibility = 'excluded';
  excluded.records[0].exclusion = 'unrelated product';
  excluded.records[0].counts = [attested];
  assert.throws(() => parseGoldSet(excluded));
});

test('recall counts only attested rows and does not borrow another sample', () => {
  const gold = study([attested, { ...attested, groupLabel: 'veins', quantity: 140, unit: 'pulmonary veins', populationScope: 'veins targeted in the same 35 patients', locator: 'abstract results: 140 pulmonary veins' }]);
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
  assert.equal(score.attestedRows, 2);
  assert.equal(score.hits, 1);
  assert.equal(score.recall, 0.5);
  const proposed = study();
  proposed.records[0].proposals = [{
    materialScope: 'abstract', groupLabel: 'treated', quantity: 35, unit: 'patients',
    populationScope: 'consecutive patients undergoing pulmonary vein isolation',
    locator: 'abstract methods: 35 consecutive patients', source: 'pubmed-abstract', retrievedOn: '2026-10-02',
  }];
  assert.equal(scoreGoldCounts(parseGoldSet(proposed), observed).recall, null);
  assert.equal(goldPhaseStatus(parseGoldSet(proposed)).attestedPapers, 0);
  assert.equal(goldPhaseStatus(parseGoldSet(proposed)).proposedRows, 1);
});
