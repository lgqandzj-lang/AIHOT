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

export function loadVaripulseCounts(): CohortStudy[] {
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

export function attachCohortStudies<T extends { papers: ResearchPaper[]; cohortStudies?: CohortStudy[] }>(experience: T): T {
  const studies = loadVaripulseCounts();
  const seen = new Set(experience.papers.map(paper => paper.pmid).filter((pmid): pmid is string => !!pmid));
  return {
    ...experience,
    cohortStudies: studies,
    papers: [...experience.papers, ...studies.filter(study => !seen.has(study.pmid)).map(cohortPaper)],
  };
}
