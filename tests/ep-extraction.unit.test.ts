import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { sha256, stableJson } from '../packages/backend/src/lib/ids.ts';
import { extractionSchema, extractionPrompt } from '../packages/backend/src/research/extraction-schema.ts';
import { trialPreflight } from '../packages/backend/src/research/extraction-budget.ts';
import type { LiveTrialApproval, FinalExtractionRequest } from '../packages/backend/src/research/extraction-budget.ts';
import type { AbstractMaterialBundle } from '../packages/backend/src/research/abstract-evidence.ts';
import { extractionMetadata, fixedExtractionOutput } from './fixtures/ep-extraction.ts';
import { MODELS, prepareChatJsonRequest } from '../packages/backend/src/providers/llm.ts';
import { z } from 'zod';

const bundle: AbstractMaterialBundle = { id:randomUUID(),materialId:randomUUID(),materialHash:'a'.repeat(64),splitRuleVersion:'abstract-source-v1',
  state:'ready',scope:'abstract',source:{provider:'crossref',providerId:'synthetic',sourceUrl:'https://example.org',acquiredAt:new Date().toISOString(),versionLabel:'synthetic'},
  fragments:[],providedFragmentIds:[],fullTextProvided:false,processingAuthorization:'not_evaluated',citationValidation:'identity_only' };
function fixtureBundle(variant: 'original'|'ablated'|'control') {
  const metadata = extractionMetadata(variant);
  const result = structuredClone(bundle);
  result.fragments = metadata.abstractSections!.map((item,index) => ({id:randomUUID(),materialId:result.materialId,
    materialHash:result.materialHash,splitRuleVersion:result.splitRuleVersion,ordinal:index + 1,sectionLabel:item.label,
    scope:'abstract' as const,text:item.text,fragmentHash:sha256(item.text)}));
  result.providedFragmentIds = result.fragments.map(item => item.id); return result;
}
const body = {model:'synthetic-model',messages:[{role:'user',content:'Synthetic prompt'}],temperature:0,max_tokens:2048};
const request: FinalExtractionRequest = {body,bodyHash:sha256(stableJson(body)),baseUrl:'https://provider.example/v1',modelKey:'synthetic',modelName:'synthetic-model',service:'synthetic'};
function approval(): LiveTrialApproval {
  const now = Date.now();
  return {authorizationKey:'SYNTHETIC-NOT-A-LIVE-GRANT',authorizedBy:'synthetic fixture',approvedAt:new Date(now - 1000).toISOString(),expiresAt:new Date(now + 60000).toISOString(),
    bundleId:bundle.id,materialHash:bundle.materialHash,modelKey:request.modelKey,modelName:'synthetic-model',endpoint:request.baseUrl!,requestHash:request.bodyHash,
    currency:'CNY',authorizedMicros:12000,materialProcessingBasis:'Authored synthetic test data',
    pricing:{basisUrl:'https://provider.example/synthetic-pricing',verifiedAt:new Date(now - 1000).toISOString(),validUntil:new Date(now + 60000).toISOString(),
      requestHash:request.bodyHash,inputTokenUpperBound:1000,inputCountingBasis:'SYNTHETIC count fixture; not a provider tokenizer result',
      inputMicrosPerMillion:2000000,outputMicrosPerMillion:4000000,additionalFeeMicros:0,
      billingCoverage:'all_input_output_reasoning_and_additional_fees',outputCapCoversAllBillableOutput:true}};
}
test('normal fixed response preserves two groups, denominator scopes and per-value citations', () => {
  const b = fixtureBundle('original');
  const parsed = extractionSchema.parse(fixedExtractionOutput(b,'original'));
  assert.deepEqual(parsed.groups.map(item => item.sample.quantity!.value),[12,8]);
  assert.equal(parsed.groups[0]!.radiationStrategy!.citations[0]!.fragmentId,b.fragments[1]!.id);
});
test('missing fields normalize to unknown, while a nonempty value without citations is invalid', () => {
  const parsed = extractionSchema.parse({schemaVersion:'ep-abstract-extract-v1',groups:[{groupId:'g1'}]});
  assert.equal(parsed.groups[0]!.radiationStrategy,null); assert.equal(parsed.groups[0]!.sample.quantity,null);
  assert.equal(extractionSchema.safeParse({schemaVersion:'ep-abstract-extract-v1',groups:[{groupId:'g1',researchSubjects:{value:'adults',citations:[]}}]}).success,false);
});
test('permissions/review fields, SQL, duplicate groups and non-JSON shapes are rejected', () => {
  const output = fixedExtractionOutput(fixtureBundle('original'),'original');
  for (const extra of [{publicationState:'published'},{reviewApproved:true},{sql:'SELECT * FROM ep_research_records'}]) {
    assert.equal(extractionSchema.safeParse({...output,...extra}).success,false);
  }
  output.groups[0]!.researchSubjects!.value = 'DROP TABLE ep_research_records';
  assert.equal(extractionSchema.safeParse(output).success,false);
  const duplicate = fixedExtractionOutput(fixtureBundle('original'),'original'); duplicate.groups[1]!.groupId = 'g1';
  assert.equal(extractionSchema.safeParse(duplicate).success,false); assert.equal(extractionSchema.safeParse('not JSON').success,false);
});
test('ablation checks title/all remaining fragments for leaked key evidence; answer keys are absent from input', () => {
  const b = fixtureBundle('ablated');
  const input = extractionPrompt(b,extractionMetadata('ablated').title).user;
  assert.ok(!/without fluoroscopy|zero[- ]fluoro|no radiation/i.test(input));
  assert.ok(!input.includes('radiationStrategy')); // Only material, no fixed response/answer schema.
  assert.equal(fixedExtractionOutput(b,'ablated').groups[0]!.radiationStrategy,null);
  assert.ok(!extractionPrompt(fixtureBundle('control'),null).user.includes('12 enrolled'));
});
test('monetary ceiling uses integer upward rounding, verified input bound and final output limit', () => {
  const result = trialPreflight(bundle,request,approval());
  assert.equal(result.ready,true); assert.equal(result.upperBoundMicros,10192);
  const small = approval(); small.authorizedMicros = 10191;
  assert.equal(trialPreflight(bundle,request,small).ready,false);
  const tiny = approval(); tiny.pricing.inputMicrosPerMillion = 1; tiny.pricing.outputMicrosPerMillion = 0;
  assert.equal(trialPreflight(bundle,request,tiny).upperBoundMicros,1);
});
test('missing grant/prices, wrong material/model/request, expired grant and unsupported billing parameters block', () => {
  assert.equal(trialPreflight(bundle,null).ready,false);
  for (const patch of [{materialProcessingBasis:''},{modelName:'other'},{requestHash:'b'.repeat(64)},{expiresAt:'2020-01-01T00:00:00.000Z'}]) {
    assert.equal(trialPreflight(bundle,request,{...approval(),...patch}).ready,false);
  }
  assert.equal(trialPreflight(bundle,{...request,body:{...body,n:2}},approval()).ready,false);
  assert.equal(trialPreflight(bundle,request,{...approval(),pricing:{...approval().pricing,outputCapCoversAllBillableOutput:false}}).ready,false);
});
test('final preparation includes 512 floor, thinking token addition and last preset overrides', () => {
  MODELS['synthetic-think'] = {key:'synthetic-think',service:'fixture',model:'synthetic-model',baseUrlEnv:'SYNTHETIC_URL',apiKeyEnv:'SYNTHETIC_KEY',jsonMode:true};
  try {
    const opts = {model:'synthetic-think',purpose:'fixture',subject:'fixture',promptVersion:'fixture',system:'s',user:'u',schema:z.unknown(),maxTokens:1};
    assert.equal(prepareChatJsonRequest(opts).body.max_tokens,4512);
    MODELS['synthetic-think']!.extra = {max_tokens:9000};
    assert.equal(prepareChatJsonRequest(opts).body.max_tokens,9000);
  } finally { delete MODELS['synthetic-think']; }
});
