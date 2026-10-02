import assert from 'node:assert/strict';
import {test} from 'node:test';
import {structuredExtractionFixture} from './fixtures/ep-extraction-structure.ts';
import {extractionPrompt} from '../packages/backend/src/research/extraction-schema.ts';
import {normalizeStructuredCollections,replayStructuredCollections,checkedStructuredReadingParts} from '../packages/backend/src/research/extraction-format-compat.ts';
import {stableJson} from '../packages/backend/src/lib/ids.ts';

function fixture(){const source=structuredExtractionFixture();return {raw:structuredClone(source.output) as any,input:extractionPrompt(source.bundle,'Owned synthetic fixture').input};}
function wrapped(){const {raw,input}=fixture();for(const group of raw.groups){const references=[input.providedFragmentIds[0]];
  group.productRoles={value:[{product:'Owned synthetic catheter',role:'Owned synthetic ablation'}],citations:references};
  group.imagingMethods={value:[{value:'Owned synthetic mapping',citations:references}],citations:references};}return {raw,input};}

test('bounded v4 conversion preserves every value, citation and unrelated field; original failure stays separate',()=>{
  const {raw,input}=wrapped(),before=stableJson(raw),replay=replayStructuredCollections(raw,input,{finishReason:'stop'});
  assert.equal(replay.transformations.length,4);assert.equal(stableJson(raw),before);
  assert.equal(replay.original.formatStatus,'invalid');assert.equal(replay.original.output,null);
  assert.equal(replay.converted.formatStatus,'valid');assert.equal(replay.converted.citationStatus,'valid');
  assert.equal(replay.modelOriginalPassed,false);assert.equal(replay.conversionIsModelSuccess,false);
  assert.equal(replay.semanticApprovalGranted,false);assert.equal(replay.humanApprovalGranted,false);
  assert.equal(replay.publicApprovalGranted,false);assert.equal(replay.converted.semanticStatus,'not_evaluated');
  assert.deepEqual((replay.candidate as any).overallSample,raw.overallSample);assert.deepEqual((replay.candidate as any).results,raw.results);
  for(const change of replay.transformations){assert.equal(change.evidenceAdded,false);if(change.path.endsWith('productRoles'))assert.deepEqual((change.after as any[]).map(item=>item.value),(change.before as any).value);
    else assert.deepEqual(change.after,(change.before as any).value);}
  assert.equal(normalizeStructuredCollections(replay.candidate).transformations.length,0);
});

test('ambiguous multiple bare products, empty arrays, extra keys and mismatched imaging references are not coerced',()=>{
  const {raw}=wrapped();raw.groups[0].productRoles.value.push(structuredClone(raw.groups[0].productRoles.value[0]));
  raw.groups[1].productRoles.value=[];raw.groups[0].imagingMethods.citations=['99999999-9999-4999-8999-999999999999'];
  raw.groups[1].imagingMethods.status='unknown';const before=stableJson(raw),checked=normalizeStructuredCollections(raw);
  assert.equal(checked.transformations.length,0);assert.equal(stableJson(checked.candidate),before);assert.equal(stableJson(raw),before);
});

test('duplicate or unprovided references remain citation errors; conversion never supplies a reference',()=>{
  const {raw,input}=wrapped();raw.groups[0].productRoles.citations.push(raw.groups[0].productRoles.citations[0]);
  assert.ok(!normalizeStructuredCollections(raw).transformations.some(change=>change.path==='groups[0].productRoles'));
  const next=wrapped();next.raw.results[0].metric.citations=['99999999-9999-4999-8999-999999999999'];
  const checked=checkedStructuredReadingParts(normalizeStructuredCollections(next.raw).candidate,input);
  assert.ok(checked.deferred.some(item=>item.path==='results[0]'));assert.ok(!checked.parts.some(item=>item.path==='results[0]'));
});

test('local product and imaging errors keep source-independent group counts and dependent valid results readable',()=>{
  const {raw,input}=wrapped(),before=stableJson(raw),checked=checkedStructuredReadingParts(raw,input,{finishReason:'stop'});
  assert.equal(checked.deferred.filter(item=>/productRoles|imagingMethods/.test(item.path)).length,4);
  for(const path of ['overallSample[0]','groups[0].sample[0]','groups[1].sample[0]','results[0]','results[1]'])assert.ok(checked.parts.some(item=>item.path===path),path);
  assert.equal(checked.humanApprovalGranted,false);assert.equal(stableJson(raw),before);
});

test('invalid group identity defers its results, stages, outcome windows and comparisons while keeping the other group',()=>{
  const {raw,input}=fixture();raw.groups[0].groupLabel.citations=['99999999-9999-4999-8999-999999999999'];
  const checked=checkedStructuredReadingParts(raw,input);
  assert.ok(checked.parts.some(item=>item.path==='overallSample[0]'));
  assert.ok(checked.parts.some(item=>item.path==='results[1]'));
  assert.ok(!checked.parts.some(item=>item.groupId==='g1'||item.path==='comparisons[0]'));
  assert.ok(checked.deferred.some(item=>item.path==='results[0]'));
});

test('duplicate group IDs and result IDs never establish dependencies by order',()=>{
  const {raw,input}=fixture();raw.groups[1].groupId=raw.groups[0].groupId;
  const checked=checkedStructuredReadingParts(raw,input);assert.ok(!checked.parts.some(item=>item.path.startsWith('results[')));
  const other=fixture();other.raw.results[1].resultId=other.raw.results[0].resultId;
  const result=checkedStructuredReadingParts(other.raw,other.input);assert.ok(!result.parts.some(item=>item.path==='results[0]'||item.path==='results[1]'||item.path==='comparisons[0]'));
});

test('unresolved ownership and duration windows are withheld instead of guessed or presented as follow-up',()=>{
  const {raw,input}=fixture();raw.results[0].population={value:null,citations:[],status:'unknown'};
  const checked=checkedStructuredReadingParts(raw,input);assert.ok(!checked.parts.some(item=>item.path==='results[0]'||item.path==='comparisons[0]'));
  const other=fixture();other.raw.observationTimes[0].resultId=other.raw.results[0].resultId;
  assert.ok(!checkedStructuredReadingParts(other.raw,other.input).parts.some(item=>item.path==='observationTimes[0]'));
});

test('truncated response is never normalized or projected into readable automatic results',()=>{
  const {raw,input}=wrapped(),replay=replayStructuredCollections(raw,input,{finishReason:'length'});
  assert.equal(replay.transformations.length,0);assert.equal(replay.converted.output,null);
  assert.deepEqual(checkedStructuredReadingParts(raw,input,{finishReason:'length'}).parts,[]);
});
