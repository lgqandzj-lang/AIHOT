import { randomUUID } from 'node:crypto';
import type { Database, Parameter, RecordInput, Session } from './contracts.ts';
import { ResearchValidationError } from './contracts.ts';
import { inputFingerprint, normalizeRecord } from './normalize.ts';
import { normalizeMetadata } from './metadata.ts';
import type { LiteratureMetadata } from './metadata.ts';

export type MetadataImportResult = {
  status: 'created' | 'unchanged' | 'revision_draft' | 'needs_metadata' | 'identity_conflict';
  recordId: string | null;
  materialId: string;
  draftId: string | null;
};
type MaterialRow = { id: string; record_id: string | null; intake_state: string };
type RecordRow = { id: string; doi: string | null; title: string; published_on: string | null; input_hash: string };

const json = (value: unknown): Parameter => JSON.parse(JSON.stringify(value)) as Parameter;
function query<Row extends Record<string, unknown> = Record<string, unknown>>(
  tx: Session, sql: string, values: Parameter[] = [],
): Promise<Row[]> { return tx.query<Row>({ text: sql, values }); }

function contentHash(data: LiteratureMetadata): string {
  const { acquiredAt: _acquiredAt, ...versionedContent } = data;
  return inputFingerprint(versionedContent);
}

async function material(
  tx: Session, data: LiteratureMetadata, hash: string, recordId: string | null,
  state: 'linked' | 'needs_metadata' | 'identity_conflict', details: Record<string, unknown> = {},
): Promise<{ row: MaterialRow; created: boolean }> {
  const id = randomUUID();
  const rows = await query<MaterialRow>(tx, `INSERT INTO ep_research_materials
    (id,record_id,provider,provider_id,source_url,acquired_at,material_scope,
     version_label,payload_hash,metadata,intake_state,conflict_details)
    VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10::jsonb,$11,$12::jsonb)
    ON CONFLICT (provider,provider_id,payload_hash) DO NOTHING
    RETURNING id::text,record_id::text,intake_state`,
    [id, recordId, data.provider, data.providerId, data.sourceUrl, data.acquiredAt,
     data.abstract ? 'abstract' : 'metadata', data.versionLabel, hash, json(data), state, json(details)]);
  if (rows[0]) return { row: rows[0], created: true };
  const existing = await query<MaterialRow>(tx, `SELECT id::text,record_id::text,intake_state
    FROM ep_research_materials WHERE provider=$1 AND provider_id=$2 AND payload_hash=$3 FOR UPDATE`,
    [data.provider, data.providerId, hash]);
  const old = existing[0];
  if (!old) throw new ResearchValidationError('Metadata material disappeared during import.');
  if (old.record_id && recordId && old.record_id !== recordId) {
    throw new ResearchValidationError('Metadata material is already linked to another research record.');
  }
  if (!old.record_id && recordId) {
    const linked = await query<MaterialRow>(tx, `UPDATE ep_research_materials
      SET record_id=$2::uuid,intake_state='linked',conflict_details='{}'::jsonb
      WHERE id=$1::uuid RETURNING id::text,record_id::text,intake_state`, [old.id, recordId]);
    return { row: linked[0]!, created: true };
  }
  if (!old.record_id && old.intake_state !== state) {
    await query(tx, `UPDATE ep_research_materials SET intake_state=$2,conflict_details=$3::jsonb
      WHERE id=$1::uuid`, [old.id, state, json(details)]);
    return { row: { ...old, intake_state: state }, created: false };
  }
  return { row: old, created: false };
}

async function recordCandidates(tx: Session, data: LiteratureMetadata): Promise<string[]> {
  const rows = await query<{ id: string }>(tx, `
    SELECT id::text AS id FROM ep_research_records
      WHERE doi=$1 OR source_key=$2 OR source_key=$3
    UNION
    SELECT record_id::text AS id FROM ep_research_external_ids
      WHERE (kind='doi' AND value=$1) OR (kind='pmid' AND value=$4)
    UNION
    SELECT record_id::text AS id FROM ep_research_materials
      WHERE provider=$5 AND provider_id=$6 AND record_id IS NOT NULL`,
    [data.doi, data.doi ? 'doi:' + data.doi : null,
     data.pmid ? 'pmid:' + data.pmid : null, data.pmid, data.provider, data.providerId]);
  return rows.map(row => row.id);
}

async function identityConflict(tx: Session, recordId: string, data: LiteratureMetadata): Promise<boolean> {
  const canonical = await query<{doi:string|null;source_key:string}>(tx,
    `SELECT doi,source_key FROM ep_research_records WHERE id=$1::uuid`, [recordId]);
  const base = canonical[0];
  if (!base || (base.doi && data.doi && base.doi !== data.doi)
    || (base.source_key.startsWith('pmid:') && data.pmid && base.source_key !== 'pmid:' + data.pmid)) return true;
  const rows = await query<{ kind: string; value: string }>(tx,
    `SELECT kind,value FROM ep_research_external_ids WHERE record_id=$1::uuid`, [recordId]);
  return rows.some(row => (row.kind === 'doi' && data.doi && row.value !== data.doi)
    || (row.kind === 'pmid' && data.pmid && row.value !== data.pmid));
}

async function addIdentities(tx: Session, recordId: string, data: LiteratureMetadata): Promise<void> {
  for (const [kind, value] of [['doi', data.doi], ['pmid', data.pmid]]) {
    if (!value) continue;
    await query(tx, `INSERT INTO ep_research_external_ids (kind,value,record_id)
      VALUES ($1,$2,$3::uuid) ON CONFLICT (kind,value) DO NOTHING`, [kind, value, recordId]);
    const owner = await query<{record_id:string}>(tx,
      `SELECT record_id::text FROM ep_research_external_ids WHERE kind=$1 AND value=$2`, [kind, value]);
    if (owner[0]?.record_id !== recordId) throw new ResearchValidationError('DOI/PMID belongs to another research record.');
  }
}

async function createDraftRecord(tx: Session, data: LiteratureMetadata, hash: string): Promise<{ id: string; created: boolean }> {
  if (!data.title) throw new ResearchValidationError('A new research record needs a source title; material was staged instead.');
  const sourceKey = data.doi ? 'doi:' + data.doi : 'pmid:' + data.pmid;
  const input: RecordInput = {
    sourceKey, doi: data.doi, title: data.title,
    sourceUrl: data.doi ? 'https://doi.org/' + data.doi : 'https://pubmed.ncbi.nlm.nih.gov/' + data.pmid + '/',
    publishedOn: data.publishedOn, studyDesign: 'unknown',
    materialScope: data.abstract ? 'abstract' : 'metadata',
    sourceVersion: 'metadata:' + data.provider + ':' + hash.slice(0, 20),
    publication: { state: 'draft', metadataAllowed: false },
    studyLinks: [], arms: [],
  };
  const normalized = normalizeRecord(input);
  const fingerprint = inputFingerprint(normalized);
  const id = randomUUID();
  const rows = await query<{id:string}>(tx, `INSERT INTO ep_research_records
    (id,identity_key,source_key,doi,title,source_url,published_on,study_design,
     material_scope,source_version,input_hash,publication_state,metadata_public_allowed)
    VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::date,'unknown',$8,$9,$10,'draft',false)
    ON CONFLICT DO NOTHING RETURNING id::text`,
    [id, normalized.doi ? 'doi:' + normalized.doi : 'source:' + normalized.sourceKey,
     normalized.sourceKey, normalized.doi ?? null, normalized.title, normalized.sourceUrl,
     normalized.publishedOn ?? null, normalized.materialScope, normalized.sourceVersion, fingerprint]);
  if (rows[0]) return { id: rows[0].id, created: true };
  const candidates = await recordCandidates(tx, data);
  if (candidates.length !== 1) throw new ResearchValidationError('Concurrent metadata import produced conflicting identities.');
  return { id: candidates[0]!, created: false };
}

async function linkEarlierUnknownMaterials(tx: Session, recordId: string, data: LiteratureMetadata): Promise<void> {
  await query(tx, `UPDATE ep_research_materials
    SET record_id=$1::uuid,intake_state='linked',conflict_details='{}'::jsonb
    WHERE record_id IS NULL AND intake_state='needs_metadata'
      AND ((metadata->>'doi')=$2 OR (metadata->>'pmid')=$3)
      AND (metadata->>'doi' IS NULL OR metadata->>'doi'=$2)
      AND (metadata->>'pmid' IS NULL OR metadata->>'pmid'=$3)`,
    [recordId, data.doi, data.pmid]);
}

/** Import only source metadata. Existing research and public results are insert-only here. */
export async function importLiteratureMetadata(db: Database, input: LiteratureMetadata): Promise<MetadataImportResult> {
  const data = normalizeMetadata(input);
  const hash = contentHash(data);
  return db.transaction(async tx => {
    const keys = ['provider:' + data.provider + ':' + data.providerId,
      ...(data.doi ? ['doi:' + data.doi] : []), ...(data.pmid ? ['pmid:' + data.pmid] : [])].sort();
    for (const key of keys) await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    const candidates = await recordCandidates(tx, data);
    const recordId = candidates.length === 1 ? candidates[0]! : null;
    if (candidates.length > 1 || (recordId && await identityConflict(tx, recordId, data))) {
      const stored = await material(tx, data, hash, null, 'identity_conflict', { recordIds: candidates });
      return { status: 'identity_conflict', recordId: null, materialId: stored.row.id, draftId: null };
    }
    if (!recordId && !data.title) {
      const stored = await material(tx, data, hash, null, 'needs_metadata');
      return { status: 'needs_metadata', recordId: null, materialId: stored.row.id, draftId: null };
    }
    const created = recordId ? { id: recordId, created: false } : await createDraftRecord(tx, data, hash);
    const id = created.id;
    await addIdentities(tx, id, data);
    const stored = await material(tx, data, hash, id, 'linked');
    if (created.created) await linkEarlierUnknownMaterials(tx, id, data);
    if (!stored.created) {
      const drafts = await query<{id:string}>(tx,
        `SELECT id::text FROM ep_research_revision_drafts WHERE material_id=$1::uuid`, [stored.row.id]);
      return { status: 'unchanged', recordId: id, materialId: stored.row.id, draftId: drafts[0]?.id ?? null };
    }
    if (created.created) return { status: 'created', recordId: id, materialId: stored.row.id, draftId: null };

    const existing = await query<RecordRow>(tx, `SELECT id::text,doi,title,published_on::text,input_hash
      FROM ep_research_records WHERE id=$1::uuid`, [id]);
    const base = existing[0]!;
    const conflicts: string[] = [];
    if (data.title && data.title !== base.title) conflicts.push('title');
    if (data.publishedOn && base.published_on && data.publishedOn !== base.published_on) conflicts.push('publishedOn');
    const draftId = randomUUID();
    const drafts = await query<{id:string}>(tx, `INSERT INTO ep_research_revision_drafts
      (id,record_id,material_id,base_input_hash,proposed_metadata,conflicting_fields)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,ARRAY(SELECT jsonb_array_elements_text($6::jsonb)))
      ON CONFLICT (material_id) DO NOTHING RETURNING id::text`,
      [draftId, id, stored.row.id, base.input_hash, json(data), json(conflicts)]);
    if (!drafts[0]) throw new ResearchValidationError('New material did not create a revision draft.');
    return { status: 'revision_draft', recordId: id, materialId: stored.row.id, draftId: drafts[0].id };
  });
}
