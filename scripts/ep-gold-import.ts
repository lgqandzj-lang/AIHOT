import { readFileSync } from 'node:fs';
import { parseGoldSet } from '../packages/backend/src/research/gold-set.ts';
import { importGoldCatalog, listImportedCatalog } from '../packages/backend/src/research/gold-catalog.ts';

const file = new URL('../docs/gold/varipulse-candidates.json', import.meta.url);

export async function importCatalogFile(databaseUrl: string): Promise<string> {
  const database = new URL(databaseUrl).pathname.slice(1);
  if (!/^[a-zA-Z0-9_]+_(test|ci)$/.test(database)) throw new Error('Refusing to import outside a database ending in _test or _ci');
  process.env.DATABASE_URL = databaseUrl;
  process.env.MODEL_CALLS_ENABLED = 'false';
  process.env.COLLECT_ENABLED = 'false';
  const { sql, closeDb } = await import('../packages/backend/src/db.ts');
  const { researchDatabase } = await import('../packages/backend/src/research/postgres.ts');
  try {
    const gold = parseGoldSet(JSON.parse(readFileSync(file, 'utf8')));
    const db = researchDatabase(sql);
    const saved = await importGoldCatalog(db, gold);
    const listed = await listImportedCatalog(db);
    const counts = listed.reduce((sum, study) => sum + study.counts.length, 0);
    if (listed.length !== saved.records || counts !== saved.counts) throw new Error('Imported catalog does not match the JSON source');
    return `records: ${saved.records}\ncount rows: ${saved.counts}\ndatabase: ${database}`;
  } finally {
    await closeDb();
  }
}

if (process.argv[1]?.endsWith('ep-gold-import.ts')) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  process.stdout.write(await importCatalogFile(databaseUrl) + '\n');
}
