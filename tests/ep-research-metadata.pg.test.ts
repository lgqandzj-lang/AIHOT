import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertEpTestDatabase } from './fixtures/ep-test-safety.ts';
import { record } from './fixtures/ep-research.ts';
import type { LiteratureMetadata } from '../packages/backend/src/research/metadata.ts';
import { importLiteratureMetadata } from '../packages/backend/src/research/metadata-import.ts';
import { saveProduct, saveResearchRecord } from '../packages/backend/src/research/repository.ts';
import { getPublicResearch } from '../packages/backend/src/publication/research.ts';

assertEpTestDatabase(process.env.DATABASE_URL);
process.env.NODE_ENV ??= 'test';
process.env.MODEL_CALLS_ENABLED = 'false';
process.env.COLLECT_ENABLED = 'false';
process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
for (const key of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(key)) process.env[key] = 'false';
const { sql, closeDb } = await import('../packages/backend/src/db.ts');
const { researchDatabase } = await import('../packages/backend/src/research/postgres.ts');
const db = researchDatabase(sql);
const run = 'pr2a-' + randomUUID().slice(0, 8);
const productId = run + '-product';
const records = new Set<string>();
const materials = new Set<string>();
let nextPmid = 81000000 + Math.floor(Math.random() * 1000000);
const pmid = () => String(nextPmid++);
const doi = (name: string) => '10.9999/' + run + '.' + name;
const q = <Row extends Record<string, unknown> = Record<string, unknown>>(
  text: string, values: (string | number | boolean | null)[] = [],
) => db.query<Row>({ text, values });
function snapshot(
  provider: 'crossref' | 'pubmed', providerId: string, values: Partial<LiteratureMetadata> = {},
): LiteratureMetadata {
  const articleDoi = provider === 'crossref' ? providerId : values.doi ?? null;
  const articlePmid = provider === 'pubmed' ? providerId : values.pmid ?? null;
  return {
    provider, providerId,
    sourceUrl: provider === 'crossref'
      ? 'https://api.crossref.org/works/' + encodeURIComponent(providerId)
      : 'https://pubmed.ncbi.nlm.nih.gov/' + providerId + '/',
    acquiredAt: '2026-09-30T02:30:00.000Z',
    doi: articleDoi, pmid: articlePmid,
    title: '[SYNTHETIC] ' + providerId,
    authors: ['Test Author'], journal: 'Fixture Journal',
    publishedYear: 2025, publishedOn: '2025-10-23',
    abstract: null, abstractFormat: null, abstractLocator: null,
    versionLabel: 'fixture-v1', ...values,
  };
}
async function save(input: LiteratureMetadata) {
  const result = await importLiteratureMetadata(db, input);
  if (result.recordId) records.add(result.recordId);
  materials.add(result.materialId);
  return result;
}

before(async () => {
  const [info] = await q<{database:string;version:string;materials:string|null}>(`
    SELECT current_database() AS database,current_setting('server_version') AS version,
      to_regclass('ep_research_materials')::text AS materials`);
  assert.ok(info && /_(test|ci)$/.test(info.database) && info.version.startsWith('17.') && info.materials);
  await saveProduct(db, { id: productId, name: '[SYNTHETIC] VARIPULSE', kind: 'catheter' });
});
after(async () => {
  try {
    for (const id of records) await q('DELETE FROM ep_research_records WHERE id=$1::uuid', [id]);
    for (const id of materials) await q('DELETE FROM ep_research_materials WHERE id=$1::uuid AND record_id IS NULL', [id]);
    await q('DELETE FROM ep_products WHERE id=$1', [productId]);
  } finally { await closeDb(); }
});

test('new DOI metadata stays private; identical reimport is idempotent', async () => {
  const input = snapshot('crossref', doi('first'));
  const first = await save(input);
  const second = await save({ ...input, acquiredAt: '2026-10-01T02:30:00.000Z' });
  assert.equal(first.status, 'created');
  assert.equal(second.status, 'unchanged');
  assert.equal(first.recordId, second.recordId);
  assert.equal(first.materialId, second.materialId);
  const [row] = await q<{publication_state:string;study_design:string;metadata_public_allowed:boolean;material_count:number;draft_count:number}>(`
    SELECT r.publication_state,r.study_design,r.metadata_public_allowed,
      (SELECT count(*)::int FROM ep_research_materials WHERE record_id=r.id) AS material_count,
      (SELECT count(*)::int FROM ep_research_revision_drafts WHERE record_id=r.id) AS draft_count
    FROM ep_research_records r WHERE r.id=$1::uuid`, [first.recordId!]);
  assert.deepEqual([row?.publication_state, row?.study_design, row?.metadata_public_allowed,
    row?.material_count, row?.draft_count], ['draft', 'unknown', false, 1, 0]);
  const [material] = await q<{source_url:string;acquired_at:string;metadata:LiteratureMetadata}>(`
    SELECT source_url,acquired_at::text,metadata FROM ep_research_materials WHERE id=$1::uuid`, [first.materialId]);
  assert.equal(material?.metadata.authors[0], 'Test Author');
  assert.equal(material?.metadata.abstract, null);
  assert.match(material?.acquired_at ?? '', /2026-09-30/);
  assert.equal(await getPublicResearch(db, first.recordId!), null);
});

test('PubMed source, abstract, and later material version create explicit drafts', async () => {
  const articleDoi = doi('supplement');
  const articlePmid = pmid();
  const first = await save(snapshot('crossref', articleDoi));
  const extra = snapshot('pubmed', articlePmid, {
    doi: articleDoi, title: '[SYNTHETIC] ' + articleDoi,
    abstract: 'Fixed abstract for offline regression.', abstractFormat: 'plain',
    abstractLocator: 'PubMed:Article.Abstract',
  });
  const second = await save(extra);
  assert.equal(second.status, 'revision_draft');
  assert.equal(second.recordId, first.recordId);
  assert.ok(second.draftId);
  const repeated = await save({ ...extra, acquiredAt: '2026-10-03T00:00:00.000Z' });
  assert.equal(repeated.status, 'unchanged');
  assert.equal(repeated.materialId, second.materialId);
  assert.equal(repeated.draftId, second.draftId);
  const next = await save({ ...extra, versionLabel: 'fixture-v2', abstract: 'Updated fixed abstract.' });
  assert.equal(next.status, 'revision_draft');
  assert.notEqual(next.materialId, second.materialId);
  const [counts] = await q<{materials:number;drafts:number;pmids:number}>(`
    SELECT (SELECT count(*)::int FROM ep_research_materials WHERE record_id=$1::uuid) AS materials,
      (SELECT count(*)::int FROM ep_research_revision_drafts WHERE record_id=$1::uuid) AS drafts,
      (SELECT count(*)::int FROM ep_research_external_ids WHERE kind='pmid' AND record_id=$1::uuid) AS pmids`, [first.recordId!]);
  assert.deepEqual(counts, { materials: 3, drafts: 2, pmids: 1 });
  const [draft] = await q<{state:string;proposed_metadata:LiteratureMetadata;conflicting_fields:string[]}>(`
    SELECT state,proposed_metadata,conflicting_fields FROM ep_research_revision_drafts WHERE id=$1::uuid`, [second.draftId!]);
  assert.equal(draft?.state, 'draft');
  assert.equal(draft?.proposed_metadata.abstract, extra.abstract);
  assert.deepEqual(draft?.conflicting_fields, []);
  assert.equal(await getPublicResearch(db, first.recordId!), null);
});

test('new source conflicting with human-edited public result is retained as draft only', async () => {
  const articleDoi = doi('public');
  const published = await saveResearchRecord(db, record(run + ':public', productId, { doi: articleDoi }));
  records.add(published.id);
  await q(`UPDATE ep_research_records SET title='[SYNTHETIC] expert-corrected title'
    WHERE id=$1::uuid`, [published.id]);
  const beforeCard = await getPublicResearch(db, published.id);
  assert.ok(beforeCard?.matches.length);
  const imported = await save(snapshot('pubmed', pmid(), {
    doi: articleDoi, title: '[SYNTHETIC] conflicting publisher title',
    abstract: 'Additional private source text.', abstractFormat: 'plain',
    abstractLocator: 'PubMed:Article.Abstract',
  }));
  assert.equal(imported.status, 'revision_draft');
  assert.equal(imported.recordId, published.id);
  assert.deepEqual(await getPublicResearch(db, published.id), beforeCard);
  const [recordAfter] = await q<{title:string;publication_state:string;input_hash:string}>(`
    SELECT title,publication_state,input_hash FROM ep_research_records WHERE id=$1::uuid`, [published.id]);
  assert.equal(recordAfter?.title, beforeCard.title);
  assert.equal(recordAfter?.publication_state, 'published');
  const [draft] = await q<{conflicting_fields:string[];base_input_hash:string}>(`
    SELECT conflicting_fields,base_input_hash FROM ep_research_revision_drafts WHERE id=$1::uuid`, [imported.draftId!]);
  assert.ok(draft?.conflicting_fields.includes('title'));
  assert.equal(draft?.base_input_hash, recordAfter?.input_hash);
  const [publicCount] = await q<{count:number}>('SELECT count(*)::int AS count FROM ep_public_records WHERE id=$1::uuid',[published.id]);
  assert.equal(publicCount?.count, 1);
});

test('conflicting DOI and PMID owners retain unlinked source without merging either record', async () => {
  const pmidA = pmid();
  const a = await save(snapshot('pubmed', pmidA, { doi: doi('identity-a') }));
  const b = await save(snapshot('crossref', doi('identity-b')));
  const conflict = await save(snapshot('pubmed', pmidA, { doi: doi('identity-b'), title: '[SYNTHETIC] conflict' }));
  assert.equal(conflict.status, 'identity_conflict');
  assert.equal(conflict.recordId, null);
  const [material] = await q<{record_id:string|null;intake_state:string;conflict_details:{recordIds:string[]}}>(`
    SELECT record_id::text,intake_state,conflict_details FROM ep_research_materials WHERE id=$1::uuid`, [conflict.materialId]);
  assert.equal(material?.record_id, null);
  assert.equal(material?.intake_state, 'identity_conflict');
  assert.deepEqual(new Set(material?.conflict_details.recordIds), new Set([a.recordId,b.recordId]));
  const [count] = await q<{count:number}>(`
    SELECT count(*)::int AS count FROM ep_research_revision_drafts WHERE record_id IN ($1::uuid,$2::uuid)`, [a.recordId!, b.recordId!]);
  assert.equal(count?.count, 0);
});

test('a post-migration PR1 record keeps its DOI when a same-PMID source reports another DOI', async () => {
  const articlePmid = pmid();
  const originalDoi = doi('legacy-original');
  const legacy = await saveResearchRecord(db, record('pmid:' + articlePmid, productId,
    { doi: originalDoi, publication: { state: 'draft', metadataAllowed: false }, arms: [] }));
  records.add(legacy.id);
  const conflict = await save(snapshot('pubmed', articlePmid,
    { doi: doi('legacy-other'), title: '[SYNTHETIC] same PMID, different DOI' }));
  assert.equal(conflict.status, 'identity_conflict');
  assert.equal(conflict.recordId, null);
  const [row] = await q<{doi:string;title:string}>(
    'SELECT doi,title FROM ep_research_records WHERE id=$1::uuid', [legacy.id]);
  assert.equal(row?.doi, originalDoi);
});

test('missing title is staged as unknown, then linked when source supplies it', async () => {
  const articlePmid = pmid();
  const missing = await save(snapshot('pubmed', articlePmid, {
    doi: null, title: null, publishedYear: 2025, publishedOn: null,
    abstract: null, abstractFormat: null,
  }));
  assert.equal(missing.status, 'needs_metadata');
  assert.equal(missing.recordId, null);
  const completed = await save(snapshot('pubmed', articlePmid, { doi: null }));
  assert.equal(completed.status, 'created');
  const [oldMaterial] = await q<{record_id:string;intake_state:string;metadata:LiteratureMetadata}>(`
    SELECT record_id::text,intake_state,metadata FROM ep_research_materials WHERE id=$1::uuid`, [missing.materialId]);
  assert.equal(oldMaterial?.record_id, completed.recordId);
  assert.equal(oldMaterial?.intake_state, 'linked');
  assert.equal(oldMaterial?.metadata.title, null);
  assert.equal(await getPublicResearch(db, completed.recordId!), null);
});

test('concurrent identical imports create one research record and one material', async () => {
  const input = snapshot('crossref', doi('concurrent'));
  const results = await Promise.all([save(input), save(input), save(input)]);
  assert.equal(new Set(results.map(result => result.recordId)).size, 1);
  assert.equal(new Set(results.map(result => result.materialId)).size, 1);
  const [count] = await q<{count:number}>(`
    SELECT count(*)::int AS count FROM ep_research_records WHERE doi=$1`, [input.doi!]);
  assert.equal(count?.count, 1);
});
