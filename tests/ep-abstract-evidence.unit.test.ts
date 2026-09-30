import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jatsAbstractSections, splitAbstractText, pubmedAbstractSections } from '../packages/backend/src/research/abstract-text.ts';
import { fetchPubmedMetadata, normalizeMetadata } from '../packages/backend/src/research/metadata.ts';
import { inputFingerprint } from '../packages/backend/src/research/normalize.ts';
import { abstractMetadata, structuredAbstract, methodsText, resultsText } from './fixtures/ep-abstract.ts';
import { fixturePmid, pubmedResponse } from './fixtures/ep-metadata.ts';

test('structured JATS preserves inline order, numbers, units, negation and source labels', () => {
  assert.deepEqual(jatsAbstractSections(structuredAbstract), [
    { label: 'Methods', text: methodsText }, { label: 'Results', text: resultsText },
  ]);
  assert.deepEqual(jatsAbstractSections('<sec sec-type="methods"><p>No 5 mg change.</p></sec>'),
    [{ label: 'methods', text: 'No 5 mg change.' }]);
});
test('unstructured paragraphs and a whole unlabelled abstract retain their text', () => {
  const metadata = abstractMetadata('10.9999/plain-fixture', 'First: 5 mg did not change.\n\nSecond: 2 mm preceded 3 mm.');
  assert.deepEqual(splitAbstractText(metadata), [
    { label: null, text: 'First: 5 mg did not change.' }, { label: null, text: 'Second: 2 mm preceded 3 mm.' },
  ]);
  assert.deepEqual(splitAbstractText({ ...metadata, abstract: 'One line\ncontinues without a source label.' }),
    [{ label: null, text: 'One line\ncontinues without a source label.' }]);
});
test('legacy material without section metadata remains fingerprint-compatible and labelled', () => {
  const legacy = abstractMetadata('10.9999/legacy-fixture', 'Methods: ' + methodsText + '\nResults: ' + resultsText);
  const normalized = normalizeMetadata(legacy);
  assert.ok(!('abstractSections' in normalized));
  assert.equal(inputFingerprint(normalized), inputFingerprint(legacy));
  assert.deepEqual(splitAbstractText(normalized), [
    { label: 'Methods', text: 'Methods: ' + methodsText }, { label: 'Results', text: 'Results: ' + resultsText },
  ]);
});
test('empty abstract returns no invented sections', () => {
  assert.deepEqual(splitAbstractText(abstractMetadata('10.9999/empty-fixture', null)), []);
  assert.deepEqual(jatsAbstractSections('<jats:p> </jats:p>'), []);
});
test('PubMed source labels and mixed text survive parsing; external DTD is not fetched', async () => {
  const xml = pubmedResponse.replace('<PubmedArticleSet>', '<!DOCTYPE PubmedArticleSet SYSTEM "https://example.invalid/never-fetch.dtd"><PubmedArticleSet>')
    .replace('<Abstract><AbstractText Label="Background">Fixed abstract text for offline testing.</AbstractText></Abstract>',
      '<Abstract><AbstractText Label="Methods">No <i>sample</i> received &#x2265;5&nbsp;mg; 2 mm preceded <b>3</b> mm.</AbstractText><AbstractText Label="Custom outcome">10% did <i>not</i> change.</AbstractText></Abstract>');
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(xml, { status: 200 }); }) as typeof fetch;
  const metadata = await fetchPubmedMetadata(fixturePmid, { fetcher, now: () => new Date('2026-09-30T14:00:00Z') });
  assert.equal(calls, 1);
  assert.deepEqual(metadata.abstractSections, [{ label: 'Methods', text: methodsText }, { label: 'Custom outcome', text: '10% did not change.' }]);
  assert.equal(metadata.abstract, 'Methods: ' + methodsText + '\nCustom outcome: 10% did not change.');
  assert.deepEqual(splitAbstractText(metadata), metadata.abstractSections);
});
test('section text inconsistent with its material snapshot is rejected', () => {
  const metadata = abstractMetadata('10.9999/mismatch-fixture', 'Methods: Original synthetic text.', 'plain',
    { abstractSections: [{ label: 'Methods', text: 'Different text.' }] });
  assert.throws(() => normalizeMetadata(metadata), /do not match/);
});
test('source superscripts/subscripts retain explicit numeric notation and unlabelled source categories', () => {
  const xml = '<PubmedArticleSet><PubmedArticle><MedlineCitation><Article><Abstract><AbstractText NlmCategory="METHODS">At 10<sup>&#x2212;3</sup> mmol L<sup>−1</sup>, H<sub>2</sub>O did not change.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>';
  assert.deepEqual(pubmedAbstractSections(xml), [{ label: 'METHODS', text: 'At 10^(−3) mmol L^(−1), H_(2)O did not change.' }]);
  assert.deepEqual(jatsAbstractSections('<p>10<sup>-3</sup> mg did not change.</p>'),
    [{ label: null, text: '10^(-3) mg did not change.' }]);
});
test('invalid XML and internal entity definitions are rejected without flattening partial text', () => {
  assert.throws(() => jatsAbstractSections('<p>5 mg</broken>'), /Invalid abstract XML/);
  assert.throws(() => pubmedAbstractSections('<!DOCTYPE x [<!ENTITY x "hidden">]><x>&x;</x>'), /unsupported/);
});
