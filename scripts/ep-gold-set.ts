import { readFileSync } from 'node:fs';
import { goldPhaseStatus, parseGoldSet } from '../packages/backend/src/research/gold-set.ts';

export function goldStatusText(json: string): string {
  const status = goldPhaseStatus(parseGoldSet(JSON.parse(json)));
  return [
    `eligible studies: ${status.eligibleStudies}`,
    `papers with counts: ${status.papersWithCounts}`,
    `count rows: ${status.countRows}`,
  ].join('\n');
}

if (process.argv[1]?.endsWith('ep-gold-set.ts')) {
  const file = process.argv[2] ?? new URL('../docs/gold/varipulse-candidates.json', import.meta.url);
  process.stdout.write(goldStatusText(readFileSync(file, 'utf8')) + '\n');
}
