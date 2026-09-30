// Offline executable demonstration. Uses only authored synthetic material in a local test DB.
import { assertEpTestDatabase } from '../tests/fixtures/ep-test-safety.ts';
import { abstractMetadata, structuredAbstract } from '../tests/fixtures/ep-abstract.ts';
import { importLiteratureMetadata } from '../packages/backend/src/research/metadata-import.ts';
import { splitAbstractMaterial, buildAbstractMaterialBundle, citationForAbstractFragment,
  readAbstractFragment, validateAbstractCitations } from '../packages/backend/src/research/abstract-evidence.ts';

assertEpTestDatabase(process.env.DATABASE_URL);
process.env.NODE_ENV = 'test';
process.env.MODEL_CALLS_ENABLED = 'false'; process.env.COLLECT_ENABLED = 'false';
process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
for (const key of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(key)) process.env[key] = 'false';
const { sql, closeDb } = await import('../packages/backend/src/db.ts');
const { researchDatabase } = await import('../packages/backend/src/research/postgres.ts');
const db = researchDatabase(sql);
try {
  const saved = await importLiteratureMetadata(db, abstractMetadata('10.9999/ep-evidence-demo-fixture', structuredAbstract, 'jats'));
  const split = await splitAbstractMaterial(db, saved.materialId);
  const first = split.fragments[0]!;
  const bundle = await buildAbstractMaterialBundle(db, saved.materialId, { fragmentIds: [first.id] });
  const reference = citationForAbstractFragment(first);
  const validation = await validateAbstractCitations(db, bundle.id, [reference]);
  const readBack = await readAbstractFragment(db, bundle.id, reference);
  console.log(JSON.stringify({ synthetic: true, materialId: saved.materialId, materialHash: split.materialHash,
    ruleVersion: split.splitRuleVersion, splitCount: split.fragments.length,
    bundleId: bundle.id, providedFragmentIds: bundle.providedFragmentIds,
    reference, readBack: { ordinal: readBack.ordinal, label: readBack.sectionLabel, scope: readBack.scope, text: readBack.text },
    fullTextProvided: bundle.fullTextProvided, processingAuthorization: bundle.processingAuthorization, validation }, null, 2));
} finally { await closeDb(); }
