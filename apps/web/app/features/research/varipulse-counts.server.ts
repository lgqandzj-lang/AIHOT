import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CohortStudy } from './contracts.ts';

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
