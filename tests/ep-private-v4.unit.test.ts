import assert from 'node:assert/strict';
import { test } from 'node:test';
import { structuredExtractionFixture, ambiguousStructuredFixture } from './fixtures/ep-extraction-structure.ts';
import { extractionPrompt, extractionFields } from '../packages/backend/src/research/extraction-schema.ts';
import { validateStructuredExtraction } from '../packages/backend/src/research/extraction-validation.ts';
import { privateDraftProjection, registerPrivateReading } from '../packages/backend/src/research/private-reading.ts';
import { consumeSingleLiteratureSlot } from '../scripts/ep-pr2b-new-paper.ts';
import { sha256, stableJson } from '../packages/backend/src/lib/ids.ts';
import type { Database } from '../packages/backend/src/research/contracts.ts';

const attribution={copyright:'Owned test material',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',changesNotice:'Test-only structured adaptation'};
const hash=(value:unknown)=>sha256(stableJson(value));
function setup(fixture:ReturnType<typeof structuredExtractionFixture>|ReturnType<typeof ambiguousStructuredFixture>=structuredExtractionFixture()) {
  const input=extractionPrompt(fixture.bundle,'[SYNTHETIC TEST ONLY]').input;
  const checked=validateStructuredExtraction(fixture.output,input);assert.ok(checked.output);
  const draftId='33333333-3333-4333-8333-333333333333';
  const fields=extractionFields(checked.output).map(field=>({...field,semanticStatus:'not_evaluated' as const,
    evidence:field.citations.map(reference=>({reference,identity:'valid' as const,scope:'abstract' as const,label:'Synthetic source',text:fixture.bundle.fragments[0]!.text}))}));
  const report={draftId,origin:'live' as const,state:checked.privateDraftAllowed?'private_draft' as const:'invalid_output' as const,
    bundleId:fixture.bundle.id,materialId:fixture.bundle.materialId,materialHash:fixture.bundle.materialHash,providedFragmentIds:fixture.bundle.providedFragmentIds,
    formatStatus:checked.formatStatus,citationStatus:checked.citationStatus,semanticStatus:'not_evaluated' as const,
    fieldCompletenessStatus:checked.fieldCompletenessStatus,sourceCoverageStatus:'not_evaluated' as const,
    truncationStatus:'not_indicated' as const,realModelEffectValidated:false,fields,issues:[]};
  const catalog={version:'private-reader-v1' as const,materialId:fixture.bundle.materialId,draftId,readerId:'test-v4',family:'Owned test',processingAllowed:true,attribution,reviews:[] as unknown[]};
  return {fixture,output:checked.output,report,catalog};
}

test('single-paper CNY 1 grant is consumed once and cannot reset, overlap or raise its ceiling',()=>{
  const ledger={batchId:'separate-user-grant',currency:'CNY',authorizedMicros:1_000_000,maxActualRequests:1,cumulativeConsumedRequests:0,reservedMicros:0,state:'ready',sends:[]};
  const before=structuredClone(ledger),once=consumeSingleLiteratureSlot(ledger,'OWNED',90000);
  assert.equal(once.cumulativeConsumedRequests,1);assert.equal(once.reservedMicros,90000);assert.deepEqual(ledger,before);
  assert.throws(()=>consumeSingleLiteratureSlot(once,'OWNED',90000));
  assert.throws(()=>consumeSingleLiteratureSlot({...once,cumulativeConsumedRequests:0},'OWNED',90000));
  assert.throws(()=>consumeSingleLiteratureSlot(ledger,'OWNED',1_000_001));
  assert.throws(()=>consumeSingleLiteratureSlot({...ledger,maxActualRequests:3},'OWNED',90000));
});

test('v4 unified projection keeps multi-unit raw counts, result owners and time roles pending before comparison',()=>{
  const {report,catalog,output}=setup(),before=stableJson({report,output});
  const draft=privateDraftProjection(report,catalog,output),sections=draft.sections!;
  assert.equal(draft.state,'unreviewed');assert.deepEqual(draft.groups,[]);
  assert.ok(sections.find(section=>section.id==='overall')?.fields.some(field=>field.modelValue.includes('22 participants')));
  assert.ok(sections.find(section=>section.id==='overall')?.fields.some(field=>field.modelValue.includes('88 pulmonary veins')));
  assert.ok(sections.find(section=>section.id==='g1')?.fields.some(field=>field.modelValue.includes('48 minutes')));
  assert.ok(sections.find(section=>section.id==='g2')?.fields.some(field=>field.modelValue.includes('26 minutes')));
  assert.ok(sections.find(section=>section.id==='g1')?.fields.some(field=>field.label==='流程阶段（非随访）'));
  assert.ok(sections.find(section=>section.id==='g1')?.fields.some(field=>field.label==='结局观察窗口'&&field.modelValue.includes('12–12 months')));
  assert.ok(sections.every(section=>section.fields.every(field=>field.review==='pending')));
  assert.equal(stableJson({report,output}),before);
});

test('source comparison changes badges, never replaces saved model values or resolves unknown ownership',()=>{
  const {report,catalog,output}=setup();
  const rows=report.fields.map(field=>({groupId:field.groupId,path:field.path,verdict:field.value===null?'material_not_reported':'source_supported',
    reason:'Test comparison only',quotes:field.citations.map(c=>({fragmentId:c.fragmentId,quote:report.fields[0].evidence[0].text})),valueHash:hash(field.value),citationHash:hash(field.citations)}));
  rows.find(row=>row.path==='results[0].population')!.verdict='source_conflict';
  catalog.reviews=[{draftId:report.draftId,method:'assistant_source_comparison',humanApprovalGranted:false,rows}];
  const draft=privateDraftProjection(report,catalog,output);
  assert.equal(draft.state,'degraded');
  assert.equal(draft.sections!.find(section=>section.id==='g1')!.fields.find(field=>field.key.includes('results[0]'))!.review,'pending');
  assert.equal(draft.sections!.find(section=>section.id==='g2')!.fields.find(field=>field.key.includes('results[1]'))!.review,'source_supported');
  assert.ok(draft.sections!.find(section=>section.id==='g1')!.fields.some(field=>field.modelValue.includes('48 minutes')));
  const ambiguous=setup(ambiguousStructuredFixture());
  const pending=privateDraftProjection(ambiguous.report,ambiguous.catalog,ambiguous.output);
  const unresolved=pending.sections!.find(section=>section.id==='unresolved')!;
  assert.ok(unresolved.fields.some(field=>field.modelValue.includes('17 minutes')&&field.review==='pending'));
  assert.ok(unresolved.fields.some(field=>field.modelValue.includes('29 minutes')&&field.review==='pending'));
  assert.ok(!pending.sections!.some(section=>section.id==='comparison'));
});

test('adding a live reader version preserves the old binding and reviews and rejects replacing either URL',async()=>{
  const materialId='11111111-1111-4111-8111-111111111111',recordId='22222222-2222-4222-8222-222222222222';
  const oldDraft='33333333-3333-4333-8333-333333333333',newDraft='44444444-4444-4444-8444-444444444444';
  const original={version:'private-reader-v1',materialId,draftId:oldDraft,readerId:'old-reader',family:'Owned test',processingAllowed:true,attribution,reviews:[{id:'old-immutable-review'}]};
  const data:{privateReading:typeof original;privateReadingVersions?:unknown[]}={privateReading:structuredClone(original)};
  const query=async({text,values}:any)=>{
    if(text.includes('FROM ep_research_materials'))return [{id:materialId,record_id:recordId,metadata:{title:'Owned test source'},intake_state:'linked'}];
    if(text.includes('FROM ep_research_extraction_drafts'))return [{material_id:materialId,origin:'live'}];
    if(text.startsWith('SELECT private_data'))return [{private_data:structuredClone(data)}];
    if(text.includes("'{privateReadingVersions}'")){data.privateReadingVersions=structuredClone(values[1]);return [];}
    throw new Error('Unexpected test query');
  };
  const db={query,transaction:async(action:any)=>action({query})} as unknown as Database;
  const input={materialId,draftId:newDraft,readerId:'draft-'+newDraft,family:'Owned test',processingAllowed:true,attribution,appendVersion:true};
  const card=await registerPrivateReading(db,input);assert.equal(card.readerId,input.readerId);
  assert.deepEqual(data.privateReading,original);assert.equal(data.privateReadingVersions!.length,1);
  await registerPrivateReading(db,input);assert.equal(data.privateReadingVersions!.length,1);
  await assert.rejects(()=>registerPrivateReading(db,{...input,readerId:'old-reader'}));
  await assert.rejects(()=>registerPrivateReading(db,{...input,appendVersion:false}));
  assert.deepEqual(data.privateReading,original);
});
