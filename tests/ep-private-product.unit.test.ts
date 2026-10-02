import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateProductEntry } from '../packages/backend/src/research/private-product.ts';

const source={name:'Owned synthetic bibliography',url:'https://example.invalid/owned-source',acquiredAt:'2026-09-30T00:00:00.000Z'};
const record={id:'owned-record',version:2,publishedOn:'2024-05-06',studyDesign:'unknown' as const,materialScope:'abstract' as const};

test('only an explicit brand in the same saved title or abstract confirms product membership',()=>{
  const named={id:'owned-reader',title:'VARIPULSE: an owned synthetic prospective study',sources:[source]};
  const confirmed=privateProductEntry(named)!;
  assert.equal(confirmed.product.status,'confirmed');assert.equal(confirmed.product.evidence.quote,named.title);
  const generic={...named,title:'Owned variable-loop circular catheter study'};
  assert.equal(privateProductEntry(generic),undefined);
  const candidate=privateProductEntry(generic,record)!;
  assert.equal(candidate.product.status,'candidate');assert.equal(candidate.studyType,'类型待核对');
  const withAbstract={...generic,privateDraft:{status:'private_auto_draft',sourceAbstract:{sourceUrl:source.url,fragments:[{label:'Owned source',text:'This owned source identifies VARIPULSE as the device evaluated.'}]}}};
  assert.equal(privateProductEntry(withAbstract,record)!.product.status,'confirmed');
  assert.equal(privateProductEntry({...generic,privateDraft:{status:'private_auto_draft',sourceAbstract:{sourceUrl:source.url,fragments:[{label:null,text:'The owned study uses a variable-loop circular catheter.'}]}}},record)!.product.status,'candidate');
});

test('question shortcuts are backed by the saved title and never by model conclusions or cohort aliases',()=>{
  const input={id:'owned-reader',title:'Owned zero-fluoroscopy workflow: a synthetic report',sources:[source]};
  const before=structuredClone(input),entry=privateProductEntry(input,record)!;
  assert.deepEqual(entry.questions.map(question=>question.id),['zero-fluoro']);
  assert.equal(entry.questions[0].evidence.quote,input.title);assert.equal(entry.questions[0].evidence.url,source.url);
  const neutral={...input,title:'Owned study without a declared research question',privateDraft:{status:'private_auto_draft',sourceAbstract:{sourceUrl:source.url,fragments:[{label:null,text:'A model-only notion about same-day discharge is not a title category.'}]}}};
  assert.deepEqual(privateProductEntry(neutral,record)!.questions,[]);
  assert.deepEqual(input,before);
});

test('publication precision, material scope and persistent record versions stay independent of acquisition time',()=>{
  const input={id:'owned-reader',title:'Owned VARIPULSE case report',sources:[source]};
  const bibliography=privateProductEntry(input)!,abstract=privateProductEntry(input,record)!;
  assert.equal(bibliography.publishedOn,null);assert.equal(bibliography.materialScope,'metadata');assert.equal(bibliography.studyType,'病例报告');
  assert.equal(abstract.publishedOn,'2024-05-06');assert.equal(abstract.recordId,record.id);assert.equal(abstract.readerVersion,2);assert.equal(abstract.materialScope,'abstract');
  assert.ok(!JSON.stringify(abstract).includes(source.acquiredAt));
});
