import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CohortStudy, ResearchPaper } from './contracts.ts';
import { leadCohortCount } from './cohort-format.ts';

export function cohortPaperId(pmid: string): string {
  return `cohort-${pmid}`;
}

export function cohortPaper(study: CohortStudy): ResearchPaper {
  const year = Number(study.published.slice(0, 4));
  return {
    id: cohortPaperId(study.pmid),
    title: study.title,
    journal: study.journal,
    year: Number.isInteger(year) && year > 1000 ? year : null,
    authors: [],
    doi: study.doi,
    pmid: study.pmid,
    topic: 'pfa',
    sources: [{ name: 'PubMed', url: study.pubmedUrl, acquiredAt: '2026-10-02T00:00:00.000Z' }],
    cohortLead: study.counts.length ? leadCohortCount(study) : undefined,
  };
}

function catalogPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = path.join(dir, 'docs', 'gold', 'varipulse-candidates.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('VARIPULSE count file is missing');
}

function catalogDatabaseUrl(): string | undefined {
  if (process.env.EP_CATALOG_DATABASE_URL) return process.env.EP_CATALOG_DATABASE_URL;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 8; hop += 1) {
    const envFile = path.join(dir, '.env');
    if (existsSync(envFile)) {
      const match = readFileSync(envFile, 'utf8').match(/^EP_CATALOG_DATABASE_URL=(\S+)/m);
      if (match?.[1]) return match[1];
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export async function loadVaripulseCounts(): Promise<{ studies: CohortStudy[]; source: 'database' | 'file' }> {
  const databaseUrl = catalogDatabaseUrl();
  if (databaseUrl) return { studies: await loadVaripulseCountsFromDatabase(databaseUrl), source: 'database' };
  return { studies: loadVaripulseCountsFromFile(), source: 'file' };
}

async function loadVaripulseCountsFromDatabase(databaseUrl: string): Promise<CohortStudy[]> {
  const postgres = (await import('postgres')).default;
  const { researchDatabase } = await import('../../../../../packages/backend/src/research/postgres.ts');
  const { listImportedCatalog } = await import('../../../../../packages/backend/src/research/gold-catalog.ts');
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
  try {
    return await listImportedCatalog(researchDatabase(sql));
  } finally {
    await sql.end({ timeout: 1 });
  }
}

function loadVaripulseCountsFromFile(): CohortStudy[] {
  const file = JSON.parse(readFileSync(catalogPath(), 'utf8')) as {
    version?: string;
    records?: Array<{
      pmid?: string; doi?: string | null; title?: string; journal?: string; published?: string; pubmedUrl?: string;
      eligibility?: string;
      counts?: Array<{ groupLabel?: string; quantity?: number; unit?: string; populationScope?: string; locator?: string }>;
    }>;
  };
  if (file.version !== 'ep-gold-set-v2' || !Array.isArray(file.records)) throw new Error('VARIPULSE count file is unreadable');
  return file.records.filter(record => record.eligibility === 'study').map(record => ({
    pmid: String(record.pmid),
    doi: record.doi ?? null,
    title: String(record.title),
    journal: String(record.journal),
    published: String(record.published),
    pubmedUrl: String(record.pubmedUrl),
    counts: (record.counts ?? []).map(count => ({
      groupLabel: String(count.groupLabel),
      quantity: Number(count.quantity),
      unit: String(count.unit),
      populationScope: String(count.populationScope),
      locator: String(count.locator),
    })),
  }));
}

export async function attachCohortStudies<T extends { papers: ResearchPaper[]; cohortStudies?: CohortStudy[]; catalogSource?: 'database' | 'file' }>(experience: T): Promise<T> {
  const catalog = await loadVaripulseCounts();
  const seen = new Set(experience.papers.map(paper => paper.pmid).filter((pmid): pmid is string => !!pmid));
  return {
    ...experience,
    catalogSource: catalog.source,
    cohortStudies: catalog.studies,
    papers: [...experience.papers, ...catalog.studies.filter(study => !seen.has(study.pmid)).map(cohortPaper)],
  };
}
