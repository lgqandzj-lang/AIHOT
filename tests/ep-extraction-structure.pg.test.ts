import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { assertEpTestDatabase } from './fixtures/ep-test-safety.ts';
import { abstractMetadata } from './fixtures/ep-abstract.ts';
import { record } from './fixtures/ep-research.ts';
import { extractionMetadata, fixedExtractionOutput, fixedModelExtractionOutput, fixedCompactExtractionOutput } from './fixtures/ep-extraction.ts';
import { structuredExtractionFixture, ambiguousStructuredFixture } from './fixtures/ep-extraction-structure.ts';
import { importLiteratureMetadata } from '../packages/backend/src/research/metadata-import.ts';
import { buildAbstractMaterialBundle } from '../packages/backend/src/research/abstract-evidence.ts';
import { extractOfflineBundle, readExtractionDraft, extractionFieldReport } from '../packages/backend/src/research/abstract-extraction.ts';
import { saveProduct, saveResearchRecord } from '../packages/backend/src/research/repository.ts';
import { getPublicResearch, listPublicResearch } from '../packages/backend/src/publication/research.ts';
import type { Parameter } from '../packages/backend/src/research/contracts.ts';

assertEpTestDatabase(process.env.DATABASE_URL);
process.env.NODE_ENV = 'test'; process.env.MODEL_CALLS_ENABLED = 'false'; process.env.COLLECT_ENABLED = 'false';
process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
for (const key of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(key)) process.env[key] = 'false';
const { sql, closeDb } = await import('../packages/backend/src/db.ts');
const { researchDatabase } = await import('../packages/backend/src/research/postgres.ts');
const db = researchDatabase(sql), run = 'structure-' + randomUUID().slice(0, 8), productId = run + '-product';
const bundles = new Set<string>(), records = new Set<string>();
const q = <Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values: Parameter[] = []) => db.query<Row>({ text, values });
async function save(fixture: ReturnType<typeof structuredExtractionFixture> | ReturnType<typeof ambiguousStructuredFixture> = structuredExtractionFixture()) {
  const metadata = abstractMetadata('10.9999/' + run + '.' + randomUUID(), fixture.bundle.fragments[0]!.text,
    'plain', { title: '[SYNTHETIC TEST RECORD ONLY] Structure v4' });
  const saved = await importLiteratureMetadata(db, metadata); records.add(saved.recordId!);
  const bundle = await buildAbstractMaterialBundle(db, saved.materialId); bundles.add(bundle.id);
  // Rebind only the supplied synthetic fragment reference after DB creates its ID.
  const bind = (node: unknown): unknown => Array.isArray(node) ? node.map(bind) : node && typeof node === 'object'
    ? Object.fromEntries(Object.entries(node).map(([key, value]) => [key, key === 'citations'
      ? (value as string[]).map(id => id === fixture.bundle.fragments[0]!.id ? bundle.fragments[0]!.id : id) : bind(value)])) : node;
  return { bundle, output: bind(fixture.output) as typeof fixture.output };
}
before(async () => {
  const [info] = await q<{ database: string; storage: string | null }>("SELECT current_database() AS database,to_regclass('ep_research_extraction_drafts')::text AS storage");
  assert.ok(/_(test|ci)$/.test(info!.database) && info!.storage);
  await saveProduct(db, { id: productId, name: '[SYNTHETIC TEST ONLY] Structure', kind: 'catheter' });
});
after(async () => {
  try {
    for (const id of bundles) await q('DELETE FROM ep_research_extraction_drafts WHERE bundle_id=$1::uuid', [id]);
    for (const id of records) await q('DELETE FROM ep_research_records WHERE id=$1::uuid', [id]);
    await q('DELETE FROM ep_products WHERE id=$1', [productId]);
  } finally { await closeDb(); }
});

test('a/b/e/f: v4 counts/results/time roles persist in existing private JSONB; PR1/public output stays identical', async () => {
  const published = await saveResearchRecord(db, record(run + '-published', productId)); records.add(published.id);
  const beforePublic = await getPublicResearch(db, published.id), beforeList = await listPublicResearch(db, { productId });
  const beforeCanonical = await q('SELECT to_jsonb(r) AS row FROM ep_research_records r WHERE id=$1::uuid', [published.id]);
  const { bundle, output } = await save();
  const draft = await extractOfflineBundle(db, bundle.id, async () => output);
  assert.ok(draft.output?.schemaVersion === 'ep-abstract-extract-v4'); assert.equal(draft.state, 'private_draft');
  assert.equal(draft.semanticStatus, 'not_performed'); assert.equal(draft.receiptId, null); assert.equal(draft.trialId, null);
  const read = await readExtractionDraft(db, draft.id); assert.deepEqual(read.output, draft.output);
  const [stored] = await q<{ raw_output: unknown; parsed_output: unknown }>('SELECT raw_output,parsed_output FROM ep_research_extraction_drafts WHERE id=$1::uuid', [draft.id]);
  assert.deepEqual(stored!.raw_output, output); assert.deepEqual(stored!.parsed_output, draft.output);
  const report = await extractionFieldReport(db, draft.id);
  assert.equal(report.fields.find(field => field.groupId === 'overall' && field.path === 'overallSample[1].quantity')!.value, 88);
  assert.equal(report.fields.find(field => field.groupId === 'g1' && field.path === 'sample[0].quantity')!.value, 9);
  assert.equal(report.fields.find(field => field.groupId === 'g2' && field.path === 'results[1].resultValue')!.value, 26);
  assert.equal(report.fields.find(field => field.path === 'results[2].resultValue')!.value, 78.4);
  assert.equal(report.fields.find(field => field.path === 'results[2].outcomeDenominator')!.value, null);
  assert.ok(report.fields.every(field => field.semanticStatus === 'not_evaluated' && field.evidence.every(evidence => evidence.identity === 'valid')));
  assert.deepEqual(await getPublicResearch(db, published.id), beforePublic);
  assert.deepEqual(await listPublicResearch(db, { productId }), beforeList);
  assert.deepEqual(await q('SELECT to_jsonb(r) AS row FROM ep_research_records r WHERE id=$1::uuid', [published.id]), beforeCanonical);
  assert.equal((await q('SELECT id FROM ep_research_arms WHERE record_id=$1::uuid', [published.id])).length, 1);
});

test('d: unresolved ownership is stored with unknown populations and dependency issues; no automatic pair/comparison', async () => {
  const fixture = ambiguousStructuredFixture();
  const { bundle, output: raw } = await save(fixture), draft = await extractOfflineBundle(db, bundle.id, async () => raw);
  assert.equal(draft.state, 'invalid_output'); assert.equal(draft.formatStatus, 'valid'); assert.equal(draft.citationStatus, 'valid');
  assert.equal(draft.fieldCompletenessStatus, 'missing_dependencies');
  assert.equal(draft.issues.filter(issue => issue.includes('local_population_required')).length, 2);
  const read = await readExtractionDraft(db, draft.id); assert.ok(read.output?.schemaVersion === 'ep-abstract-extract-v4');
  assert.ok(Array.isArray(read.output.results));
  assert.deepEqual(read.output.results.map(result => [result.resultValue.value, result.population.value]), [[17, null], [29, null]]);
  const report = await extractionFieldReport(db, draft.id);
  assert.ok(report.fields.filter(field => /results\[\d\]\.resultValue/.test(field.path)).every(field => field.groupId === 'unresolved'));
  assert.equal((read.output.comparisons as any).value, null);
  assert.deepEqual((await q('SELECT raw_output FROM ep_research_extraction_drafts WHERE id=$1::uuid', [draft.id]))[0]!.raw_output, raw);
});

test('c/g: undeclared/record-qualified group references and another bundle citation are rejected without repair', async () => {
  const { bundle, output } = await save(), other = await save();
  const foreignGroup = structuredClone(output) as any; foreignGroup.results[0].population.value.groupId = 'g9';
  const groupDraft = await extractOfflineBundle(db, bundle.id, async () => foreignGroup);
  assert.equal(groupDraft.state, 'invalid_output'); assert.ok(groupDraft.issues.some(issue => issue.includes('local_population_required')));
  const recordQualified = structuredClone(output) as any; recordQualified.results[0].population.value.recordId = randomUUID();
  assert.equal((await extractOfflineBundle(db, bundle.id, async () => recordQualified)).formatStatus, 'invalid');
  const foreignCitation = structuredClone(output); foreignCitation.results[1]!.metric.citations = [other.bundle.fragments[0]!.id];
  const citationDraft = await extractOfflineBundle(db, bundle.id, async () => foreignCitation);
  assert.equal(citationDraft.state, 'invalid_output'); assert.equal(citationDraft.citationStatus, 'invalid'); assert.equal(citationDraft.output, null);
  assert.deepEqual((await q('SELECT raw_output FROM ep_research_extraction_drafts WHERE id=$1::uuid', [citationDraft.id]))[0]!.raw_output, foreignCitation);
});

test('h: old v1/v2/v3 drafts and recorded invalid errors read without any data migration or time/result rewrite', async () => {
  const metadata = extractionMetadata('original', '10.9999/' + run + '.legacy');
  const saved = await importLiteratureMetadata(db, metadata); records.add(saved.recordId!);
  const bundle = await buildAbstractMaterialBundle(db, saved.materialId); bundles.add(bundle.id);
  for (const output of [fixedExtractionOutput(bundle, 'original'), fixedModelExtractionOutput(bundle, 'original'), fixedCompactExtractionOutput(bundle, 'original')]) {
    const draft = await extractOfflineBundle(db, bundle.id, async () => output);
    const before = await q('SELECT to_jsonb(d) AS row FROM ep_research_extraction_drafts d WHERE id=$1::uuid', [draft.id]);
    const read = await readExtractionDraft(db, draft.id), report = await extractionFieldReport(db, draft.id);
    assert.deepEqual(read.output, draft.output); assert.deepEqual(read.issues, draft.issues); assert.equal(read.state, draft.state);
    assert.equal(Object.hasOwn(read.output!, 'results'), false);
    assert.equal(report.fields.find(field => field.groupId === 'g1' && field.path === 'observationTimes[0].time')!.value, '30 days');
    assert.deepEqual(await q('SELECT to_jsonb(d) AS row FROM ep_research_extraction_drafts d WHERE id=$1::uuid', [draft.id]), before);
  }
  const invalid = await extractOfflineBundle(db, bundle.id, async () => ({ malformed: true }));
  const before = await q('SELECT to_jsonb(d) AS row FROM ep_research_extraction_drafts d WHERE id=$1::uuid', [invalid.id]);
  const read = await readExtractionDraft(db, invalid.id); assert.equal(read.state, 'invalid_output'); assert.deepEqual(read.issues, invalid.issues);
  assert.deepEqual(await q('SELECT to_jsonb(d) AS row FROM ep_research_extraction_drafts d WHERE id=$1::uuid', [invalid.id]), before);
});
