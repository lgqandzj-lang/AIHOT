import type { Database, Population, RecordInput, Unit } from './contracts.ts';
import type { GoldCount, GoldRecord, GoldSetFile } from './gold-set.ts';
import { saveResearchRecord } from './repository.ts';

const CATALOG = 'varipulse';
const SOURCE_VERSION = 'pubmed:2026-10-02';

export interface StoredCohortCount {
  groupLabel: string;
  quantity: number;
  unit: string;
  populationScope: string;
  locator: string;
}
export interface StoredCohortStudy {
  pmid: string;
  doi: string | null;
  title: string;
  journal: string;
  published: string;
  pubmedUrl: string;
  counts: StoredCohortCount[];
}

export function goldRecordInput(record: GoldRecord, sortIndex: number): RecordInput {
  return {
    sourceKey: `pubmed:${record.pmid}`,
    doi: record.doi,
    title: record.title,
    sourceUrl: record.pubmedUrl,
    studyDesign: 'unknown',
    materialScope: record.counts.length ? 'abstract' : 'metadata',
    sourceVersion: SOURCE_VERSION,
    publication: { state: 'draft', metadataAllowed: false },
    studyLinks: [],
    processingMeta: { importer: 'ep-gold-set-v2' },
    privateData: {
      catalog: CATALOG,
      pmid: record.pmid,
      journal: record.journal,
      publishedLabel: record.published,
      sortIndex,
    },
    arms: record.counts.map((count, index) => armInput(count, index)),
  };
}

export async function importGoldCatalog(db: Database, gold: GoldSetFile): Promise<{ records: number; counts: number }> {
  const studies = gold.records.filter(record => record.eligibility === 'study');
  let counts = 0;
  for (const [index, record] of studies.entries()) {
    await saveResearchRecord(db, goldRecordInput(record, index));
    counts += record.counts.length;
  }
  return { records: studies.length, counts };
}

export async function listImportedCatalog(db: Database): Promise<StoredCohortStudy[]> {
  const rows = await db.query<{
    title: string; doi: string | null; source_url: string; private_data: Record<string, unknown>;
    reported_n: number | null; n_scope: string | null; evidence_private: Record<string, unknown> | null;
  }>({
    text: `SELECT r.title, r.doi, r.source_url, r.private_data,
              a.reported_n, a.n_scope, a.evidence_private
       FROM ep_research_records r
       LEFT JOIN ep_research_arms a ON a.record_id = r.id
       WHERE r.private_data->>'catalog' = $1
       ORDER BY (r.private_data->>'sortIndex')::int,
                COALESCE((a.evidence_private->>'sortIndex')::int, 0)`,
    values: [CATALOG],
  });
  const studies = new Map<string, StoredCohortStudy>();
  for (const row of rows) {
    const pmid = String(row.private_data.pmid);
    let study = studies.get(pmid);
    if (!study) {
      study = {
        pmid,
        doi: row.doi,
        title: row.title,
        journal: String(row.private_data.journal),
        published: String(row.private_data.publishedLabel),
        pubmedUrl: row.source_url,
        counts: [],
      };
      studies.set(pmid, study);
    }
    if (row.reported_n == null || !row.evidence_private) continue;
    study.counts.push({
      groupLabel: String(row.evidence_private.groupLabel),
      quantity: row.reported_n,
      unit: String(row.evidence_private.sourceUnit),
      populationScope: row.n_scope ?? '',
      locator: String(row.evidence_private.locator),
    });
  }
  return [...studies.values()];
}

function armInput(count: GoldCount, index: number): RecordInput['arms'][number] {
  const slug = count.groupLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'count';
  return {
    key: `${index + 1}-${slug}`,
    label: count.groupLabel,
    population: count.unit === 'trials' ? 'bench' satisfies Population : 'human',
    reportedSample: { value: count.quantity, unit: storedUnit(count.unit), scope: count.populationScope },
    evidencePrivate: {
      sortIndex: index,
      groupLabel: count.groupLabel,
      sourceUnit: count.unit,
      locator: count.locator,
    },
    contexts: [],
  };
}

function storedUnit(unit: string): Unit {
  if (unit === 'patients') return 'patients';
  if (unit === 'pulmonary veins') return 'veins';
  return 'other';
}
