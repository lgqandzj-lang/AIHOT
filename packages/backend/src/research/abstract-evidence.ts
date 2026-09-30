import { randomUUID } from 'node:crypto';
import type { Database, Parameter, Session } from './contracts.ts';
import { ResearchValidationError } from './contracts.ts';
import { inputFingerprint } from './normalize.ts';
import { normalizeMetadata } from './metadata.ts';
import type { LiteratureMetadata } from './metadata.ts';
import { splitAbstractText } from './abstract-text.ts';

export const ABSTRACT_SPLIT_RULE_VERSION = 'abstract-source-v1';
export interface AbstractFragment {
  id: string; materialId: string; materialHash: string; splitRuleVersion: string;
  ordinal: number; sectionLabel: string | null; scope: 'abstract'; text: string; fragmentHash: string;
}
export interface AbstractCitation {
  fragmentId: string; materialId: string; materialHash: string; splitRuleVersion: string; fragmentHash: string;
}
interface BundleSource {
  provider: string; providerId: string; sourceUrl: string; acquiredAt: string; versionLabel: string | null;
}
export interface AbstractMaterialBundle {
  id: string; materialId: string; materialHash: string; splitRuleVersion: string;
  state: 'ready' | 'empty_abstract' | 'no_fragments_selected'; scope: 'abstract';
  source: BundleSource; providedFragmentIds: string[]; fragments: AbstractFragment[];
  fullTextProvided: false; processingAuthorization: 'not_evaluated'; citationValidation: 'identity_only';
}
type MaterialRow = {
  id: string; payload_hash: string; metadata: LiteratureMetadata;
  provider: string; provider_id: string; source_url: string; acquired_at: string; version_label: string | null;
};
type FragmentRow = {
  id: string; material_id: string; material_hash: string; split_rule_version: string;
  ordinal: number; section_label: string | null; material_scope: 'abstract'; fragment_text: string; fragment_hash: string;
};
type BundleRow = {
  id: string; material_id: string; material_hash: string; split_rule_version: string;
  state: AbstractMaterialBundle['state']; source: BundleSource; provided_fragment_ids: string[]; manifest_hash: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hashPattern = /^[0-9a-f]{64}$/;
const rulePattern = /^[a-z][a-z0-9_-]{0,79}$/;
const json = (value: unknown): Parameter => JSON.parse(JSON.stringify(value)) as Parameter;
const query = <Row extends Record<string, unknown>>(tx: Session, text: string, values: Parameter[] = []) =>
  tx.query<Row>({ text, values });
function requireId(value: string): void {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ResearchValidationError('Invalid evidence UUID.');
}
function requireRule(value: string): void {
  if (typeof value !== 'string' || !rulePattern.test(value)) throw new ResearchValidationError('Invalid abstract split rule version.');
}
function textHash(label: string | null, text: string): string {
  return inputFingerprint({ scope: 'abstract', sectionLabel: label, text });
}
function fragment(row: FragmentRow): AbstractFragment {
  if (row.material_scope !== 'abstract' || row.fragment_hash !== textHash(row.section_label, row.fragment_text)) {
    throw new ResearchValidationError('Stored fragment fingerprint mismatch.');
  }
  return { id: row.id, materialId: row.material_id, materialHash: row.material_hash,
    splitRuleVersion: row.split_rule_version, ordinal: row.ordinal, sectionLabel: row.section_label,
    scope: 'abstract', text: row.fragment_text, fragmentHash: row.fragment_hash };
}
const fragmentColumns = `id::text,material_id::text,material_hash,split_rule_version,
  ordinal,section_label,material_scope,fragment_text,fragment_hash`;
async function loadMaterial(tx: Session, materialId: string): Promise<MaterialRow> {
  const [row] = await query<MaterialRow>(tx, `SELECT id::text,payload_hash,metadata,
    provider,provider_id,source_url,acquired_at::text,version_label
    FROM ep_research_materials WHERE id=$1::uuid FOR SHARE`, [materialId]);
  if (!row) throw new ResearchValidationError('Unknown abstract material.');
  const { acquiredAt: _acquiredAt, ...content } = row.metadata;
  if (inputFingerprint(content) !== row.payload_hash) throw new ResearchValidationError('Material fingerprint mismatch.');
  return row;
}
async function splitInTransaction(tx: Session, materialId: string, ruleVersion: string) {
  const material = await loadMaterial(tx, materialId);
  const sections = splitAbstractText(normalizeMetadata(material.metadata));
  if (sections.length > 200) throw new ResearchValidationError('Abstract has more than 200 source fragments.');
  if (sections.some(section => !section.text.trim() || section.text.length > 100_000 || section.text.includes('\0')
    || (section.label != null && (!section.label.trim() || section.label.length > 200 || section.label.includes('\0'))))) {
    throw new ResearchValidationError('Invalid parsed abstract fragment.');
  }
  await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    ['abstract:' + materialId + ':' + material.payload_hash + ':' + ruleVersion]);
  let rows = await query<FragmentRow>(tx, `SELECT ${fragmentColumns} FROM ep_research_abstract_fragments
    WHERE material_id=$1::uuid AND material_hash=$2 AND split_rule_version=$3 ORDER BY ordinal`,
    [materialId, material.payload_hash, ruleVersion]);
  if (rows.length) {
    if (rows.length !== sections.length || rows.some((row, index) => row.ordinal !== index + 1
      || row.fragment_hash !== textHash(sections[index]!.label, sections[index]!.text))) {
      throw new ResearchValidationError('Existing split differs; change the split rule version instead of overwriting fragments.');
    }
  } else {
    for (const [index, section] of sections.entries()) {
      const [row] = await query<FragmentRow>(tx, `INSERT INTO ep_research_abstract_fragments
        (id,material_id,material_hash,split_rule_version,ordinal,section_label,fragment_text,fragment_hash)
        VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8) RETURNING ${fragmentColumns}`,
        [randomUUID(), materialId, material.payload_hash, ruleVersion, index + 1,
         section.label, section.text, textHash(section.label, section.text)]);
      rows.push(row!);
    }
  }
  return { material, fragments: rows.map(fragment) };
}

/** Internal private operation. Version override is for a deliberate producer rule-version bump. */
export async function splitAbstractMaterial(db: Database, materialId: string, ruleVersion = ABSTRACT_SPLIT_RULE_VERSION) {
  requireId(materialId); requireRule(ruleVersion);
  return db.transaction(async tx => {
    const { material, fragments } = await splitInTransaction(tx, materialId, ruleVersion);
    return { state: fragments.length ? 'ready' as const : 'empty_abstract' as const,
      materialId, materialHash: material.payload_hash, splitRuleVersion: ruleVersion, fragments };
  });
}
function manifest(row: Pick<BundleRow, 'material_id' | 'material_hash' | 'split_rule_version' | 'state' | 'source' | 'provided_fragment_ids'>) {
  return inputFingerprint({ materialId: row.material_id, materialHash: row.material_hash,
    splitRuleVersion: row.split_rule_version, state: row.state, source: row.source,
    providedFragmentIds: row.provided_fragment_ids });
}

/** Persist the exact provided subset. Private storage is not permission to send it to a model. */
export async function buildAbstractMaterialBundle(db: Database, materialId: string,
  options: { ruleVersion?: string; fragmentIds?: string[] } = {},
): Promise<AbstractMaterialBundle> {
  const ruleVersion = options.ruleVersion ?? ABSTRACT_SPLIT_RULE_VERSION;
  requireId(materialId); requireRule(ruleVersion);
  if (options.fragmentIds !== undefined) {
    if (!Array.isArray(options.fragmentIds) || options.fragmentIds.length > 200
      || new Set(options.fragmentIds).size !== options.fragmentIds.length) throw new ResearchValidationError('Invalid bundle fragment selection.');
    options.fragmentIds.forEach(requireId);
  }
  return db.transaction(async tx => {
    const { material, fragments: all } = await splitInTransaction(tx, materialId, ruleVersion);
    const selected = new Set(options.fragmentIds ?? all.map(item => item.id));
    if ([...selected].some(id => !all.some(item => item.id === id))) throw new ResearchValidationError('Selected fragment is outside this material/version/rule.');
    const fragments = all.filter(item => selected.has(item.id));
    const source: BundleSource = { provider: material.provider, providerId: material.provider_id,
      sourceUrl: material.source_url, acquiredAt: new Date(material.acquired_at).toISOString(), versionLabel: material.version_label };
    const row: Omit<BundleRow, 'manifest_hash'> = { id: randomUUID(), material_id: materialId,
      material_hash: material.payload_hash, split_rule_version: ruleVersion,
      state: fragments.length ? 'ready' : all.length ? 'no_fragments_selected' : 'empty_abstract',
      source, provided_fragment_ids: fragments.map(item => item.id) };
    await query(tx, `INSERT INTO ep_research_abstract_bundles
      (id,material_id,material_hash,split_rule_version,state,source,provided_fragment_ids,manifest_hash)
      VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
      [row.id, materialId, row.material_hash, ruleVersion, row.state, json(source), json(row.provided_fragment_ids), manifest(row)]);
    return { id: row.id, materialId, materialHash: row.material_hash, splitRuleVersion: ruleVersion,
      state: row.state, scope: 'abstract', source, providedFragmentIds: row.provided_fragment_ids, fragments,
      fullTextProvided: false, processingAuthorization: 'not_evaluated', citationValidation: 'identity_only' };
  });
}
export function citationForAbstractFragment(item: AbstractFragment): AbstractCitation {
  return { fragmentId: item.id, materialId: item.materialId, materialHash: item.materialHash,
    splitRuleVersion: item.splitRuleVersion, fragmentHash: item.fragmentHash };
}
async function loadBundle(tx: Session, bundleId: string): Promise<BundleRow> {
  const [row] = await query<BundleRow>(tx, `SELECT id::text,material_id::text,material_hash,
    split_rule_version,state,source,provided_fragment_ids,manifest_hash
    FROM ep_research_abstract_bundles WHERE id=$1::uuid`, [bundleId]);
  if (!row) throw new ResearchValidationError('Unknown abstract bundle.');
  if (manifest(row) !== row.manifest_hash) throw new ResearchValidationError('Bundle manifest fingerprint mismatch.');
  return row;
}
function validateReference(reference: AbstractCitation): void {
  requireId(reference.fragmentId); requireId(reference.materialId); requireRule(reference.splitRuleVersion);
  if (!hashPattern.test(reference.materialHash) || !hashPattern.test(reference.fragmentHash)) {
    throw new ResearchValidationError('Invalid citation fingerprint.');
  }
}
async function readInBundle(tx: Session, bundle: BundleRow, reference: AbstractCitation): Promise<AbstractFragment> {
  const [row] = await query<FragmentRow>(tx, `SELECT ${fragmentColumns}
    FROM ep_research_abstract_fragments WHERE id=$1::uuid`, [reference.fragmentId]);
  if (!row) throw new ResearchValidationError('Unknown abstract fragment.');
  if (row.material_id !== bundle.material_id || reference.materialId !== bundle.material_id) throw new ResearchValidationError('Citation material mismatch.');
  if (row.material_hash !== bundle.material_hash || reference.materialHash !== bundle.material_hash) throw new ResearchValidationError('Citation material version mismatch.');
  if (row.split_rule_version !== bundle.split_rule_version || reference.splitRuleVersion !== bundle.split_rule_version) throw new ResearchValidationError('Citation split rule version mismatch.');
  if (row.fragment_hash !== reference.fragmentHash) throw new ResearchValidationError('Citation fragment fingerprint mismatch.');
  if (!bundle.provided_fragment_ids.includes(row.id)) throw new ResearchValidationError('Citation fragment was not provided in this bundle.');
  return fragment(row);
}

/** Requires a persisted bundle; cannot widen access using a caller-created manifest. */
export async function readAbstractFragment(db: Database, bundleId: string, reference: AbstractCitation): Promise<AbstractFragment> {
  requireId(bundleId); validateReference(reference);
  return db.transaction(async tx => readInBundle(tx, await loadBundle(tx, bundleId), reference));
}
/** Read the persisted provided subset, never a caller-expanded bundle. */
export async function readAbstractMaterialBundle(db: Database, bundleId: string): Promise<AbstractMaterialBundle> {
  requireId(bundleId);
  return db.transaction(async tx => {
    const stored = await loadBundle(tx, bundleId);
    const fragments: AbstractFragment[] = [];
    for (const id of stored.provided_fragment_ids) {
      const [row] = await query<FragmentRow>(tx, `SELECT ${fragmentColumns} FROM ep_research_abstract_fragments WHERE id=$1::uuid`, [id]);
      if (!row) throw new ResearchValidationError('Unknown abstract fragment.');
      fragments.push(await readInBundle(tx, stored, citationForAbstractFragment(fragment(row))));
    }
    return { id: stored.id, materialId: stored.material_id, materialHash: stored.material_hash,
      splitRuleVersion: stored.split_rule_version, state: stored.state, scope: 'abstract', source: stored.source,
      providedFragmentIds: stored.provided_fragment_ids, fragments, fullTextProvided: false,
      processingAuthorization: 'not_evaluated', citationValidation: 'identity_only' };
  });
}
export async function validateAbstractCitations(db: Database, bundleId: string, references: AbstractCitation[]) {
  requireId(bundleId);
  if (!Array.isArray(references) || references.length > 200) throw new ResearchValidationError('Invalid citation list.');
  references.forEach(validateReference);
  return db.transaction(async tx => {
    const bundle = await loadBundle(tx, bundleId);
    for (const reference of references) await readInBundle(tx, bundle, reference);
    return { checked: references.length, identitiesValidated: true as const, semanticsValidated: false as const };
  });
}
