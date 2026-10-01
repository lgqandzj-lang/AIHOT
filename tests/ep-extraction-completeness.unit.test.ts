import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { inputFingerprint } from '../packages/backend/src/research/normalize.ts';
import { extractionPrompt, EXTRACTION_OUTPUT_TOKENS, extractionResponseSchema, readStoredExtractionOutput } from '../packages/backend/src/research/extraction-schema.ts';
import { parseExtractionContent, validateCompactExtraction } from '../packages/backend/src/research/extraction-validation.ts';
import { replayExtractionResponse } from '../packages/backend/src/research/extraction-replay.ts';
import { prepareChatJsonRequest } from '../packages/backend/src/providers/llm.ts';
import type { AbstractMaterialBundle } from '../packages/backend/src/research/abstract-evidence.ts';

// Entirely authored data and expectations; no paper answers or live requests.
const absent = () => ({value:null,citations:[],status:'not_reported' as const});
function fixture(text = 'Group Cedar enrolled 14 participants. Safety was assessed at 10 days among 11 participants with complete safety data.') {
  const materialId=randomUUID(),materialHash=inputFingerprint({synthetic:text});
  const fragment={id:randomUUID(),materialId,materialHash,splitRuleVersion:'abstract-source-v1',ordinal:1,
    sectionLabel:'Synthetic methods',scope:'abstract' as const,text,
    fragmentHash:inputFingerprint({scope:'abstract',sectionLabel:'Synthetic methods',text})};
  const bundle:AbstractMaterialBundle={id:randomUUID(),materialId,materialHash,splitRuleVersion:fragment.splitRuleVersion,
    state:'ready',scope:'abstract',source:{provider:'synthetic',providerId:'synthetic',sourceUrl:'https://example.org/synthetic',
      acquiredAt:new Date().toISOString(),versionLabel:'synthetic'},fragments:[fragment],providedFragmentIds:[fragment.id],
    fullTextProvided:false,processingAuthorization:'not_evaluated',citationValidation:'identity_only'};
  const cite=<T>(value:T)=>({value,citations:[fragment.id]});
  const output={groups:[{groupId:'g1',groupLabel:cite('Group Cedar'),researchSubjects:cite('enrolled participants'),
    productRoles:absent(),sample:{quantity:cite(14),unit:cite('participants'),denominator:cite('participants enrolled in Group Cedar')},
    imagingMethods:absent(),radiationStrategy:absent(),observationTimes:[{time:cite('10 days'),purpose:cite('safety assessment'),
      outcomeDenominator:cite('11 participants with complete safety data')}]}]};
  return {bundle,prompt:extractionPrompt(bundle,'[SYNTHETIC]','ep-abstract-extract-v3'),output,cite};
}
test('cohort scope and outcome denominator remain separate; faithful brief wording needs no answer-key match',()=>{
  const {output,prompt}=fixture();const result=validateCompactExtraction(output,prompt.input,{finishReason:'stop'});
  assert.equal(result.formatStatus,'valid');assert.equal(result.citationStatus,'valid');assert.equal(result.fieldCompletenessStatus,'required_fields_present');
  assert.equal(result.output!.groups[0]!.sample.quantity.value,14);
  const times=result.output!.groups[0]!.observationTimes;assert.ok(Array.isArray(times));
  assert.equal(times[0]!.outcomeDenominator.value,'11 participants with complete safety data');
  assert.ok(!String(times[0]!.outcomeDenominator.value).includes('14'));
  assert.equal(result.semanticStatus,'not_evaluated');assert.equal(result.sourceCoverageStatus,'not_evaluated');assert.equal(result.qualified,false);
  const noOutcome=structuredClone(output) as any;noOutcome.groups[0].observationTimes[0].outcomeDenominator=absent();
  assert.equal(validateCompactExtraction(noOutcome,prompt.input).output!.groups[0]!.sample.quantity.value,14);
  assert.equal((validateCompactExtraction(noOutcome,prompt.input).output!.groups[0]!.observationTimes as any)[0].outcomeDenominator.value,null,'no cohort-count inheritance');
});
test('deleted count with explicit unit retained allows unknown quantity and cited unit without reconstructing a number',()=>{
  const {output,prompt}=fixture('Group Cedar enrolled participants. Safety was assessed at 10 days.');
  const raw=structuredClone(output) as any;raw.groups[0].sample.quantity=absent();raw.groups[0].observationTimes[0].outcomeDenominator=absent();
  const result=validateCompactExtraction(raw,prompt.input);
  assert.equal(result.fieldCompletenessStatus,'required_fields_present');assert.equal(result.output!.groups[0]!.sample.quantity.value,null);
  assert.equal(result.output!.groups[0]!.sample.unit.value,'participants');assert.ok(prompt.input.fragments[0]!.text.includes('participants'));
});
test('deleted count and unit evidence allows both unknown; absent fields are not completed from other groups',()=>{
  const {output,prompt}=fixture('Group Cedar reported safety assessment at 10 days. The summary did not describe the study population.');
  const raw=structuredClone(output) as any;raw.groups[0].sample={quantity:absent(),unit:absent(),denominator:absent()};
  raw.groups[0].researchSubjects=absent();raw.groups[0].observationTimes[0].outcomeDenominator=absent();
  const result=validateCompactExtraction(raw,prompt.input);
  assert.equal(result.fieldCompletenessStatus,'required_fields_present');assert.equal(result.output!.groups[0]!.sample.unit.value,null);
  assert.ok(!prompt.input.fragments[0]!.text.includes('participants'));assert.equal(result.qualified,false);
});
test('nonempty count cannot bypass unit or population scope dependencies and citations',()=>{
  const {output,prompt}=fixture();
  for(const name of ['unit','denominator']) {
    const raw=structuredClone(output) as any;raw.groups[0].sample[name]=absent();const before=JSON.stringify(raw);
    const result=validateCompactExtraction(raw,prompt.input);
    assert.equal(result.formatStatus,'valid');assert.equal(result.fieldCompletenessStatus,'missing_dependencies');
    assert.ok(result.contentIssues.some(item=>item.path.endsWith('.sample.'+name)));assert.equal(result.completeCardAllowed,false);
    assert.equal(JSON.stringify(raw),before);assert.equal(result.output!.groups[0]!.sample[name as 'unit'|'denominator'].value,null);
  }
  const noCitation=structuredClone(output) as any;noCitation.groups[0].sample.quantity.citations=[];
  assert.equal(validateCompactExtraction(noCitation,prompt.input).formatStatus,'invalid');
});
test('real but unsupported citation has identity only, never semantic approval; foreign fragment is rejected',()=>{
  const {output,prompt}=fixture();const raw=structuredClone(output);raw.groups[0]!.observationTimes[0]!.time.value='400 days';
  const result=validateCompactExtraction(raw,prompt.input);assert.equal(result.citationStatus,'valid');
  assert.equal(result.semanticStatus,'not_evaluated');assert.equal(result.qualified,false);
  assert.equal((result.output!.groups[0]!.observationTimes as any)[0].time.value,'400 days','no unsupported-claim repair');
  raw.groups[0]!.sample.unit.citations=[randomUUID()];const rejected=validateCompactExtraction(raw,prompt.input);
  assert.equal(rejected.formatStatus,'valid');assert.equal(rejected.citationStatus,'invalid');assert.equal(rejected.output,null);
});
test('length stop blocks complete cards even for valid JSON; broken JSON is never repaired or extracted as a prefix',()=>{
  const {output,prompt}=fixture();const text=JSON.stringify(output),before=JSON.stringify(output);
  const result=validateCompactExtraction(output,prompt.input,{finishReason:'length',outputTokens:4096,maxTokens:4096});
  assert.equal(result.formatStatus,'valid');assert.equal(result.truncation.status,'truncated');assert.equal(result.output,null);
  assert.equal(result.completeCardAllowed,false);assert.throws(()=>parseExtractionContent(text,{finishReason:'length'}),/output_truncated/);
  assert.throws(()=>parseExtractionContent(text.slice(0,-3)),SyntaxError);assert.equal(JSON.stringify(output),before);
  assert.equal(validateCompactExtraction(output,prompt.input,{finishReason:'stop',outputTokens:4096}).truncation.status,'not_indicated','token count alone does not prove truncation');
  const stored=validateCompactExtraction(output,prompt.input).output!;
  const legacyWire={groups:stored.groups.map(({groupId,...group})=>({groupId,...group,observationTimes:(group.observationTimes as any[]).map(({outcomeDenominator,...observation})=>observation)}))};
  const replay=replayExtractionResponse(legacyWire,prompt.input,{finishReason:'length'});
  assert.equal(replay.originalFormatValid,true);assert.equal(replay.normalizedDraft,null);assert.equal(replay.state,'invalid_output');assert.equal(replay.transformations.length,0);
});
test('compact wire contains exact fragment IDs and research fields only; expansion retains immutable private identity',()=>{
  const {output,prompt,bundle}=fixture();const result=validateCompactExtraction(output,prompt.input);
  assert.deepEqual(JSON.parse(prompt.system.split('JSON_SCHEMA:\n')[1]),extractionResponseSchema('ep-abstract-extract-v3'));
  assert.ok(!prompt.user.includes('materialHash')&&!prompt.user.includes('materialId')&&!prompt.user.includes('fragmentHash'));
  assert.ok(prompt.user.includes(bundle.fragments[0]!.id));assert.equal(output.groups[0]!.sample.unit.citations[0],bundle.fragments[0]!.id);
  assert.equal(result.output!.groups[0]!.sample.unit.citations[0]!.materialHash,bundle.materialHash);
  assert.equal(readStoredExtractionOutput(result.output).schemaVersion,'ep-abstract-extract-v3');
  assert.equal(JSON.stringify(output).includes('schemaVersion'),false);
});
test('all-null research output never creates a successful complete card',()=>{
  const {output,prompt}=fixture();const raw=structuredClone(output) as any;
  for(const key of ['groupLabel','researchSubjects','productRoles','imagingMethods','radiationStrategy','observationTimes'])raw.groups[0][key]=absent();
  raw.groups[0].sample={quantity:absent(),unit:absent(),denominator:absent()};
  assert.equal(validateCompactExtraction(raw,prompt.input).completeCardAllowed,false);
});
test('4096 is limited to extraction preparation; another task keeps its own requested limit and all checks are offline',()=>{
  const original=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw new Error('No network');};
  try {
    const {prompt,output}=fixture();assert.equal(EXTRACTION_OUTPUT_TOKENS,4096);
    const opts={model:'deepseek-flash',purpose:'SYNTHETIC',subject:'SYNTHETIC',promptVersion:'SYNTHETIC',system:prompt.system,user:prompt.user,
      schema:z.unknown(),maxTokens:EXTRACTION_OUTPUT_TOKENS};
    assert.equal(prepareChatJsonRequest(opts).body.max_tokens,4096);
    assert.deepEqual(prepareChatJsonRequest(opts).body.thinking,{type:'disabled'});
    assert.equal(prepareChatJsonRequest({...opts,maxTokens:900}).body.max_tokens,900);
    validateCompactExtraction(output,prompt.input);assert.equal(requests,0);
  } finally {globalThis.fetch=original;}
});
