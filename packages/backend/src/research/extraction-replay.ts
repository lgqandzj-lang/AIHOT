// Pure saved-response replay. No DB, provider, configuration, receipt or execution imports.
import { z } from 'zod';
import { extractionSchema, modelExtractionSchema, modelExtractionGroupSchema,
  extractionCitationSchema, extractionRuleIssues, managedExtractionOutput,
  LEGACY_EXTRACTION_VERSION } from './extraction-schema.ts';
import { inputFingerprint } from './normalize.ts';

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export interface ReplayInput {
  materialId: string; materialHash: string; splitRuleVersion: string; scope: 'abstract'; fullTextProvided: false;
  providedFragmentIds: string[];
  fragments: Array<{citation: z.infer<typeof extractionCitationSchema>;sectionLabel: string|null;scope: 'abstract';text: string}>;
}
export interface FormatTransformation { path: string; rule: string; before: unknown; after: unknown; evidenceAdded: false }
export function normalizeExtractionFormat(raw: unknown, legacyResponse = false) {
  const candidate = structuredClone(raw);
  const transformations: FormatTransformation[] = [];
  const root = object(candidate);
  const record = (path: string, rule: string, before: unknown, after: unknown) => {
    transformations.push({path,rule,before:structuredClone(before),after:structuredClone(after),evidenceAdded:false});
    return after;
  };
  if (legacyResponse && root?.schemaVersion === LEGACY_EXTRACTION_VERSION) {
    record('schemaVersion','remove_legacy_program_version',root.schemaVersion,null);
    delete root.schemaVersion;
  }
  const value = (node: unknown, path: string): unknown => {
    if (node === null) return record(path,'legacy_null_to_unknown',null,{value:null,citations:[],status:'unknown'});
    if (typeof node === 'string' || typeof node === 'number') return record(path,'wrap_bare_value_without_evidence',node,{value:node,citations:[]});
    const item = object(node);
    if (item && Object.keys(item).length === 2 && Object.hasOwn(item,'value') && Object.hasOwn(item,'citation')) {
      const references = Array.isArray(item.citation) ? item.citation : [item.citation];
      return record(path,'rename_supplied_citation',item,{value:item.value,citations:references});
    }
    return node;
  };
  const list = (node: unknown, path: string): unknown => {
    // [] is deliberately untouched: it cannot establish unknown, non-use or non-applicability.
    if (Array.isArray(node)) return node.map((item,i)=>value(item,`${path}[${i}]`));
    return value(node,path);
  };
  if (Array.isArray(root?.groups)) root.groups.forEach((node,index) => {
    const group=object(node); if (!group) return;
    const base=`groups[${index}]`;
    for(const name of ['groupLabel','researchSubjects','radiationStrategy']) if(Object.hasOwn(group,name)) group[name]=value(group[name],base+'.'+name);
    for(const name of ['productRoles','imagingMethods']) if(Object.hasOwn(group,name)) group[name]=list(group[name],base+'.'+name);
    const sample=object(group.sample);
    if(sample) for(const name of ['quantity','unit','denominator']) if(Object.hasOwn(sample,name)) sample[name]=value(sample[name],base+'.sample.'+name);
    if(Array.isArray(group.observationTimes)) group.observationTimes.forEach((node,i)=>{
      const observation=object(node); if(!observation) return;
      for(const name of ['time','purpose']) if(Object.hasOwn(observation,name)) observation[name]=value(observation[name],`${base}.observationTimes[${i}].${name}`);
    });
    else if(Object.hasOwn(group,'observationTimes')) group.observationTimes=value(group.observationTimes,base+'.observationTimes');
  });
  return {candidate,transformations};
}

export function validateReplayInput(input: ReplayInput) {
  const materialId=z.uuid().parse(input.materialId);
  if(input.scope!=='abstract' || input.fullTextProvided!==false || !Array.isArray(input.fragments) || input.fragments.length>200
    || !Array.isArray(input.providedFragmentIds) || new Set(input.providedFragmentIds).size!==input.providedFragmentIds.length) throw new Error('Invalid saved abstract manifest');
  const ids=new Set<string>();
  for(const fragment of input.fragments) {
    const reference=extractionCitationSchema.parse(fragment.citation);
    if(fragment.scope!=='abstract' || typeof fragment.text!=='string' || fragment.text.length>100_000
      || !fragment.text.trim() || fragment.text.includes('\0') || reference.materialId!==materialId
      || reference.materialHash!==input.materialHash || reference.splitRuleVersion!==input.splitRuleVersion
      || reference.fragmentHash!==inputFingerprint({scope:'abstract',sectionLabel:fragment.sectionLabel,text:fragment.text})
      || ids.has(reference.fragmentId) || !input.providedFragmentIds.includes(reference.fragmentId)) throw new Error('Saved fragment identity mismatch');
    ids.add(reference.fragmentId);
  }
  if(ids.size!==input.providedFragmentIds.length) throw new Error('Saved provided fragment set mismatch');
}
export interface ReplayField {
  path:string; expected:string; actualShape:string; rawNode:unknown;
  formatErrors:string[]; citationStatus:'valid'|'missing'|'invalid'|'not_required'|'ambiguous'; citationErrors:string[];
  evidence:ReplayInput['fragments']; contentIssues:string[]; semanticStatus:'not_performed'; qualified:false;
}
const shape = (value: unknown): string => value === null ? 'null' : value === undefined ? 'missing'
  : Array.isArray(value) ? `array(${value.length})` : object(value) ? 'object{' + Object.keys(value as object).join(',') + '}' : typeof value;
const issuePaths = (schema:z.ZodType, node:unknown): string[] => {
  const parsed=schema.safeParse(node);
  return parsed.success ? [] : parsed.error.issues.map(item=>item.path.join('.')+':'+item.code);
};
/** Identity checks only. A reference to a real fragment cannot verify its conclusion. */
function citationCheck(node:unknown,input:ReplayInput): Pick<ReplayField,'citationStatus'|'citationErrors'|'evidence'> {
  const item=object(node);
  if(node===null || (item?.value===null && ['unknown','not_reported'].includes(String(item.status)) && Array.isArray(item.citations) && item.citations.length===0)) return {citationStatus:'not_required',citationErrors:[],evidence:[]};
  if(node===undefined || (Array.isArray(node) && node.length===0)) return {citationStatus:'ambiguous',citationErrors:['missing_or_ambiguous_value'],evidence:[]};
  const references=item?.citations;
  if(!Array.isArray(references) || references.length===0) return {citationStatus:'missing',citationErrors:['nonempty_claim_without_citation'],evidence:[]};
  const errors:string[]=[]; const evidence:ReplayInput['fragments']=[];
  for(const reference of references) {
    const parsed=extractionCitationSchema.safeParse(reference);
    if(!parsed.success) {errors.push('invalid_citation_shape');continue;}
    const found=input.fragments.find(fragment=>Object.entries(fragment.citation).every(([key,value])=>parsed.data[key as keyof typeof parsed.data]===value));
    if(!found) errors.push('citation_not_in_exact_provided_manifest'); else evidence.push(found);
  }
  return {citationStatus:errors.length?'invalid':'valid',citationErrors:errors,evidence};
}
function fieldChecks(raw:unknown,input:ReplayInput,legacy:boolean): ReplayField[] {
  const rows:ReplayField[]=[];
  const groups=object(raw)?.groups;
  if(!Array.isArray(groups)) return rows;
  // v1 is frozen and used only for faithful diagnostics of the original response.
  const legacyGroup=extractionSchema.shape.groups.element;
  const expectedValue=(type='text')=>`cited {value:${type},citations[1+]}`+(legacy?' or null (frozen v1)':' or explicit absence {value:null,citations,status}');
  groups.slice(0,20).forEach((node,index)=>{
    const group=object(node); if(!group) return;
    const base=`groups[${index}]`;
    const add=(path:string,value:unknown,schema:z.ZodType,expected=expectedValue())=>rows.push({path,expected,actualShape:shape(value),rawNode:value??null,
      formatErrors:issuePaths(schema,value),...citationCheck(value,input),contentIssues:[],semanticStatus:'not_performed',qualified:false});
    const g=legacy?legacyGroup.shape:modelExtractionGroupSchema.shape;
    for(const name of ['groupLabel','researchSubjects','radiationStrategy'] as const) add(base+'.'+name,group[name],g[name]);
    const sample=object(group.sample);
    const s=legacy?legacyGroup.shape.sample.removeDefault().unwrap().shape:modelExtractionGroupSchema.shape.sample.shape;
    for(const name of ['quantity','unit','denominator'] as const) add(base+'.sample.'+name,sample?.[name],s[name],expectedValue(name==='quantity'?'integer':'text'));
    for(const name of ['productRoles','imagingMethods'] as const) {
      const collection=group[name];
      if(Array.isArray(collection) && collection.length) {
        collection.forEach((item,i)=>{
          const v2=modelExtractionGroupSchema.shape[name].options[0].element;
          const v1=legacyGroup.shape[name].removeDefault().unwrap().unwrap().element;
          add(`${base}.${name}[${i}]`,item,legacy?v1:v2,expectedValue(name==='productRoles'?'{product:text,role:text}':'text'));
        });
      } else add(base+'.'+name,collection,g[name],legacy?'nonempty array of cited entries or null (v1); [] is invalid':'nonempty array of cited entries or explicit absence; [] is ambiguous');
    }
    if(Array.isArray(group.observationTimes) && group.observationTimes.length) {
      const v2=modelExtractionGroupSchema.shape.observationTimes.options[0].element.shape;
      const v1=legacyGroup.shape.observationTimes.removeDefault().unwrap().unwrap().element.shape;
      group.observationTimes.forEach((node,i)=>{const observation=object(node);
        for(const name of ['time','purpose'] as const) add(`${base}.observationTimes[${i}].${name}`,observation?.[name],legacy?v1[name]:v2[name]);
      });
    } else add(base+'.observationTimes',group.observationTimes,g.observationTimes,legacy?'nonempty array of {time,purpose} pairs or null (v1)':'nonempty array of {time,purpose} pairs or explicit absence');
  });
  for(const rule of extractionRuleIssues(raw)) for(const row of rows) {
    if(row.path===rule.path || row.path.startsWith(rule.path+'.')) row.contentIssues.push(rule.code);
  }
  return rows;
}
export function replayExtractionResponse(raw:unknown,input:ReplayInput,options:{legacyResponse?:boolean}={}) {
  validateReplayInput(input);
  const original=options.legacyResponse?extractionSchema.safeParse(raw):modelExtractionSchema.safeParse(raw);
  const normalized=normalizeExtractionFormat(raw,options.legacyResponse);
  const parsed=modelExtractionSchema.safeParse(normalized.candidate);
  const contentIssues=extractionRuleIssues(normalized.candidate);
  const before=fieldChecks(raw,input,options.legacyResponse===true);
  const after=fieldChecks(normalized.candidate,input,false);
  const blocked=after.some(row=>row.citationStatus==='missing'||row.citationStatus==='invalid');
  return {newModelCalls:0,realModelEffectValidated:false,semanticStatus:'not_performed' as const,
    originalFormatValid:original.success,originalFormatErrors:original.success?[]:original.error.issues.map(item=>({path:item.path,code:item.code})),
    normalizedFormatValid:parsed.success,normalizedFormatErrors:parsed.success?[]:parsed.error.issues.map(item=>({path:item.path,code:item.code})),
    candidate:normalized.candidate,transformations:normalized.transformations,before,after,contentIssues,
    normalizedDraft:parsed.success?managedExtractionOutput(parsed.data):null,
    state:parsed.success&&!blocked&&!contentIssues.length?'private_unverified':'invalid_output',
    humanReviewRequired:true,qualified:false};
}
