import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertEpTestDatabase } from './fixtures/ep-test-safety.ts';
import { record } from './fixtures/ep-research.ts';
import { abstractMetadata, structuredAbstract, methodsText, resultsText } from './fixtures/ep-abstract.ts';
import type { LiteratureMetadata } from '../packages/backend/src/research/metadata.ts';
import type { Parameter } from '../packages/backend/src/research/contracts.ts';
import { importLiteratureMetadata } from '../packages/backend/src/research/metadata-import.ts';
import { splitAbstractMaterial, buildAbstractMaterialBundle, citationForAbstractFragment,
  readAbstractFragment, validateAbstractCitations } from '../packages/backend/src/research/abstract-evidence.ts';
import { saveProduct, saveResearchRecord } from '../packages/backend/src/research/repository.ts';
import { getPublicResearch, listPublicResearch } from '../packages/backend/src/publication/research.ts';

assertEpTestDatabase(process.env.DATABASE_URL);
process.env.NODE_ENV ??= 'test';
process.env.MODEL_CALLS_ENABLED = 'false'; process.env.COLLECT_ENABLED = 'false';
process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
for (const key of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(key)) process.env[key] = 'false';
const { sql, closeDb } = await import('../packages/backend/src/db.ts');
const { researchDatabase } = await import('../packages/backend/src/research/postgres.ts');
const db = researchDatabase(sql);
const run = 'abstract-' + randomUUID().slice(0, 8);
const productId = run + '-product';
const records = new Set<string>();
const doi = (name: string) => '10.9999/' + run + '.' + name;
const q = <Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: Parameter[] = []) => db.query<Row>({ text, values });
async function save(metadata: LiteratureMetadata) {
  const result = await importLiteratureMetadata(db, metadata);
  assert.ok(result.recordId); records.add(result.recordId);
  return result;
}
before(async () => {
  const [info] = await q<{database:string;version:string;fragments:string|null}>(`SELECT current_database() AS database,
    current_setting('server_version') AS version,to_regclass('ep_research_abstract_fragments')::text AS fragments`);
  assert.ok(info && /_(test|ci)$/.test(info.database) && info.version.startsWith('17.') && info.fragments);
  await saveProduct(db, { id: productId, name: '[SYNTHETIC] Evidence product', kind: 'catheter' });
});
after(async () => {
  try {
    for (const id of records) await q('DELETE FROM ep_research_records WHERE id=$1::uuid', [id]);
    await q('DELETE FROM ep_products WHERE id=$1', [productId]);
  } finally { await closeDb(); }
});

test('same material/rule splits idempotently and concurrent requests reuse stable fragment IDs', async () => {
  const saved = await save(abstractMetadata(doi('repeat'), structuredAbstract, 'jats'));
  const outputs = await Promise.all([splitAbstractMaterial(db, saved.materialId), splitAbstractMaterial(db, saved.materialId)]);
  assert.deepEqual(outputs[0], outputs[1]);
  assert.equal(outputs[0]?.fragments.length, 2);
  assert.deepEqual((await splitAbstractMaterial(db, saved.materialId)).fragments, outputs[0]?.fragments);
  const [count] = await q<{count:number}>('SELECT count(*)::int AS count FROM ep_research_abstract_fragments WHERE material_id=$1::uuid', [saved.materialId]);
  assert.equal(count?.count, 2);
  assert.deepEqual(outputs[0]?.fragments.map(item => [item.ordinal,item.sectionLabel,item.scope,item.text]),
    [[1,'Methods','abstract',methodsText],[2,'Results','abstract',resultsText]]);
});
test('a new material version and rule version keep old citations readable with old content', async () => {
  const input = abstractMetadata(doi('versions'), structuredAbstract, 'jats');
  const old = await save(input);
  const oldBundle = await buildAbstractMaterialBundle(db, old.materialId);
  const oldReference = citationForAbstractFragment(oldBundle.fragments[0]!);
  const next = await save({ ...input, abstract: '<p>New synthetic text: 9 mg did not change.</p>', versionLabel: 'synthetic-v2' });
  assert.notEqual(next.materialId, old.materialId);
  const newBundle = await buildAbstractMaterialBundle(db, next.materialId);
  assert.notEqual(newBundle.materialHash, oldBundle.materialHash);
  assert.equal((await readAbstractFragment(db, oldBundle.id, oldReference)).text, methodsText);
  await assert.rejects(readAbstractFragment(db, newBundle.id, oldReference), /material mismatch/);
  await assert.rejects(readAbstractFragment(db, oldBundle.id, { ...oldReference, materialHash: newBundle.materialHash }), /material version mismatch/);
  const newRule = await buildAbstractMaterialBundle(db, old.materialId, { ruleVersion: 'abstract-source-v2' });
  assert.notEqual(newRule.fragments[0]?.id, oldReference.fragmentId);
  assert.equal(newRule.materialHash, oldBundle.materialHash);
  await assert.rejects(readAbstractFragment(db, newRule.id, oldReference), /split rule version mismatch/);
  assert.equal((await readAbstractFragment(db, oldBundle.id, oldReference)).text, methodsText);
});
test('legacy unstructured paragraphs and empty metadata produce explicit private material states', async () => {
  const legacy = await save(abstractMetadata(doi('plain'), 'First synthetic paragraph: 5 mg did not change.\n\nSecond paragraph: no value was inferred.'));
  const bundle = await buildAbstractMaterialBundle(db, legacy.materialId);
  assert.equal(bundle.fragments.length, 2);
  assert.deepEqual(bundle.fragments.map(item => item.sectionLabel), [null,null]);
  const empty = await save(abstractMetadata(doi('empty'), null));
  assert.equal((await splitAbstractMaterial(db, empty.materialId)).state, 'empty_abstract');
  const emptyBundle = await buildAbstractMaterialBundle(db, empty.materialId);
  assert.equal(emptyBundle.state, 'empty_abstract');
  assert.deepEqual(emptyBundle.providedFragmentIds, []); assert.deepEqual(emptyBundle.fragments, []);
  const [count] = await q<{count:number}>('SELECT count(*)::int AS count FROM ep_research_abstract_fragments WHERE material_id=$1::uuid',[empty.materialId]);
  assert.equal(count?.count, 0);
});
test('only provided citations pass; missing, cross-material, forged and excluded identities are rejected', async () => {
  const saved = await save(abstractMetadata(doi('membership'), structuredAbstract, 'jats'));
  const split = await splitAbstractMaterial(db, saved.materialId);
  const [methods, results] = split.fragments;
  assert.ok(methods && results);
  const bundle = await buildAbstractMaterialBundle(db, saved.materialId, { fragmentIds: [methods.id] });
  assert.deepEqual(bundle.fragments, [methods]);
  assert.deepEqual(await validateAbstractCitations(db, bundle.id, [citationForAbstractFragment(methods)]),
    { checked: 1, identitiesValidated: true, semanticsValidated: false });
  const reference = citationForAbstractFragment(methods);
  await assert.rejects(readAbstractFragment(db, bundle.id, { ...reference, fragmentId: randomUUID() }), /Unknown abstract fragment/);
  await assert.rejects(readAbstractFragment(db, randomUUID(), reference), /Unknown abstract bundle/);
  await assert.rejects(readAbstractFragment(db, bundle.id, { ...reference, fragmentHash: '0'.repeat(64) }), /fragment fingerprint mismatch/);
  bundle.providedFragmentIds.push(results.id); // Caller mutation cannot widen the persisted manifest.
  await assert.rejects(validateAbstractCitations(db, bundle.id, [citationForAbstractFragment(results)]), /not provided/);
  const other = await save(abstractMetadata(doi('other'), 'Other synthetic abstract.'));
  const otherBundle = await buildAbstractMaterialBundle(db, other.materialId);
  await assert.rejects(validateAbstractCitations(db, bundle.id, [citationForAbstractFragment(otherBundle.fragments[0]!)]), /material mismatch/);
  await assert.rejects(buildAbstractMaterialBundle(db, saved.materialId, { fragmentIds: [otherBundle.fragments[0]!.id] }), /outside/);
  const omitted = await buildAbstractMaterialBundle(db, saved.materialId, { fragmentIds: [] });
  assert.equal(omitted.state, 'no_fragments_selected');
  await assert.rejects(readAbstractFragment(db, omitted.id, reference), /not provided/);
});
test('source sections from new metadata retain labels but never become full-text Methods', async () => {
  const saved = await save(abstractMetadata(doi('source-labels'), 'Methods: ' + methodsText + '\nCustom results: ' + resultsText, 'plain',
    { abstractSections: [{ label: 'Methods', text: methodsText }, { label: 'Custom results', text: resultsText }] }));
  const bundle = await buildAbstractMaterialBundle(db, saved.materialId);
  assert.deepEqual(bundle.fragments.map(item => [item.sectionLabel,item.text,item.scope]),
    [['Methods',methodsText,'abstract'],['Custom results',resultsText,'abstract']]);
  assert.equal(bundle.scope, 'abstract'); assert.equal(bundle.fullTextProvided, false);
  assert.equal(bundle.processingAuthorization, 'not_evaluated');
  const [row] = await q<{state:string;allowed:boolean;drafts:number}>(`SELECT publication_state AS state,metadata_public_allowed AS allowed,
    (SELECT count(*)::int FROM ep_research_revision_drafts WHERE record_id=r.id) AS drafts FROM ep_research_records r WHERE id=$1::uuid`,[saved.recordId!]);
  assert.deepEqual(row, { state: 'draft', allowed: false, drafts: 0 });
});
test('private fragments leave existing public card/search, permissions and material payload unchanged', async () => {
  const articleDoi = doi('public');
  const publicRecord = await saveResearchRecord(db, record(run + ':public', productId, { doi: articleDoi }));
  records.add(publicRecord.id);
  const source = await save(abstractMetadata(articleDoi, structuredAbstract, 'jats'));
  const beforeCard = await getPublicResearch(db, publicRecord.id);
  const beforeSearch = await listPublicResearch(db, { productId });
  const [beforeMaterial] = await q('SELECT to_jsonb(m) AS material FROM ep_research_materials m WHERE id=$1::uuid',[source.materialId]);
  const [beforeRecord] = await q('SELECT to_jsonb(r) AS record FROM ep_research_records r WHERE id=$1::uuid',[publicRecord.id]);
  await buildAbstractMaterialBundle(db, source.materialId);
  assert.deepEqual(await getPublicResearch(db, publicRecord.id), beforeCard);
  assert.deepEqual(await listPublicResearch(db, { productId }), beforeSearch);
  assert.ok(!JSON.stringify(beforeSearch).includes(methodsText));
  assert.deepEqual((await q('SELECT to_jsonb(m) AS material FROM ep_research_materials m WHERE id=$1::uuid',[source.materialId]))[0], beforeMaterial);
  assert.deepEqual((await q('SELECT to_jsonb(r) AS record FROM ep_research_records r WHERE id=$1::uuid',[publicRecord.id]))[0], beforeRecord);
  const viewColumns = await q<{column_name:string}>(`SELECT column_name FROM information_schema.columns WHERE table_name LIKE 'ep_public_%'`);
  assert.ok(!viewColumns.some(row => /fragment|abstract|provided_fragment/.test(row.column_name)));
});
test('corrupted material/fragment fingerprints are refused rather than returning altered evidence', async () => {
  const input = abstractMetadata(doi('corrupt'), 'Original synthetic abstract: no change.');
  const saved = await save(input);
  const bundle = await buildAbstractMaterialBundle(db, saved.materialId);
  const reference = citationForAbstractFragment(bundle.fragments[0]!);
  await q('UPDATE ep_research_abstract_fragments SET fragment_text=$2 WHERE id=$1::uuid',[reference.fragmentId,'Changed synthetic text.']);
  await assert.rejects(readAbstractFragment(db, bundle.id, reference), /Stored fragment fingerprint mismatch/);
  await q('UPDATE ep_research_materials SET metadata=$2::jsonb WHERE id=$1::uuid',
    [saved.materialId, JSON.parse(JSON.stringify({ ...input, abstract: 'Altered material.' })) as Parameter]);
  await assert.rejects(splitAbstractMaterial(db, saved.materialId), /Material fingerprint mismatch/);
});
