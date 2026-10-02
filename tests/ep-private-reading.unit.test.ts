import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateDraftProjection } from '../packages/backend/src/research/private-reading.ts';
import { checkNewLiteratureBudget, consumeNewLiteratureSlot, newPaperArguments, stopNewLiteratureAfter } from '../scripts/ep-pr2b-new-paper.ts';
import type { NewLiteratureLedger } from '../scripts/ep-pr2b-new-paper.ts';
import { sha256, stableJson } from '../packages/backend/src/lib/ids.ts';

const fragmentId='11111111-1111-4111-8111-111111111111',materialId='22222222-2222-4222-8222-222222222222',draftId='33333333-3333-4333-8333-333333333333';
const quote='Ten patients had AF. Three received the first workflow; seven received the second.';
const citation={fragmentId,materialId,materialHash:'a'.repeat(64),splitRuleVersion:'synthetic-fixture',fragmentHash:'b'.repeat(64)};
const hash=(value:unknown)=>sha256(stableJson(value));
const field=(path:string,value:unknown)=>({groupId:'g1',path,value,citations:[citation],evidence:[{reference:citation,identity:'valid' as const,scope:'abstract' as const,label:'Owned source',text:quote}],semanticStatus:'not_evaluated' as const});
const fields=[field('groupLabel','first workflow'),field('researchSubjects','AF patients'),field('sample.quantity',3),field('sample.unit','patients'),field('sample.denominator','first workflow')];
const report={draftId,origin:'live' as const,state:'private_draft' as const,bundleId:materialId,materialId,materialHash:'a'.repeat(64),providedFragmentIds:[fragmentId],
  formatStatus:'valid' as const,citationStatus:'valid' as const,semanticStatus:'not_evaluated' as const,fieldCompletenessStatus:'required_fields_present' as const,
  sourceCoverageStatus:'not_evaluated' as const,truncationStatus:'not_indicated' as const,realModelEffectValidated:false,fields,issues:[]};
const catalog={version:'private-reader-v1' as const,materialId,draftId,readerId:'owned-source',family:'owned cohort',processingAllowed:true,
  attribution:{copyright:'Owned source',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',changesNotice:'Synthetic fixture'},reviews:[] as unknown[]};
function reviewed() {return {...catalog,reviews:[{draftId,method:'assistant_source_comparison',humanApprovalGranted:false,rows:fields.map(field=>({groupId:field.groupId,path:field.path,verdict:'source_supported',
  reason:'Explicit comparison of the saved value and its bound source',quotes:[{fragmentId,quote}],valueHash:hash(field.value),citationHash:hash(field.citations)}))}]};}

test('citation identity and valid structure alone do not expose unreviewed model values',()=>{
  const before=structuredClone(report),draft=privateDraftProjection(report,catalog);
  assert.equal(draft.state,'unreviewed');assert.equal(draft.reviewMethod,'not_evaluated');assert.deepEqual(draft.groups,[]);assert.deepEqual(report,before);
});
test('same projection retains the saved group count and refuses source-group denominator substitution',()=>{
  const projected=privateDraftProjection(report,reviewed());assert.equal(projected.groups[0].quantity,3);assert.equal(projected.groups[0].populationScope,'first workflow');
  const different=structuredClone(report);different.fields.find(field=>field.path==='sample.quantity')!.value=7;
  const changed=privateDraftProjection(different,reviewed());assert.equal(changed.groups[0].quantity,null);assert.equal(changed.groups[0].subjects,'AF patients');
});
test('missing sample scope suppresses the number while supported subjects survive',()=>{
  const review=reviewed();review.reviews[0].rows.find(row=>row.path==='sample.denominator')!.verdict='citation_incomplete';
  const result=privateDraftProjection(report,review);assert.equal(result.groups[0].quantity,null);assert.equal(result.groups[0].unit,null);assert.equal(result.groups[0].subjects,'AF patients');
});
test('truncation, invalid format, citation failure and claimed human approval cannot form a basic model card',()=>{
  for(const altered of [{...report,truncationStatus:'truncated' as const},{...report,formatStatus:'invalid' as const},{...report,citationStatus:'invalid' as const}])assert.deepEqual(privateDraftProjection(altered,reviewed()).groups,[]);
  const forged=reviewed();forged.reviews[0].humanApprovalGranted=true;assert.deepEqual(privateDraftProjection(report,forged).groups,[]);
});
test('no unrelated raw, review, outcome or debug fields enter the reader projection',()=>{
  const dto=JSON.stringify(privateDraftProjection({...report,issues:['SYNTHETIC_INTERNAL_ERROR']},reviewed()));
  for(const marker of ['SYNTHETIC_INTERNAL_ERROR','valueHash','humanApprovalGranted','materialHash','semanticStatus','qualified','outcomeDenominator'])assert.ok(!dto.includes(marker));
});

const cases=['N1','N2','N3'].map((key,index)=>({key,pmid:String(index+1),doi:'10.9999/owned.'+index,upperBoundMicros:50000,
  materialId,recordId:materialId,bundleId:materialId,requestHash:'a'.repeat(64),metadataHash:'b'.repeat(64),family:'owned '+index,processingAllowed:true}));
const ledger:NewLiteratureLedger={batchId:'new-user-grant',currency:'CNY',authorizedMicros:1_000_000,maxActualRequests:3,cumulativeConsumedRequests:0,reservedMicros:0,state:'ready',sends:[]};
test('the independent ledger cannot reset, repeat, overlap, enlarge the fee or substitute duplicate literature',()=>{
  assert.equal(checkNewLiteratureBudget(ledger,cases),150000);
  const once=consumeNewLiteratureSlot(ledger,cases,'N1');assert.equal(once.cumulativeConsumedRequests,1);
  assert.throws(()=>consumeNewLiteratureSlot(once,cases,'N1'));assert.throws(()=>consumeNewLiteratureSlot(once,cases,'N2'));
  assert.throws(()=>checkNewLiteratureBudget({...once,cumulativeConsumedRequests:0},cases));
  assert.throws(()=>checkNewLiteratureBudget(ledger,cases.map(item=>({...item,upperBoundMicros:400000}))));
  assert.throws(()=>checkNewLiteratureBudget(ledger,[cases[0],cases[0],cases[2]]));
  once.sends![0].state='invalid_output';assert.equal(consumeNewLiteratureSlot(once,cases,'N2').cumulativeConsumedRequests,2);
  for(const state of ['unknown','rejected','in_flight'])assert.equal(stopNewLiteratureAfter(state),true);
  for(const state of ['invalid_output','received'])assert.equal(stopNewLiteratureAfter(state),false);
});
test('single-paper entry requires one identifier and explicit execution, with prepare always non-executing',()=>{
  assert.equal(newPaperArguments(['run','1','--directory','.data/owned','--execute-once']).identifier.pmid,'1');
  assert.equal(newPaperArguments(['prepare','https://doi.org/10.9999/OWNED','--directory','.data/owned']).identifier.doi,'10.9999/owned');
  for(const args of [['run','1','--directory','.data/owned'],['prepare','1','--directory','.data/owned','--execute-once'],['run','1','2','--directory','.data/owned','--execute-once']])assert.throws(()=>newPaperArguments(args));
});
