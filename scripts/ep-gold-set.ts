import { readFileSync } from 'node:fs';
import { goldPhaseStatus, parseGoldSet } from '../packages/backend/src/research/gold-set.ts';

export function goldStatusText(json: string): string {
  const status = goldPhaseStatus(parseGoldSet(JSON.parse(json)));
  return [
    `eligible studies: ${status.eligibleStudies}`,
    `attested papers: ${status.attestedPapers}`,
    `attested count rows: ${status.attestedRows}`,
    `proposed papers: ${status.proposedPapers}`,
    `proposed count rows: ${status.proposedRows}`,
    `target papers: ${status.targetPapers}`,
    `phase 3 complete: ${status.complete}`,
  ].join('\n');
}

if (process.argv[1]?.endsWith('ep-gold-set.ts')) {
  const file = process.argv[2] ?? new URL('../docs/gold/varipulse-candidates.json', import.meta.url);
  process.stdout.write(goldStatusText(readFileSync(file, 'utf8')) + '\n');
}
