// Authored synthetic material. No sentence/number is copied from a paper.
import { abstractMetadata } from './ep-abstract.ts';
import { citationForAbstractFragment } from '../../packages/backend/src/research/abstract-evidence.ts';
import type { AbstractMaterialBundle, AbstractFragment } from '../../packages/backend/src/research/abstract-evidence.ts';
import type { LegacyExtractionOutput, ModelExtractionOutput } from '../../packages/backend/src/research/extraction-schema.ts';

export type ExtractionVariant = 'original'|'ablated'|'control';
const groupA = 'Group A included 12 adult participants; the sample denominator was all 12 enrolled participants. SYNTH-DEVICE was the evaluated study device. Echocardiography guided the procedure. Safety was observed at 30 days.';
const groupB = 'Group B included 8 adult participants; the sample denominator was all 8 enrolled participants. SYNTH-CONTROL was the comparison device. X-ray fluoroscopy guided the procedure with reduced fluoroscopy use. Feasibility was observed at 7 days.';
export function extractionMetadata(variant: ExtractionVariant, doi = '10.9999/ep-extraction-' + variant) {
  const sections = variant === 'control'
    ? [{label:'Group C',text:'Group C included 5 animals; the sample denominator was all 5 animals imaged. SYNTH-MARKER was used as a positioning tool. CT guided positioning. Device position was observed at 48 hours.'}]
    : [{label:'Group A',text:groupA}, ...(variant === 'original' ? [{label:'Group A strategy',text:'Group A was performed without fluoroscopy.'}] : []), {label:'Group B',text:groupB}];
  return abstractMetadata(doi,sections.map(item => item.label + ': ' + item.text).join('\n'),'plain',
    {title:'[SYNTHETIC] Study summaries',abstractSections:sections});
}
// Evaluation/fixed response only. This function is never imported by prompt or provider code.
export function fixedExtractionOutput(bundle: AbstractMaterialBundle, variant: ExtractionVariant): LegacyExtractionOutput {
  const source = (label: string) => bundle.fragments.find(item => item.sectionLabel === label)!;
  const value = <T>(item: AbstractFragment, field: T) => ({value:field,citations:[citationForAbstractFragment(item)]});
  const make = (label: string, index: number, count: number, subject: string, product: string, role: string,
    imaging: string, time: string, purpose: string, radiation: string | null) => {
    const item = source(label);
    return {groupId:'g' + index,groupLabel:value(item,label),productRoles:[value(item,{product,role})],
      researchSubjects:value(item,subject),sample:{quantity:value(item,count),unit:value(item,subject === 'animals' ? 'animals' : 'participants'),
        denominator:value(item,`all ${count} ${subject === 'animals' ? 'animals imaged' : 'enrolled participants'}`)},
      imagingMethods:[value(item,imaging)],radiationStrategy:radiation === null ? null : value(source(label + ' strategy') ?? item,radiation),
      observationTimes:[{time:value(item,time),purpose:value(item,purpose)}]};
  };
  return {schemaVersion:'ep-abstract-extract-v1',groups:variant === 'control'
    ? [make('Group C',1,5,'animals','SYNTH-MARKER','positioning tool','CT','48 hours','device position',null)]
    : [make('Group A',1,12,'adult participants','SYNTH-DEVICE','evaluated study device','echocardiography','30 days','safety',variant === 'original' ? 'without fluoroscopy' : null),
       make('Group B',2,8,'adult participants','SYNTH-CONTROL','comparison device','X-ray fluoroscopy','7 days','feasibility','reduced fluoroscopy use')]};
}

// Authored synthetic response for the current wire contract; no program metadata.
export function fixedModelExtractionOutput(bundle: AbstractMaterialBundle, variant: ExtractionVariant): ModelExtractionOutput {
  const convert = (value: unknown): unknown => value === null ? {value:null,citations:[],status:'unknown'}
    : Array.isArray(value) ? value.map(convert)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,convert(item)])) : value;
  return {groups:convert(fixedExtractionOutput(bundle,variant).groups)} as ModelExtractionOutput;
}

export function fixedCompactExtractionOutput(bundle: AbstractMaterialBundle, variant: ExtractionVariant) {
  const convert = (node: unknown): unknown => Array.isArray(node) ? node.map(convert)
    : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([key,value])=>
      [key,key === 'citations' ? (value as Array<{fragmentId:string}>).map(item=>item.fragmentId) : convert(value)])) : node;
  const result = convert(fixedModelExtractionOutput(bundle,variant)) as {groups:Array<{observationTimes:any}>};
  for(const item of result.groups) if(Array.isArray(item.observationTimes)) for(const observation of item.observationTimes) {
    observation.outcomeDenominator = {value:null,citations:[],status:'not_reported'};
  }
  return result;
}
