import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256, stableJson } from '../packages/backend/src/lib/ids.ts';
import { extractionPrompt, extractionResponseSchema, modelExtractionSchema, EXTRACTION_RULES,
  extractionRuleIssues, managedExtractionOutput } from '../packages/backend/src/research/extraction-schema.ts';
import { replayExtractionResponse, normalizeExtractionFormat } from '../packages/backend/src/research/extraction-replay.ts';
import type { ReplayInput } from '../packages/backend/src/research/extraction-replay.ts';
import { replayCostRecord, replayPrivatePath } from '../scripts/ep-pr2b-replay.ts';
import { extractionOutputDirectory } from '../scripts/ep-pr2b-extract-one.ts';
import { inputFingerprint } from '../packages/backend/src/research/normalize.ts';
import { fixedModelExtractionOutput, fixedCompactExtractionOutput } from './fixtures/ep-extraction.ts';
import type { AbstractMaterialBundle } from '../packages/backend/src/research/abstract-evidence.ts';

function fixture() {
  const materialId=randomUUID(); const text='[SYNTHETIC] Group C included 5 animals; all 5 animals imaged formed its denominator. SYNTH-MARKER was a positioning tool. CT guided positioning. Device position was observed at 48 hours.';
  const materialHash=inputFingerprint({authoredFixture:text});
  const fragment={id:randomUUID(),materialId,materialHash,splitRuleVersion:'abstract-source-v1',ordinal:1,sectionLabel:'Group C',scope:'abstract' as const,text,
    fragmentHash:inputFingerprint({scope:'abstract',sectionLabel:'Group C',text})};
  const bundle:AbstractMaterialBundle={id:randomUUID(),materialId,materialHash,splitRuleVersion:fragment.splitRuleVersion,state:'ready',scope:'abstract',
    source:{provider:'synthetic',providerId:'synthetic',sourceUrl:'https://example.org/synthetic',acquiredAt:new Date().toISOString(),versionLabel:'synthetic'},
    fragments:[fragment],providedFragmentIds:[fragment.id],fullTextProvided:false,processingAuthorization:'not_evaluated',citationValidation:'identity_only'};
  const prompt=extractionPrompt(bundle,'[SYNTHETIC] Offline contract');
  const output=fixedModelExtractionOutput(bundle,'control');
  return {bundle,prompt,input:prompt.input as ReplayInput,output};
}
test('current prompt contains exactly the validator-generated shape, only research output; fixture example is synthetic',()=>{
  const {prompt,output}=fixture();
  assert.deepEqual(JSON.parse(prompt.system.split('JSON_SCHEMA:\n')[1]),extractionResponseSchema());
  assert.deepEqual(extractionResponseSchema().required,['groups']);
  assert.equal(modelExtractionSchema.safeParse(output).success,true);
  for(const extra of [{schemaVersion:'ep-abstract-extract-v2'},{processing:{}},{publicationState:'published'},{reviewApproved:true}]) assert.equal(modelExtractionSchema.safeParse({...output,...extra}).success,false);
  assert.equal(managedExtractionOutput(output).schemaVersion,'ep-abstract-extract-v2');
  assert.ok(prompt.user.includes('SYNTHETIC')); assert.ok(!prompt.user.includes('radiationStrategy'));
  const spaced=structuredClone(output) as any;spaced.groups[0].researchSubjects.value='  animals  ';
  assert.equal((modelExtractionSchema.parse(spaced).groups[0]!.researchSubjects).value,'  animals  ','validation does not silently transform values');
  spaced.groups[0].researchSubjects.value='   ';assert.equal(modelExtractionSchema.safeParse(spaced).success,false);
});
test('bare numbers/strings only get empty evidence wrappers; original remains immutable and result rejected',()=>{
  const {output,input}=fixture(); const raw=structuredClone(output) as any;
  raw.groups[0].sample.quantity=5; raw.groups[0].sample.unit='animals';
  const original=JSON.stringify(raw); const result=replayExtractionResponse(raw,input);
  assert.equal(JSON.stringify(raw),original); assert.equal(result.normalizedFormatValid,false);
  assert.equal(result.state,'invalid_output'); assert.equal(result.normalizedDraft,null);
  assert.deepEqual((result.candidate as any).groups[0].sample.quantity,{value:5,citations:[]});
  assert.ok(result.after.filter(row=>row.path.includes('sample.')).some(row=>row.citationStatus==='missing'));
  assert.ok(result.transformations.every(item=>item.evidenceAdded===false)); assert.equal(result.qualified,false);
});
test('only explicit singular citation packaging is normalized; misspelling and wrong value type stay invalid',()=>{
  const {output,input}=fixture(); const raw=structuredClone(output) as any;
  const original=raw.groups[0].sample.quantity;
  raw.groups[0].sample.quantity={value:original.value,citation:original.citations[0]};
  const result=replayExtractionResponse(raw,input); assert.equal(result.normalizedFormatValid,true);
  assert.equal(result.transformations[0]!.rule,'rename_supplied_citation');
  assert.deepEqual((result.candidate as any).groups[0].sample.quantity.citations,original.citations);
  assert.equal(result.qualified,false,'format correction never constitutes semantic approval');
  raw.groups[0].sample.quantity={amount:5,citations:original.citations};
  assert.equal(replayExtractionResponse(raw,input).normalizedFormatValid,false);
  raw.groups[0].sample.quantity={value:'5',citations:original.citations};
  assert.equal(replayExtractionResponse(raw,input).normalizedFormatValid,false,'numeric strings are not inferred');
});
test('ambiguous empty arrays never become non-use; unknown, not_reported and not_applicable differ',()=>{
  const {output,input}=fixture(); const raw=structuredClone(output) as any;
  raw.groups[0].imagingMethods=[];
  const result=replayExtractionResponse(raw,input); assert.deepEqual((result.candidate as any).groups[0].imagingMethods,[]);
  assert.equal(result.normalizedFormatValid,false); assert.equal(result.after.find(row=>row.path.endsWith('imagingMethods'))!.citationStatus,'ambiguous');
  for(const status of ['unknown','not_reported']) {
    raw.groups[0].imagingMethods={value:null,citations:[],status};
    assert.equal(replayExtractionResponse(raw,input).normalizedFormatValid,true);
  }
  raw.groups[0].imagingMethods={value:null,citations:[],status:'not_applicable'};
  assert.equal(replayExtractionResponse(raw,input).normalizedFormatValid,false);
  raw.groups[0].imagingMethods={value:null,citations:output.groups[0]!.researchSubjects.citations,status:'not_applicable'};
  const cited=replayExtractionResponse(raw,input); assert.equal(cited.normalizedFormatValid,true); assert.equal(cited.semanticStatus,'not_performed'); assert.equal(cited.qualified,false);
  raw.groups[0].imagingMethods={value:null,citations:[{bad:'SYNTHETIC'}],status:'unknown'};
  assert.equal(replayExtractionResponse(raw,input).after.find(row=>row.path.endsWith('imagingMethods'))!.citationStatus,'invalid');
});
test('a technology in a product slot is rejected independently of formatting/real citation identity',()=>{
  const {output,input}=fixture(); const raw=structuredClone(output) as any;
  raw.groups[0].productRoles[0].value.product='PFA';
  const result=replayExtractionResponse(raw,input); assert.equal(result.normalizedFormatValid,true); assert.equal(result.state,'invalid_output');
  assert.ok(result.contentIssues.some(item=>item.code==='technology_is_not_product'));
  assert.equal((result.candidate as any).groups[0].productRoles[0].value.product,'PFA','no product substitution');
});
test('missing, forged and real-but-unsupported references cannot create a qualified field',()=>{
  const {output,input}=fixture(); const raw=structuredClone(output) as any;
  raw.groups[0].researchSubjects.citations=[];
  const missing=replayExtractionResponse(raw,input); assert.equal(missing.after.find(row=>row.path.endsWith('researchSubjects'))!.citationStatus,'missing');
  raw.groups[0].researchSubjects.citations=structuredClone(output.groups[0]!.researchSubjects.citations);
  raw.groups[0].researchSubjects.citations[0].fragmentId=randomUUID();
  assert.equal(replayExtractionResponse(raw,input).after.find(row=>row.path.endsWith('researchSubjects'))!.citationStatus,'invalid');
  raw.groups[0].researchSubjects=structuredClone(output.groups[0]!.researchSubjects);
  raw.groups[0].observationTimes[0].time.value='365 days';
  const unsupported=replayExtractionResponse(raw,input);
  const field=unsupported.after.find(row=>row.path.endsWith('.time'))!;
  assert.equal(field.citationStatus,'valid'); assert.ok(field.evidence[0]!.text.includes('48 hours'));
  assert.equal(field.semanticStatus,'not_performed'); assert.equal(field.qualified,false); assert.equal(unsupported.qualified,false);
});
test('known sample quantities require unit and denominator; neither is filled automatically',()=>{
  const {output,input}=fixture(); const raw=structuredClone(output) as any;
  raw.groups[0].sample.denominator={value:null,citations:[],status:'unknown'};
  const result=replayExtractionResponse(raw,input); assert.equal(result.normalizedFormatValid,true);
  assert.ok(result.contentIssues.some(item=>item.path.endsWith('sample.denominator'))); assert.equal(result.state,'invalid_output');
  assert.deepEqual((result.candidate as any).groups[0].sample.denominator,raw.groups[0].sample.denominator);
});
test('a time without its purpose is retained but blocked; no purpose is inferred',()=>{
  const {output,input}=fixture(); const raw=structuredClone(output) as any;
  raw.groups[0].observationTimes[0].purpose={value:null,citations:[],status:'not_reported'};
  const result=replayExtractionResponse(raw,input); assert.ok(result.contentIssues.some(item=>item.code==='observation_pair_missing'));
  assert.equal(result.state,'invalid_output'); assert.equal((result.candidate as any).groups[0].observationTimes[0].purpose.value,null);
});
test('legacy null is only unknown; legacy program version is stripped with a record, never promoted',()=>{
  const {output,input}=fixture(); const raw=structuredClone(output) as any;
  raw.schemaVersion='ep-abstract-extract-v1'; raw.groups[0].radiationStrategy=null;
  const result=replayExtractionResponse(raw,input,{legacyResponse:true});
  assert.ok(result.transformations.some(item=>item.rule==='remove_legacy_program_version'));
  assert.deepEqual((result.candidate as any).groups[0].radiationStrategy,{value:null,citations:[],status:'unknown'});
  assert.equal(raw.schemaVersion,'ep-abstract-extract-v1'); assert.equal(result.qualified,false);
  assert.equal(modelExtractionSchema.safeParse({...output,schemaVersion:'ep-abstract-extract-v2'}).success,false);
});
test('rules/prompt changes and repeated replay have no model or network entry point',async()=>{
  const {output,input,prompt,bundle}=fixture(); const originalFetch=globalThis.fetch; let requests=0;
  globalThis.fetch=async()=>{requests++;throw new Error('No network allowed by offline replay');};
  const previous=EXTRACTION_RULES.sample_scope_missing;
  try {
    (EXTRACTION_RULES as Record<string,string>).sample_scope_missing=previous+' SYNTHETIC rule revision.';
    assert.notEqual(extractionPrompt(bundle,null).system,prompt.system);
    for(let i=0;i<2;i++) assert.equal(replayExtractionResponse(output,input).newModelCalls,0);
    assert.equal(requests,0);
    for(const name of ['../packages/backend/src/research/extraction-replay.ts','../scripts/ep-pr2b-replay.ts']) {
      const source=await readFile(new URL(name,import.meta.url),'utf8');
      assert.ok(!/from ['"].*(?:providers|abstract-extraction|extraction-budget|config|db)\.ts['"]|chatJson|executeExtractionTrial|paidRequest/.test(source));
    }
  } finally {(EXTRACTION_RULES as Record<string,string>).sample_scope_missing=previous;globalThis.fetch=originalFetch;}
});
test('historical fee estimate, response/request model and call-time basis remain distinct from actual bill',()=>{
  const record=replayCostRecord({body:{model:'SYNTHETIC-request'}},{cost:null,usage:{prompt_tokens:10,completion_tokens:4},response:{model:'SYNTHETIC-response',created:1}},
    {currency:'CNY',model:'SYNTHETIC-request',officialUrl:'https://provider.example/synthetic-pricing',verifiedAt:'2026-01-01T00:00:00Z',peak:{cacheMissInputPerMillion:2,cacheHitInputPerMillion:1,outputPerMillion:8}});
  assert.equal(record.cost_actual,null); assert.equal(record.cost_estimated.peak,0.000052);
  assert.equal(record.request_model,'SYNTHETIC-request'); assert.equal(record.response_model,'SYNTHETIC-response');
  assert.ok(record.called_at_basis.includes('request start unavailable')); assert.equal(record.price_snapshot_refreshed,false);
  assert.equal(record.new_paid_requests,0); assert.equal(normalizeExtractionFormat(undefined).candidate,undefined);
});
test('offline CLI refuses execution flags, paths outside private storage and overwriting its output',async()=>{
  const invalid=spawnSync(process.execPath,['scripts/ep-pr2b-replay.ts','run','--execute-once'],{encoding:'utf8',env:{...process.env,MODEL_CALLS_ENABLED:'true'},timeout:10000,windowsHide:true});
  assert.equal(invalid.status,2); assert.ok(!invalid.stdout);
  await assert.rejects(replayPrivatePath(process.cwd(),'package.json'),/private JSON/);
  const directory=path.resolve('.data/ep-pr2b','replay-test-'+randomUUID()); await mkdir(directory);
  try {
    const {prompt,bundle}=fixture();
    const body={model:'SYNTHETIC-replay',messages:[{role:'system',content:prompt.system},{role:'user',content:prompt.user}],response_format:{type:'json_object'},max_tokens:2048};
    const files={request:{body,bodyHash:sha256(stableJson(body))},input:prompt,
      receipt:{cost:null,response:{model:'SYNTHETIC-replay',created:1,
        choices:[{finish_reason:'length',message:{content:JSON.stringify(fixedCompactExtractionOutput(bundle,'control'))}}],
        usage:{prompt_tokens:10,completion_tokens:4}}},
      failure:{formatStatus:'valid',issues:[]},pricing:{model:'SYNTHETIC-replay',currency:'CNY',officialUrl:'https://provider.example/synthetic-pricing',verifiedAt:'2026-01-01T00:00:00Z',peak:{cacheMissInputPerMillion:2,cacheHitInputPerMillion:1,outputPerMillion:8}}};
    const args:string[]=[];
    for(const [name,data] of Object.entries(files)) {const filename=path.join(directory,name+'.json');await writeFile(filename,JSON.stringify(data),'utf8');args.push('--'+name,filename);}
    const out=path.join(directory,'replay-result'); args.push('--out-dir',out);
    const invoke=()=>spawnSync(process.execPath,['scripts/ep-pr2b-replay.ts',...args],{encoding:'utf8',env:{...process.env,MODEL_CALLS_ENABLED:'true'},timeout:10000,windowsHide:true});
    assert.equal(invoke().status,0);
    const report=await readFile(path.join(out,'replay.json'),'utf8');
    assert.equal(JSON.parse(report).metadata.truncationAssessment,'provider_reports_length_limit');
    assert.equal(JSON.parse(report).normalizedDraft,null);assert.equal(JSON.parse(report).after.length,0);
    assert.equal(invoke().status,2,'output directory cannot be reused');
    assert.equal(await readFile(path.join(out,'replay.json'),'utf8'),report);
    assert.ok((await replayPrivatePath(process.cwd(),path.join(directory,'request.json'))).endsWith('request.json'));
  }
  finally {const relative=path.relative(path.resolve('.data/ep-pr2b'),directory);assert.ok(/^replay-test-[0-9a-f-]+$/.test(relative));await rm(directory,{recursive:true});}
});
test('later prepare/run cannot overwrite saved request, response or original failure',async()=>{
  const root=path.resolve('.data/ep-pr2b','replay-test-'+randomUUID());await mkdir(root);
  try {
    const bundleId=randomUUID();const original=await extractionOutputDirectory(root,bundleId,'run');await mkdir(original,{recursive:true});
    await writeFile(path.join(original,'execution.json'),'{"SYNTHETIC":"saved"}','utf8');
    const separate=await extractionOutputDirectory(root,bundleId,'prepare');assert.ok(separate.startsWith(original+path.sep));assert.ok(separate!==original);
    await assert.rejects(extractionOutputDirectory(root,bundleId,'run'),/consumed/);
    assert.equal(await readFile(path.join(original,'execution.json'),'utf8'),'{"SYNTHETIC":"saved"}');
  } finally {const relative=path.relative(path.resolve('.data/ep-pr2b'),root);assert.ok(/^replay-test-[0-9a-f-]+$/.test(relative));await rm(root,{recursive:true});}
});
