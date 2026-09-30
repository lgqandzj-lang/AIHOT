// Offline only. Actual material, raw model responses and reports belong in .data/, never Git.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertEpTestDatabase } from '../tests/fixtures/ep-test-safety.ts';
import { extractionMetadata, fixedExtractionOutput } from '../tests/fixtures/ep-extraction.ts';
import { importLiteratureMetadata } from '../packages/backend/src/research/metadata-import.ts';
import { buildAbstractMaterialBundle } from '../packages/backend/src/research/abstract-evidence.ts';
assertEpTestDatabase(process.env.DATABASE_URL);
process.env.MODEL_CALLS_ENABLED = 'false'; process.env.COLLECT_ENABLED = 'false'; process.env.NODE_ENV = 'test';
process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
for (const key of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(key)) process.env[key] = 'false';
const {sql,closeDb} = await import('../packages/backend/src/db.ts');
const {researchDatabase} = await import('../packages/backend/src/research/postgres.ts');
const {extractOfflineBundle,extractionFieldReport,renderExtractionReport,extractionLivePreflight} = await import('../packages/backend/src/research/abstract-extraction.ts');
const db = researchDatabase(sql); const directory = path.resolve('.data/ep-pr2b');
await mkdir(directory,{recursive:true});
try {
  const results = [];
  for (const variant of ['original','ablated','control'] as const) {
    const saved = await importLiteratureMetadata(db,extractionMetadata(variant));
    const bundle = await buildAbstractMaterialBundle(db,saved.materialId);
    // The fixed answer stays inside the injected callback, never in its input.
    const draft = await extractOfflineBundle(db,bundle.id,async input => {
      if (variant === 'ablated' && /without fluoroscopy|zero[- ]fluoro|no radiation/i.test(input.user)) throw new Error('Ablated input leaks key evidence');
      return fixedExtractionOutput(bundle,variant);
    });
    const report = await extractionFieldReport(db,draft.id);
    await writeFile(path.join(directory,'field-report.' + variant + '.md'),renderExtractionReport(report),'utf8');
    await writeFile(path.join(directory,'bundle.' + variant + '.json'),JSON.stringify({synthetic:true,title:extractionMetadata(variant).title,bundle},null,2),'utf8');
    results.push({variant,report});
    if (variant === 'original') {
      const preflight = await extractionLivePreflight(db,bundle.id);
      await writeFile(path.join(directory,'live-preflight.json'),JSON.stringify(preflight,null,2),'utf8');
    }
  }
  await writeFile(path.join(directory,'offline-reports.json'),JSON.stringify(results,null,2),'utf8');
  // Independent evaluation expectations: not imported by the prompt/transport.
  await writeFile(path.join(directory,'evaluation-only.json'),JSON.stringify({synthetic:true,notModelInput:true,
    original:{groupASample:12,groupBSample:8,groupARadiation:'without fluoroscopy'},
    ablated:{groupASample:12,groupBSample:8,groupARadiation:null},
    control:{groupCSample:5,groupCRadiation:null},realModelEffectValidated:false},null,2),'utf8');
  console.log(JSON.stringify({synthetic:true,realModelRequests:0,realModelEffectValidated:false,
    cases:results.map(item => ({variant:item.variant,draftId:item.report.draftId,bundleId:item.report.bundleId,
      providedFragmentIds:item.report.providedFragmentIds,fields:item.report.fields.length,format:item.report.formatStatus,
      citations:item.report.citationStatus,semantics:item.report.semanticStatus})),reportDirectory:directory},null,2));
} finally { await closeDb(); }
