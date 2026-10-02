import type { ChineseResearchReading, ResearchPaper } from './contracts';

const object = (value: unknown): Record<string,unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved prose projection');
  return value as Record<string,unknown>;
};
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid saved prose text');
  return value;
};
const https = (value: unknown) => { const url=new URL(text(value,3000)); if(url.protocol!=='https:' || url.username || url.password)throw new Error('Invalid prose source'); return url.href; };

/** Adds a source-bound, already generated private draft through HTTP. This module never imports models or databases. */
export function attachChineseReadings(papers: ResearchPaper[], value: unknown): ResearchPaper[] {
  const raw = object(value);
  if (raw.private !== true || !Array.isArray(raw.readings) || raw.readings.length > 100) throw new Error('Saved prose must be explicitly private');
  const used = new Set<string>();
  const readings = raw.readings.map(value => {
    const raw = object(value), readerId=text(raw.readerId,100), paper=papers.find(paper=>paper.id===readerId);
    if (!paper || used.has(readerId) || raw.pmid!==paper.pmid || raw.doi!==paper.doi || raw.originalTitle!==paper.title) throw new Error('Saved prose does not match its bibliography');
    used.add(readerId);
    if (raw.status!=='private_model_draft' || raw.humanApprovalGranted!==false || raw.materialScope!=='fulltext'
      || !['not_evaluated','assistant_source_comparison'].includes(String(raw.semanticStatus))) throw new Error('Saved prose provenance changed');
    const generatedAt=text(raw.generatedAt,50); if(!Number.isFinite(Date.parse(generatedAt)))throw new Error('Invalid generation date');
    if(!Array.isArray(raw.sources) || raw.sources.length>100)throw new Error('Invalid prose sources');
    const sources=raw.sources.map(value=>{
      const source=object(value), id=text(source.id,80), scope=source.scope;
      if (!/^(AB|FT)\d+$/.test(id) || !['abstract','fulltext'].includes(String(scope)) || id.startsWith('AB')!==(scope==='abstract')) throw new Error('Invalid separate source scope');
      const hash=text(source.hash,64);if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid source fingerprint');
      return {id,scope:scope as 'abstract'|'fulltext',label:text(source.label,300),text:text(source.text,24000),sourceUrl:https(source.sourceUrl),hash};
    });
    if(new Set(sources.map(source=>source.id)).size!==sources.length)throw new Error('Duplicate prose source');
    const markdown=text(raw.markdown,22000),html=text(raw.html,50000);
    if(/<(?:script|iframe|img|style|svg|object)\b|\bon\w+\s*=|javascript:/i.test(html)
      || [...html.matchAll(/href="([^"]+)"/g)].some(match=>!/^#reading-evidence-(AB|FT)\d+$/.test(match[1]!))) throw new Error('Unsafe prose markup');
    const ids=[...markdown.matchAll(/\[((?:AB|FT)\d+)\]/g)].map(match=>match[1]!);
    if(!ids.length || ids.some(id=>!sources.some(source=>source.id===id)))throw new Error('Missing prose citation');
    const license=object(raw.license);
    if(!Array.isArray(raw.corrections) || raw.corrections.length>20)throw new Error('Invalid prose corrections');
    const corrections=raw.corrections.map(value=>{
      const change=object(value);
      if(!['markdown','leadZh'].includes(String(change.field)) || !Array.isArray(change.sourceIds) || !change.sourceIds.length
        || change.sourceIds.some(id=>!sources.some(source=>source.id===id)))throw new Error('Correction evidence missing');
      return {field:change.field as 'markdown'|'leadZh',before:text(change.before,22000),after:text(change.after,22000),reason:text(change.reason,1000),sourceIds:change.sourceIds as string[]};
    });
    const reading:ChineseResearchReading={status:'private_model_draft',titleZh:text(raw.titleZh,180),leadZh:text(raw.leadZh,400),markdown,html,
      materialScope:'fulltext',generatedAt,model:text(raw.model,100),semanticStatus:raw.semanticStatus as ChineseResearchReading['semanticStatus'],humanApprovalGranted:false,
      correctionNotes:Array.isArray(raw.correctionNotes)?raw.correctionNotes.map(note=>text(note,1000)):[],
      corrections,
      sources,license:{name:text(license.name,100),url:https(license.url),copyright:text(license.copyright,300),changesNotice:text(license.changesNotice,2000)}};
    const recordId=paper.privateResearch?.recordId;
    const target=recordId?papers.filter(candidate=>candidate.privateResearch?.recordId===recordId)
      .sort((a,b)=>b.privateResearch!.readerVersion-a.privateResearch!.readerVersion)[0]!:paper;
    if(target.pmid!==paper.pmid || target.doi!==paper.doi || target.title!==paper.title)throw new Error('Reading version bibliography changed');
    return {readerId:target.id,reading};
  });
  return papers.map(paper=>{const reading=readings.find(entry=>entry.readerId===paper.id)?.reading;return reading?{...paper,chineseReading:reading}:paper;});
}

const sameBibliography = (left: ResearchPaper, right: ResearchPaper) => left.pmid === right.pmid && left.doi === right.doi && left.title === right.title;
const recordKey = (paper: ResearchPaper) => paper.privateResearch ? `record:${paper.privateResearch.recordId}` : `reader:${paper.id}`;

/** Each supplemental paper passes the existing whitelist; a rejected row cannot close unrelated saved readings. */
export function mergeSavedChineseReadings(papers: ResearchPaper[], value: unknown, projectPaper?: (value: unknown) => ResearchPaper): ResearchPaper[] {
  const raw = object(value);
  if (raw.private !== true || !Array.isArray(raw.readings) || raw.readings.length > 100) throw new Error('Saved prose must be explicitly private');
  if (raw.papers !== undefined && (!Array.isArray(raw.papers) || raw.papers.length > 100)) throw new Error('Invalid saved bibliography list');
  if (Array.isArray(raw.papers) && raw.papers.length && !projectPaper) throw new Error('Saved bibliography projection is required');
  const candidates = [...papers];
  for (const value of raw.papers as unknown[] | undefined || []) {
    try {
      const paper = projectPaper!(value);
      if (!paper.privateResearch) throw new Error('Saved bibliography needs its record identity');
      const related = candidates.filter(candidate => candidate.id === paper.id || recordKey(candidate) === recordKey(paper)
        || paper.pmid !== null && candidate.pmid === paper.pmid || paper.doi !== null && candidate.doi === paper.doi || candidate.title === paper.title);
      if (related.some(candidate => !sameBibliography(candidate, paper))) throw new Error('Saved bibliography changed');
      const existing = candidates.findIndex(candidate => candidate.id === paper.id);
      if (existing < 0) candidates.push(paper);
      else if (!candidates[existing]!.privateResearch) candidates[existing] = paper;
      else if (recordKey(candidates[existing]!) !== recordKey(paper) || candidates[existing]!.privateResearch!.readerVersion !== paper.privateResearch.readerVersion) throw new Error('Saved reader identity changed');
    } catch { /* Keep valid bibliography rows and readings when one supplemental row is malformed. */ }
  }
  const latest = new Map<string, ResearchPaper>();
  for (const paper of candidates) {
    const key = recordKey(paper), existing = latest.get(key);
    if (!existing || (paper.privateResearch?.readerVersion ?? -1) > (existing.privateResearch?.readerVersion ?? -1)) latest.set(key, paper);
  }
  const attached = new Set<string>();
  for (const value of raw.readings) {
    try {
      const reading = object(value), source = candidates.find(paper => paper.id === reading.readerId);
      if (!source || reading.pmid !== source.pmid || reading.doi !== source.doi || reading.originalTitle !== source.title) throw new Error('Saved prose does not match its bibliography');
      const key = recordKey(source), target = latest.get(key)!;
      if (!sameBibliography(source, target) || attached.has(key)) throw new Error('Reading version bibliography changed');
      const [paper] = attachChineseReadings([target], { private: true, readings: [{ ...reading, readerId: target.id }] });
      latest.set(key, paper!);
      attached.add(key);
    } catch { /* A bad or stale reading must not remove another paper's valid private draft. */ }
  }
  // Earlier reader ids remain addressable through existing links and browser bookmarks.
  return candidates.map(paper => {
    const target = latest.get(recordKey(paper))!;
    if (target.id === paper.id) return target;
    if (!paper.chineseReading) return paper;
    const { chineseReading, ...earlier } = paper;
    return earlier;
  });
}

export async function savedChineseReadings(papers:ResearchPaper[],signal:AbortSignal,projectPaper?: (value: unknown) => ResearchPaper) {
  const configured=process.env.EP_CHINESE_READING_API;
  if(!configured)return papers;
  const url=new URL(configured);
  if(url.origin!=='http://127.0.0.1:3202' || url.pathname!=='/api/research-preview/chinese-readings' || url.search || url.hash)throw new Error('Use the private local saved-prose API');
  const response=await fetch(url,{signal,headers:{accept:'application/json'},redirect:'error'});
  if(!response.ok)throw new Error('Saved prose HTTP '+response.status);
  return mergeSavedChineseReadings(papers,await response.json(),projectPaper);
}
