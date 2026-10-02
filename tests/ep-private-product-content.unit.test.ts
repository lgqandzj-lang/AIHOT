import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPrivateProductContent, parsePrivateProductContent } from '../packages/backend/src/research/private-product-content.ts';
import { privateProductEntry } from '../packages/backend/src/research/private-product.ts';

const url='https://pubmed.ncbi.nlm.nih.gov/1/';
const paper={id:'owned-reader',title:'Owned synthetic generic catheter workflow',pmid:'1',doi:'10.9999/owned-content',sources:[{name:'Owned test metadata',url,acquiredAt:'2026-09-30T00:00:00.000Z'}],
  privateDraft:{status:'private_auto_draft',sourceAbstract:{sourceUrl:url,fragments:[{text:'Owned abstract',label:null}]},modelOriginal:'Preserved owned clinical draft'}};
const record={id:'owned-record',version:1,publishedOn:null,studyDesign:'unknown' as const,materialScope:'abstract' as const};
const original={...paper,privateResearch:privateProductEntry(paper,record)!};
const time='2026-10-01T00:00:00.000Z';
const device={label:'Owned synthetic publisher evidence',quote:'The owned study used VARIPULSE.',url:'https://academic.oup.com/owned-test-article',location:'Owned Methods section',acquiredAt:time,kind:'publisher',role:'article_device',articlePmid:'1',articleDoi:paper.doi};
const content=()=>({version:'private-product-content-v1',curation:'assistant_curated',runtimeAutomaticExtraction:false,entries:[{
  recordId:record.id,pmid:paper.pmid,doi:paper.doi,originalTitle:paper.title,
  display:{titleZh:'自有合成测试标题',leadZh:'只介绍自有题名中的研究问题。',curation:'assistant_curated',basisScope:'title',basisUrl:url,preparedAt:time},
  association:{reviewer:'assistant_source_check',method:'article_fulltext',checkedAt:time,studyId:null,note:'Owned test association only.',sources:[structuredClone(device)]},
}]});

test('independent assistant curation confirms only product association and leaves the clinical draft and original metadata intact',()=>{
  const before=structuredClone(original), updated=applyPrivateProductContent(original,parsePrivateProductContent(content()));
  assert.equal(updated.privateResearch.product.status,'confirmed');assert.equal(updated.privateResearch.product.verification!.reviewer,'assistant_source_check');
  assert.equal(updated.privateResearch.display!.curation,'assistant_curated');assert.equal(updated.privateResearch.materialScope,'abstract');
  assert.equal(updated.title,original.title);assert.equal(updated.privateDraft,original.privateDraft);assert.equal(updated.sources,original.sources);
  assert.deepEqual(original,before);assert.equal(applyPrivateProductContent(original,[]),original);
});

test('bibliography identity, saved material scope and curation provenance cannot be replaced by a sidecar',()=>{
  for(const key of ['pmid','doi','originalTitle'] as const){const source=content();source.entries[0][key]=key==='pmid'?'2':key==='doi'?'10.9999/foreign':'Foreign title';source.entries[0].association=null as any;
    assert.throws(()=>applyPrivateProductContent(original,parsePrivateProductContent(source)));}
  const source=content();source.entries[0].display.basisScope='abstract';
  assert.throws(()=>applyPrivateProductContent({...original,privateResearch:{...original.privateResearch,materialScope:'metadata'}},parsePrivateProductContent(source)));
  const automatic=content();automatic.runtimeAutomaticExtraction=true;assert.throws(()=>parsePrivateProductContent(automatic));
  const approved=content();approved.entries[0].display.curation='human_approved';assert.throws(()=>parsePrivateProductContent(approved));
});

test('external quotes require a matching article and explicit device, while missing evidence retains the original candidate',()=>{
  for(const kind of ['foreign-article','generic-device','foreign-domain','future-time']){
    const source=content(),evidence=source.entries[0].association.sources[0];
    if(kind==='foreign-article')evidence.articlePmid='2';else if(kind==='generic-device')evidence.quote='A generic catheter.';else if(kind==='foreign-domain')evidence.url='https://foreign.invalid/article';else evidence.acquiredAt='2026-10-02T00:00:00.000Z';
    assert.throws(()=>parsePrivateProductContent(source));
  }
  const source=content();source.entries[0].association=null as any;
  assert.equal(applyPrivateProductContent(original,parsePrivateProductContent(source)).privateResearch.product.status,'candidate');
});

test('a registered study requires the same identifier in article and official sources plus an explicit product on that official page',()=>{
  const source=content() as any,id='NCT00000001',official='https://www.jnjmedtech.com/owned-test-study';
  source.entries[0].association={reviewer:'assistant_source_check',method:'study_registration',checkedAt:time,studyId:id,note:'Owned synthetic identity chain.',sources:[
    {...device,quote:'Owned article registration: '+id,kind:'pubmed',role:'article_registration',url},
    {...device,quote:'Owned official registration: '+id,kind:'official_product',role:'official_registration',url:official,articlePmid:null,articleDoi:null},
    {...device,quote:'Owned registered study used VARIPULSE.',kind:'official_product',role:'official_device',url:official,articlePmid:null,articleDoi:null},
  ]};
  assert.equal(applyPrivateProductContent(original,parsePrivateProductContent(source)).privateResearch.product.verification!.studyId,id);
  for(const kind of ['missing-official','different-id','different-page']){
    const changed=structuredClone(source);
    if(kind==='missing-official')changed.entries[0].association.sources.splice(1,1);else if(kind==='different-id')changed.entries[0].association.sources[1].quote='NCT00000002';else changed.entries[0].association.sources[2].url=official+'-foreign';
    assert.throws(()=>parsePrivateProductContent(changed));
  }
});
