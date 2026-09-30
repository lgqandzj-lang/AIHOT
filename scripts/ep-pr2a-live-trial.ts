// Explicit one-paper online trial against public metadata APIs and a local *_test DB.
// No worker, model, scheduled collection, push, PDF or full-text request.
import { assertEpTestDatabase } from '../tests/fixtures/ep-test-safety.ts';
import { fetchCrossrefMetadata, fetchPubmedMetadata } from '../packages/backend/src/research/metadata.ts';
import { importLiteratureMetadata } from '../packages/backend/src/research/metadata-import.ts';

if (process.env.EP_PR2A_LIVE_TRIAL !== '1') throw new Error('Set EP_PR2A_LIVE_TRIAL=1 for an explicit network trial.');
if (process.env.NODE_ENV === 'production') throw new Error('Refusing a production environment.');
assertEpTestDatabase(process.env.DATABASE_URL, process.env);
const pmid = process.argv[2];
if (!pmid || !/^[1-9][0-9]{0,11}$/.test(pmid)) throw new Error('Usage: node scripts/ep-pr2a-live-trial.ts <PMID>');
process.env.NODE_ENV = 'test';
process.env.MODEL_CALLS_ENABLED = 'false';
process.env.COLLECT_ENABLED = 'false';
process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
for (const key of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(key)) process.env[key] = 'false';

const { sql, closeDb } = await import('../packages/backend/src/db.ts');
const { researchDatabase } = await import('../packages/backend/src/research/postgres.ts');
const db = researchDatabase(sql);
try {
  const pubmed = await fetchPubmedMetadata(pmid, { contactEmail: process.env.NCBI_CONTACT_EMAIL });
  const first = await importLiteratureMetadata(db, pubmed);
  console.log(JSON.stringify({ provider: 'pubmed', pmid: pubmed.pmid, doi: pubmed.doi,
    title: pubmed.title, acquiredAt: pubmed.acquiredAt, abstractPresent: Boolean(pubmed.abstract),
    ...first }));
  if (pubmed.doi) {
    const crossref = await fetchCrossrefMetadata(pubmed.doi);
    const second = await importLiteratureMetadata(db, crossref);
    console.log(JSON.stringify({ provider: 'crossref', doi: crossref.doi,
      title: crossref.title, acquiredAt: crossref.acquiredAt, abstractPresent: Boolean(crossref.abstract),
      ...second }));
    if (first.recordId && second.recordId && first.recordId !== second.recordId) {
      throw new Error('DOI/PMID lookups resolved to different research records.');
    }
  }
} finally { await closeDb(); }
