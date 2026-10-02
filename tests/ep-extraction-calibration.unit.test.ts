import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { inputFingerprint } from '../packages/backend/src/research/normalize.ts';
import { compactExtractionSchema, extractionPrompt } from '../packages/backend/src/research/extraction-schema.ts';
import { validateCompactExtraction } from '../packages/backend/src/research/extraction-validation.ts';
import type { AbstractMaterialBundle } from '../packages/backend/src/research/abstract-evidence.ts';

// Authored synthetic examples only. These tests inspect contract coverage;
// they do not implement a semantic judge or introduce literature answer keys.
const absent = () => ({value:null,citations:[],status:'not_reported' as const});
function fixture() {
  const materialId=randomUUID(),materialHash=inputFingerprint({synthetic:'calibration'});
  const texts=[
    'Study Cedar enrolled patients. Safety was assessed during days 60-90.',
    'Symptomatic patients were eligible. Cedar enrolled 20 patients and Birch enrolled 30 patients, with 50 patients overall. During days 60-90, safety events occurred in 4 of 12 patients with an event during days 1-5 and in 2 of 8 patients without that event. Ultrasound guidance was not described. Fluoroscopy time was 6 minutes.',
  ];
  const fragments=texts.map((text,index)=>({id:randomUUID(),materialId,materialHash,
    splitRuleVersion:'abstract-source-v1',ordinal:index+1,sectionLabel:'Synthetic '+index,scope:'abstract' as const,text,
    fragmentHash:inputFingerprint({scope:'abstract',sectionLabel:'Synthetic '+index,text})}));
  const bundle:AbstractMaterialBundle={id:randomUUID(),materialId,materialHash,splitRuleVersion:'abstract-source-v1',
    state:'ready',scope:'abstract',source:{provider:'synthetic',providerId:'synthetic',sourceUrl:'https://example.org/synthetic',
      acquiredAt:'2026-10-01T00:00:00Z',versionLabel:'synthetic'},fragments,providedFragmentIds:fragments.map(f=>f.id),
    fullTextProvided:false,processingAuthorization:'not_evaluated',citationValidation:'identity_only'};
  const cite=<T>(value:T,index=1)=>({value,citations:[fragments[index]!.id]});
  const output={groups:[{groupId:'g1',groupLabel:cite('Cedar'),productRoles:absent(),
    researchSubjects:cite('Symptomatic patients'),sample:{quantity:cite(20),unit:cite('patients'),denominator:cite('patients enrolled in Cedar')},
    imagingMethods:absent(),radiationStrategy:absent(),observationTimes:[{time:cite('days 60-90'),purpose:cite('safety assessment'),
      outcomeDenominator:cite('12 patients with an event during days 1-5')}]}]};
  return {bundle,prompt:extractionPrompt(bundle,'[SYNTHETIC]'),output,cite};
}

test('v3 has group counts but no separately typed overall sample or overall/group role',()=>{
  const {output,cite}=fixture();assert.equal(compactExtractionSchema.safeParse(output).success,true);
  const groups=structuredClone(output);groups.groups.push({...structuredClone(groups.groups[0]!),groupId:'g2',
    groupLabel:cite('Birch'),sample:{quantity:cite(30),unit:cite('patients'),denominator:cite('patients enrolled in Birch')}});
  assert.equal(compactExtractionSchema.safeParse(groups).success,true);
  assert.equal(compactExtractionSchema.safeParse({...groups,overallSample:{quantity:cite(50),unit:cite('patients')}}).success,false);
  const typed=structuredClone(groups) as any;typed.groups[0].groupRole='overall';
  assert.equal(compactExtractionSchema.safeParse(typed).success,false);
  // A free-text extra group can pass shape checks; the contract cannot establish
  // that it represents a non-overlapping arm versus an overlapping overall population.
  const extra=structuredClone(groups);extra.groups.push({...structuredClone(extra.groups[0]!),groupId:'g3',groupLabel:cite('Overall'),
    sample:{quantity:cite(50),unit:cite('patients'),denominator:cite('all enrolled patients')}});
  assert.equal(compactExtractionSchema.safeParse(extra).success,true);
});

test('same endpoint/window can repeat with scoped denominators; independent population and result fields are unsupported',()=>{
  const {output,prompt,cite}=fixture();const raw=structuredClone(output);
  raw.groups[0]!.observationTimes.push({time:cite('days 60-90'),purpose:cite('safety assessment'),
    outcomeDenominator:cite('8 patients without an event during days 1-5')});
  const result=validateCompactExtraction(raw,prompt.input);
  assert.equal(result.formatStatus,'valid');assert.equal(result.semanticStatus,'not_evaluated');
  assert.equal((result.output!.groups[0]!.observationTimes as any)[0].outcomeDenominator.value,'12 patients with an event during days 1-5');
  assert.equal((result.output!.groups[0]!.observationTimes as any)[1].outcomeDenominator.value,'8 patients without an event during days 1-5');
  for(const key of ['populationCondition','numerator','resultValue','statistic','endpointId']) {
    const unsupported=structuredClone(raw) as any;unsupported.groups[0].observationTimes[0][key]=cite(key==='numerator'?4:'synthetic');
    assert.equal(compactExtractionSchema.safeParse(unsupported).success,false,key);
  }
});

test('window, population condition and sample scope stay separate; structural validity does not approve a swapped time',()=>{
  const {output,prompt,cite}=fixture();const original=JSON.stringify(output);
  const result=validateCompactExtraction(output,prompt.input);const observation=(result.output!.groups[0]!.observationTimes as any)[0];
  assert.equal(observation.time.value,'days 60-90');assert.match(observation.outcomeDenominator.value,/days 1-5/);
  assert.equal(result.output!.groups[0]!.sample.denominator.value,'patients enrolled in Cedar');
  const swapped=structuredClone(output);swapped.groups[0]!.observationTimes[0]!.time=cite('days 1-5');
  const unchecked=validateCompactExtraction(swapped,prompt.input);
  assert.equal(unchecked.formatStatus,'valid');assert.equal(unchecked.semanticStatus,'not_evaluated');assert.equal(unchecked.qualified,false);
  assert.equal(JSON.stringify(output),original);
});

test('unknown quantity allows a source-reported unit; an omitted unit remains omitted without deleting sibling fields',()=>{
  const {output,prompt}=fixture();const raw=structuredClone(output) as any;raw.groups[0].sample.quantity=absent();
  const known=validateCompactExtraction(raw,prompt.input);assert.equal(known.output!.groups[0]!.sample.unit.value,'patients');
  raw.groups[0].sample.unit=absent();const before=JSON.stringify(raw);const omitted=validateCompactExtraction(raw,prompt.input);
  assert.equal(omitted.output!.groups[0]!.sample.unit.value,null,'no automatic source repair');
  assert.equal(omitted.output!.groups[0]!.researchSubjects.value,'Symptomatic patients');
  assert.equal(omitted.output!.groups[0]!.sample.denominator.value,'patients enrolled in Cedar');
  assert.equal((omitted.output!.groups[0]!.observationTimes as any)[0].time.value,'days 60-90');
  assert.equal(omitted.sourceCoverageStatus,'not_evaluated','dependency checks cannot certify the omitted unit');
  assert.equal(omitted.qualified,false);assert.equal(JSON.stringify(raw),before);
});

test('a label qualifier must be checked against its own citations; a different provided fragment does not repair the binding',()=>{
  const {output,prompt,cite}=fixture();output.groups[0]!.groupLabel=cite('Symptomatic Cedar patients',0);
  const before=JSON.stringify(output),result=validateCompactExtraction(output,prompt.input);
  const label=result.output!.groups[0]!.groupLabel;
  const bound=prompt.input.fragments.filter(f=>label.citations.some(c=>c.fragmentId===f.citation.fragmentId));
  assert.equal(bound.length,1);assert.ok(!bound[0]!.text.includes('Symptomatic'));
  assert.ok(prompt.input.fragments[1]!.text.includes('Symptomatic'));
  assert.equal(result.citationStatus,'valid');assert.equal(result.semanticStatus,'not_evaluated');assert.equal(result.qualified,false);
  assert.deepEqual(label.citations.map(c=>c.fragmentId),output.groups[0]!.groupLabel.citations);
  assert.equal(JSON.stringify(output),before);
});

test('imaging text has no ultrasound enum; fluoroscopy duration has no procedural-metric slot and cannot establish a strategy',()=>{
  const {output,prompt,cite}=fixture();
  assert.equal(compactExtractionSchema.safeParse({...output,proceduralMetrics:[cite('6 minutes fluoroscopy')]}).success,false);
  const groupExtra=structuredClone(output) as any;groupExtra.groups[0].proceduralMetrics=[cite('6 minutes fluoroscopy')];
  assert.equal(compactExtractionSchema.safeParse(groupExtra).success,false);
  const freeText=structuredClone(output) as any;freeText.groups[0].imagingMethods=[cite('fluoroscopy')];
  assert.equal(compactExtractionSchema.safeParse(freeText).success,true,'free text is shape-valid, not a scoped semantic definition');
  const result=validateCompactExtraction(output,prompt.input);
  assert.equal(result.output!.groups[0]!.radiationStrategy.value,null);
  assert.equal(result.semanticStatus,'not_evaluated');assert.equal(result.qualified,false);
  assert.ok(!prompt.system.includes('Fluoroscopy time was 6 minutes'),'synthetic source belongs only in the user material');
});

test('source numeric conflicts are separate observations and never rewrite source text or the saved model value',()=>{
  const {bundle,output,cite}=fixture();const fragment=bundle.fragments[1]!;
  fragment.text='Cedar enrolled 20 patients. Safety events occurred in 30% (4/20) during days 60-90.';
  fragment.fragmentHash=inputFingerprint({scope:'abstract',sectionLabel:fragment.sectionLabel,text:fragment.text});
  const prompt=extractionPrompt(bundle,'[SYNTHETIC]');output.groups[0]!.observationTimes[0]!.outcomeDenominator=cite('20 patients');
  const rawBefore=JSON.stringify(output),sourceBefore=JSON.stringify(prompt.input),result=validateCompactExtraction(output,prompt.input);
  assert.equal(4/20,0.2);assert.ok(prompt.input.fragments[1]!.text.includes('30% (4/20)'));
  assert.equal((result.output!.groups[0]!.observationTimes as any)[0].outcomeDenominator.value,'20 patients');
  assert.equal(result.semanticStatus,'not_evaluated');assert.equal(result.qualified,false);
  assert.equal(JSON.stringify(output),rawBefore);assert.equal(JSON.stringify(prompt.input),sourceBefore);
});
