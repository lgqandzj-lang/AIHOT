import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { assertEpTestDatabase } from './fixtures/ep-test-safety.ts';
import { extractionMetadata, fixedExtractionOutput, fixedModelExtractionOutput, fixedCompactExtractionOutput } from './fixtures/ep-extraction.ts';
import type { ExtractionVariant } from './fixtures/ep-extraction.ts';
import { abstractMetadata } from './fixtures/ep-abstract.ts';
import { record } from './fixtures/ep-research.ts';
import type { Parameter } from '../packages/backend/src/research/contracts.ts';
import { importLiteratureMetadata } from '../packages/backend/src/research/metadata-import.ts';
import { buildAbstractMaterialBundle } from '../packages/backend/src/research/abstract-evidence.ts';
import { extractOfflineBundle, extractionFieldReport, renderExtractionReport, ExtractionOutcomeUnknown,
  extractionLivePreflight, executeExtractionTrial } from '../packages/backend/src/research/abstract-extraction.ts';
import { prepareExtractionRequest } from '../packages/backend/src/research/abstract-extraction.ts';
import { reserveExtractionTrial, claimExtractionTrial, loadExtractionTrial, finishExtractionTrial } from '../packages/backend/src/research/extraction-budget.ts';
import type { LiveTrialApproval, FinalExtractionRequest } from '../packages/backend/src/research/extraction-budget.ts';
import { sha256, stableJson } from '../packages/backend/src/lib/ids.ts';
import { saveProduct, saveResearchRecord } from '../packages/backend/src/research/repository.ts';
import { getPublicResearch, listPublicResearch } from '../packages/backend/src/publication/research.ts';

assertEpTestDatabase(process.env.DATABASE_URL);
process.env.NODE_ENV = 'test'; process.env.MODEL_CALLS_ENABLED = 'false'; process.env.COLLECT_ENABLED = 'false';
process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
for (const key of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(key)) process.env[key] = 'false';
const {sql,closeDb} = await import('../packages/backend/src/db.ts');
const {researchDatabase} = await import('../packages/backend/src/research/postgres.ts');
const db = researchDatabase(sql);
const run = 'extract-' + randomUUID().slice(0,8);
const bundles = new Set<string>(); const records = new Set<string>();
const q = <Row extends Record<string, unknown> = Record<string,unknown>>(text: string,values: Parameter[] = []) => db.query<Row>({text,values});
const productId = run + '-product';
async function save(variant: ExtractionVariant = 'original') {
  const saved = await importLiteratureMetadata(db,extractionMetadata(variant,'10.9999/' + run + '.' + randomUUID()));
  records.add(saved.recordId!);
  const bundle = await buildAbstractMaterialBundle(db,saved.materialId); bundles.add(bundle.id); return {saved,bundle};
}
function priceApproval(bundle: Awaited<ReturnType<typeof save>>['bundle'],key = run + ':' + randomUUID()) {
  const body = {model:'synthetic-model',messages:[{role:'user',content:'synthetic request'}],max_tokens:2048,temperature:0};
  const request: FinalExtractionRequest = {body,bodyHash:sha256(stableJson(body)),baseUrl:'https://provider.example/v1',modelKey:'synthetic',modelName:'synthetic-model',service:'synthetic'};
  const now = Date.now();
  const approval: LiveTrialApproval = {authorizationKey:key,authorizedBy:'synthetic fixture only',approvedAt:new Date(now - 1000).toISOString(),expiresAt:new Date(now + 60000).toISOString(),
    bundleId:bundle.id,materialHash:bundle.materialHash,modelKey:request.modelKey,modelName:'synthetic-model',endpoint:request.baseUrl!,requestHash:request.bodyHash,currency:'CNY',authorizedMicros:12000,
    materialProcessingBasis:'Authored synthetic data',pricing:{basisUrl:'https://provider.example/synthetic-pricing',verifiedAt:new Date(now - 1000).toISOString(),validUntil:new Date(now + 60000).toISOString(),
      requestHash:request.bodyHash,inputTokenUpperBound:1000,inputCountingBasis:'SYNTHETIC count; no live provider',inputMicrosPerMillion:2000000,outputMicrosPerMillion:4000000,additionalFeeMicros:0,
      billingCoverage:'all_input_output_reasoning_and_additional_fees',outputCapCoversAllBillableOutput:true}};
  return {request,approval};
}
before(async () => {
  const [info] = await q<{version:string;database:string;storage:string|null}>(`SELECT current_setting('server_version') AS version,current_database() AS database,to_regclass('ep_research_extraction_drafts')::text AS storage`);
  assert.ok(info?.version.startsWith('17.') && /_(test|ci)$/.test(info.database) && info.storage);
  await saveProduct(db,{id:productId,name:'[SYNTHETIC] Extraction fixture product',kind:'catheter'});
});
after(async () => {
  try {
    for (const id of bundles) {
      await q('DELETE FROM ep_research_extraction_drafts WHERE bundle_id=$1::uuid',[id]);
      await q('DELETE FROM ep_research_extraction_trials WHERE bundle_id=$1::uuid',[id]);
    }
    for (const id of records) await q('DELETE FROM ep_research_records WHERE id=$1::uuid',[id]);
    await q('DELETE FROM ep_products WHERE id=$1',[productId]);
  } finally { await closeDb(); }
});
test('one private bundle produces a persisted draft and per-field readback; no model/prose call',async () => {
  const {bundle} = await save(); let hits = 0;
  const draft = await extractOfflineBundle(db,bundle.id,async input => {
    hits++; assert.deepEqual(JSON.parse(input.user).fragments.map((item:{fragmentId:string})=>item.fragmentId),bundle.providedFragmentIds);
    assert.ok(!input.user.includes('radiationStrategy')); return fixedExtractionOutput(bundle,'original');
  });
  assert.equal(hits,1); assert.equal(draft.state,'private_draft'); assert.equal(draft.formatStatus,'valid'); assert.equal(draft.citationStatus,'valid');
  assert.equal(draft.semanticStatus,'not_performed');
  const report = await extractionFieldReport(db,draft.id);
  assert.equal(hits,1); assert.ok(report.fields.length > 10);
  assert.ok(report.fields.every(field => field.semanticStatus === 'not_evaluated' && field.evidence.every(item => item.identity === 'valid')));
  assert.ok(renderExtractionReport(report).includes('真实模型效果尚未验证'));
});
test('research-only v2 response persists a program-managed version; evidence and incomplete claims remain separate',async()=>{
  const {bundle}=await save('control');
  const response=fixedModelExtractionOutput(bundle,'control');
  assert.ok(!Object.hasOwn(response,'schemaVersion'));
  const draft=await extractOfflineBundle(db,bundle.id,async()=>response);
  assert.equal(draft.output!.schemaVersion,'ep-abstract-extract-v2');assert.equal(draft.state,'private_draft');
  const report=await extractionFieldReport(db,draft.id);
  assert.equal(report.fields.find(item=>item.path==='radiationStrategy')!.absenceStatus,'unknown');
  assert.equal(report.semanticStatus,'not_evaluated');
  const bad=structuredClone(response) as any;
  bad.groups[0].productRoles[0].value.product='PFA';
  bad.groups[0].sample.denominator={value:null,citations:[],status:'unknown'};
  const invalid=await extractOfflineBundle(db,bundle.id,async()=>bad);
  assert.equal(invalid.formatStatus,'valid');assert.equal(invalid.citationStatus,'valid');assert.equal(invalid.state,'invalid_output');
  assert.ok(invalid.issues.some(item=>item.includes('technology_is_not_product')));
  assert.ok(invalid.issues.some(item=>item.includes('sample_scope_missing')));
  const controls=await extractOfflineBundle(db,bundle.id,async()=>({...response,schemaVersion:'ep-abstract-extract-v2',publicationState:'published'}));
  assert.equal(controls.formatStatus,'invalid');
});
test('current compact fixture stores exact private references and separates outcome denominator without changing PR1',async()=>{
  const {bundle}=await save('control');
  const output=fixedCompactExtractionOutput(bundle,'control');
  const draft=await extractOfflineBundle(db,bundle.id,async()=>output);
  assert.equal(draft.state,'private_draft');assert.equal(draft.output!.schemaVersion,'ep-abstract-extract-v3');
  assert.equal(draft.output!.groups[0]!.sample.quantity!.value,5);
  const report=await extractionFieldReport(db,draft.id);
  assert.equal(report.fields.find(item=>item.path==='observationTimes[0].outcomeDenominator')!.value,null);
  assert.equal(report.fieldCompletenessStatus,'required_fields_present');assert.equal(report.sourceCoverageStatus,'not_evaluated');
  assert.equal(report.semanticStatus,'not_evaluated');
  assert.ok(report.fields.every(item=>item.evidence.every(e=>e.identity==='valid')));
});
test('synthetic length-stop response remains raw but never enters a complete persisted card or diagnostic fields',async()=>{
  const {bundle}=await save('control');const output=fixedCompactExtractionOutput(bundle,'control');
  const draft=await extractOfflineBundle(db,bundle.id,async()=>output,{finishReason:'length'});
  assert.equal(draft.state,'invalid_output');assert.equal(draft.output,null);assert.equal(draft.truncationStatus,'truncated');
  const report=await extractionFieldReport(db,draft.id);
  assert.equal(report.truncationStatus,'truncated');assert.equal(report.fields.length,0);
  assert.equal(report.semanticStatus,'not_evaluated');
  const [row]=await q<{raw_output:unknown;parsed_output:unknown}>('SELECT raw_output,parsed_output FROM ep_research_extraction_drafts WHERE id=$1::uuid',[draft.id]);
  assert.deepEqual(row!.raw_output,output);assert.equal(row!.parsed_output,null);
});
test('missing fields remain unknown and an empty abstract never invokes injected response',async () => {
  const {bundle} = await save('control');
  const draft = await extractOfflineBundle(db,bundle.id,async () => ({schemaVersion:'ep-abstract-extract-v1',groups:[{groupId:'g1'}]}));
  assert.equal(draft.output!.groups[0]!.sample.quantity,null); assert.equal(draft.output!.groups[0]!.radiationStrategy,null);
  const saved = await importLiteratureMetadata(db,abstractMetadata('10.9999/' + run + '.empty',null)); records.add(saved.recordId!);
  const empty = await buildAbstractMaterialBundle(db,saved.materialId); bundles.add(empty.id);
  let hits = 0; const none = await extractOfflineBundle(db,empty.id,async () => {hits++;return {};});
  assert.equal(none.state,'empty_input'); assert.equal(hits,0);
});
test('fabricated, cross-material, cross-version and omitted citations are rejected',async () => {
  const {bundle} = await save(); const {bundle:other} = await save('control');
  const outputs = [];
  const invented = fixedExtractionOutput(bundle,'original'); invented.groups[0]!.researchSubjects!.citations[0]!.fragmentId = randomUUID(); outputs.push(invented);
  const cross = fixedExtractionOutput(bundle,'original'); cross.groups[0]!.researchSubjects!.citations = fixedExtractionOutput(other,'control').groups[0]!.researchSubjects!.citations; outputs.push(cross);
  const version = fixedExtractionOutput(bundle,'original'); version.groups[0]!.researchSubjects!.citations[0]!.materialHash = '0'.repeat(64); outputs.push(version);
  for (const output of outputs) {
    const draft = await extractOfflineBundle(db,bundle.id,async () => output);
    assert.equal(draft.formatStatus,'valid'); assert.equal(draft.citationStatus,'invalid'); assert.equal(draft.state,'invalid_output');
  }
  const subset = await buildAbstractMaterialBundle(db,bundle.materialId,{fragmentIds:[bundle.fragments[0]!.id]}); bundles.add(subset.id);
  const omitted = await extractOfflineBundle(db,subset.id,async () => fixedExtractionOutput(bundle,'original'));
  assert.equal(omitted.citationStatus,'invalid');
});
test('a real citation with an unsupported conclusion NEVER becomes semantic verification',async () => {
  const {bundle} = await save(); const response = fixedExtractionOutput(bundle,'original');
  response.groups[0]!.observationTimes![0]!.time!.value = '365 days'; // Source says 30 days, citation exists.
  const draft = await extractOfflineBundle(db,bundle.id,async () => response);
  assert.equal(draft.formatStatus,'valid'); assert.equal(draft.citationStatus,'valid'); assert.equal(draft.semanticStatus,'not_performed');
  const report = await extractionFieldReport(db,draft.id);
  const field = report.fields.find(item => item.groupId === 'g1' && item.path === 'observationTimes[0].time')!;
  assert.equal(field.value,'365 days'); assert.ok(field.evidence[0]!.text!.includes('30 days')); assert.equal(field.semanticStatus,'not_evaluated');
  assert.equal(report.realModelEffectValidated,false);
});
test('two groups in the same paper stay separate; no summed count or pooled denominator',async () => {
  const {bundle} = await save();
  const draft = await extractOfflineBundle(db,bundle.id,async () => fixedExtractionOutput(bundle,'original'));
  assert.deepEqual(draft.output!.groups.map(item => item.sample.quantity!.value),[12,8]);
  assert.deepEqual(draft.output!.groups.map(item => item.sample.denominator!.value),['all 12 enrolled participants','all 8 enrolled participants']);
});
test('invalid output and forbidden publication/SQL fields never alter public/canonical records',async () => {
  const doi = '10.9999/' + run + '.public';
  const published = await saveResearchRecord(db,record(run + ':public',productId,{doi})); records.add(published.id);
  const saved = await importLiteratureMetadata(db,extractionMetadata('original',doi));
  const bundle = await buildAbstractMaterialBundle(db,saved.materialId); bundles.add(bundle.id);
  const before = await getPublicResearch(db,published.id); const list = await listPublicResearch(db,{productId});
  const [canonical] = await q('SELECT to_jsonb(r) AS row FROM ep_research_records r WHERE id=$1::uuid',[published.id]);
  for (const output of ['not JSON',{...fixedExtractionOutput(bundle,'original'),publicationState:'published'},
    {...fixedExtractionOutput(bundle,'original'),sql:'DELETE FROM ep_research_records'}]) {
    const draft = await extractOfflineBundle(db,bundle.id,async () => output); assert.equal(draft.formatStatus,'invalid');
  }
  await extractOfflineBundle(db,bundle.id,async () => fixedExtractionOutput(bundle,'original'));
  const literal = fixedExtractionOutput(bundle,'original');
  literal.groups[0]!.researchSubjects!.value = 'literal \\u0000';
  const kept = await extractOfflineBundle(db,bundle.id,async () => literal);
  assert.equal(kept.formatStatus,'valid');
  assert.ok((await q<{raw_output:unknown}>('SELECT raw_output FROM ep_research_extraction_drafts WHERE id=$1::uuid',[kept.id]))[0]!.raw_output);
  literal.groups[0]!.researchSubjects!.value = 'NUL\0';
  const invalid = await extractOfflineBundle(db,bundle.id,async () => literal);
  assert.equal(invalid.formatStatus,'invalid');
  assert.equal((await q<{raw_output:unknown}>('SELECT raw_output FROM ep_research_extraction_drafts WHERE id=$1::uuid',[invalid.id]))[0]!.raw_output,null);
  assert.deepEqual(await getPublicResearch(db,published.id),before); assert.deepEqual(await listPublicResearch(db,{productId}),list);
  assert.deepEqual((await q('SELECT to_jsonb(r) AS row FROM ep_research_records r WHERE id=$1::uuid',[published.id]))[0],canonical);
  assert.ok(!JSON.stringify(list).includes('SYNTH-DEVICE'));
});
test('original, ablated and independent control bundles are ready; deletion leaks no key evidence',async () => {
  for (const variant of ['original','ablated','control'] as const) {
    const {bundle} = await save(variant);
    const draft = await extractOfflineBundle(db,bundle.id,async input => {
      if (variant === 'ablated') assert.ok(!/without fluoroscopy|zero[- ]fluoro|no radiation/i.test(input.user));
      return fixedExtractionOutput(bundle,variant);
    });
    assert.equal(draft.citationStatus,'valid');
    if (variant !== 'original') assert.equal(draft.output!.groups[0]!.radiationStrategy,null);
  }
});
test('money/execution reservation persists across reload; insufficient amount reserves nothing',async () => {
  const {bundle} = await save(); const {request,approval} = priceApproval(bundle);
  const bad = {...approval,authorizedMicros:1};
  await assert.rejects(reserveExtractionTrial(db,bundle,request,bad),/Fee ceiling/);
  assert.equal((await q<{n:number}>('SELECT count(*)::int AS n FROM ep_research_extraction_trials WHERE authorization_key=$1',[approval.authorizationKey]))[0]!.n,0);
  const first = await reserveExtractionTrial(db,bundle,request,approval);
  const restarted = await reserveExtractionTrial(researchDatabase(sql),bundle,request,approval);
  assert.equal(restarted.id,first.id); assert.equal(Number(restarted.reserved_micros),10192);
  await claimExtractionTrial(db,first.id); await finishExtractionTrial(db,first.id,'received',null);
  const persisted = await loadExtractionTrial(researchDatabase(sql),first.id);
  assert.equal(persisted.execution_count,1); assert.equal(Number(persisted.reserved_micros),10192);
  await assert.rejects(claimExtractionTrial(db,first.id),/already consumed/);
  const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(path.resolve(relative)).href);
  const child = spawnSync(process.execPath,['--input-type=module','-e',
    `const {sql,closeDb}=await import(${moduleUrl('packages/backend/src/db.ts')});
     const {researchDatabase}=await import(${moduleUrl('packages/backend/src/research/postgres.ts')});
     const {loadExtractionTrial,claimExtractionTrial}=await import(${moduleUrl('packages/backend/src/research/extraction-budget.ts')});
     const db=researchDatabase(sql); const row=await loadExtractionTrial(db,${JSON.stringify(first.id)});
     let blocked=false; try {await claimExtractionTrial(db,row.id);} catch {blocked=true;}
     console.log(JSON.stringify({count:row.execution_count,reserved:Number(row.reserved_micros),blocked})); await closeDb();`],
    {env:{...process.env,MODEL_CALLS_ENABLED:'false'},encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()),{count:1,reserved:10192,blocked:true});
  await assert.rejects(executeExtractionTrial(db,first.id),/disabled/);
});
test('single concurrency and unknown outcomes block another round without releasing money',async () => {
  const {bundle} = await save(); const p1 = priceApproval(bundle); const p2 = priceApproval(bundle);
  const a = await reserveExtractionTrial(db,bundle,p1.request,p1.approval);
  const b = await reserveExtractionTrial(db,bundle,p2.request,p2.approval);
  const outcomes = await Promise.allSettled([claimExtractionTrial(db,a.id),claimExtractionTrial(db,b.id)]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length,1);
  const active = outcomes[0]!.status === 'fulfilled' ? a : b; const inactive = active.id === a.id ? b : a;
  await finishExtractionTrial(db,active.id,'unknown',null);
  await assert.rejects(claimExtractionTrial(db,inactive.id),/awaits reconciliation/);
  assert.equal((await loadExtractionTrial(db,active.id)).execution_count,1);
  assert.equal(Number((await loadExtractionTrial(db,active.id)).reserved_micros),10192);
  // Test-only cleanup of the synthetic pending state. Production has no automatic reconciliation.
  await q('DELETE FROM ep_research_extraction_trials WHERE id=$1::uuid',[active.id]);
});
test('offline timeout is stored as unknown, without retry; default live preflight remains blocked',async () => {
  const {bundle} = await save(); let hits = 0;
  const draft = await extractOfflineBundle(db,bundle.id,async () => {hits++;throw new ExtractionOutcomeUnknown('synthetic timeout');});
  assert.equal(hits,1); assert.equal(draft.state,'unknown'); assert.equal(draft.formatStatus,'not_received'); assert.equal(draft.citationStatus,'not_checked');
  const preflight = await extractionLivePreflight(db,bundle.id);
  assert.equal(preflight.ready,false); assert.equal(preflight.modelName,null); assert.equal(preflight.upperBoundMicros,null);
  assert.ok(preflight.inputUtf8Bytes > 0); assert.equal(preflight.modelCallsEnabled,false);
});
test('a preset cannot replace the actual provided messages with another material or answer key',async () => {
  const {bundle} = await save(); const previous = process.env.LLM_EXTRA_JSON;
  process.env.LLM_EXTRA_JSON = JSON.stringify({messages:[{role:'user',content:'SYNTHETIC forbidden answer-key substitution'}]});
  try {
    await assert.rejects(prepareExtractionRequest(db,bundle.id,'default'),/actual provided/);
    const preflight = await extractionLivePreflight(db,bundle.id,{modelKey:'default'});
    assert.equal(preflight.ready,false); assert.equal(preflight.canSendRealRequest,false);
  } finally {
    if (previous === undefined) delete process.env.LLM_EXTRA_JSON; else process.env.LLM_EXTRA_JSON = previous;
  }
});
