import type { StudyDesign, RecordInput } from './contracts.ts';

export interface PrivateResearchEntry {
  recordId: string;
  readerVersion: number;
  publishedOn: string | null;
  studyType: string;
  materialScope: RecordInput['materialScope'];
  product: { id: 'varipulse'; status: 'confirmed' | 'candidate'; evidence: { label: string; quote: string; url: string }; verification?: ProductAssociationVerification };
  questions: { id: string; label: string; evidence: { label: string; quote: string; url: string } }[];
  display?: PrivateResearchDisplay;
}

export interface PrivateResearchDisplay {
  titleZh: string; leadZh: string; curation: 'assistant_curated';
  basisScope: 'title' | 'abstract'; basisUrl: string; preparedAt: string;
}

export interface ProductAssociationSource {
  label: string; quote: string; url: string; location: string; acquiredAt: string;
  kind: 'publisher' | 'pmc' | 'pubmed' | 'official_product';
  role: 'article_device' | 'article_registration' | 'official_registration' | 'official_device';
  articlePmid: string | null; articleDoi: string | null;
}

export interface ProductAssociationVerification {
  reviewer: 'assistant_source_check'; method: 'article_fulltext' | 'study_registration';
  checkedAt: string; studyId: string | null; note: string; sources: ProductAssociationSource[];
}

const designs: Record<StudyDesign, string> = {
  randomized: '随机对照研究', prospective: '前瞻性研究', retrospective: '回顾性研究',
  case_report: '病例报告', case_series: '病例系列', technical: '技术研究', preclinical: '临床前研究',
  review: '综述', unknown: '类型待核对',
};
// Reading shortcuts use words already present in the saved source title. They are not extraction or clinical conclusions.
const questions = [
  { id: 'zero-fluoro', label: '零透视工作流', pattern: /zero[-\s]fluoro\w*|without\s+fluoroscopy/i },
  { id: 'follow-up', label: '复发与随访', pattern: /recurrence|\b\d+[-\s]month\s+outcomes/i },
  { id: 'discharge', label: '当日出院', pattern: /same[-\s]day\s+discharge/i },
  { id: 'anatomy', label: '特殊解剖与隔离', pattern: /complex\s+variant|posterior\s+wall\s+isolation/i },
  { id: 'platform', label: '平台技术', pattern: /\bpulsed\s+field\s+ablation\s+platform\b/i },
];

/** Read-only navigation metadata. A saved private catalogue is only a candidate, never brand evidence. */
export function privateProductEntry(input: {
  id: string; title: string; sources: { name: string; url: string; acquiredAt: string }[];
  privateDraft?: { status: string; sourceAbstract?: { sourceUrl: string; fragments: { text: string; label: string | null }[] } };
}, record?: { id: string; version: number; publishedOn: string | null; studyDesign: StudyDesign; materialScope: RecordInput['materialScope'] }): PrivateResearchEntry | undefined {
  const source = input.sources[0];
  if (!source) return undefined;
  const namedTitle = /\bVARIPULSE\b/i.test(input.title);
  const namedFragment = input.privateDraft?.sourceAbstract?.fragments.find(fragment => /\bVARIPULSE\b/i.test(fragment.text));
  if (!namedTitle && !namedFragment && !record) return undefined;
  const titleEvidence = { label: source.name + ' · 原题', quote: input.title, url: source.url };
  const evidence = namedTitle ? titleEvidence : namedFragment ? {
    label: namedFragment.label || '已保存摘要', quote: namedFragment.text, url: input.privateDraft!.sourceAbstract!.sourceUrl,
  } : { ...titleEvidence, label: '现有私有目录 · 提供材料未明确产品名称' };
  const studyType = record?.studyDesign && record.studyDesign !== 'unknown' ? designs[record.studyDesign]
    : /\bcase\s+report\b/i.test(input.title) ? designs.case_report
    : /\bprospective\b/i.test(input.title) ? designs.prospective
    : /\bsub[-\s]?analysis\b/i.test(input.title) ? '亚组分析' : designs.unknown;
  return {
    recordId: record?.id ?? input.id, readerVersion: record?.version ?? 0,
    publishedOn: record?.publishedOn ?? null, studyType,
    materialScope: record?.materialScope ?? 'metadata',
    product: { id: 'varipulse', status: namedTitle || namedFragment ? 'confirmed' : 'candidate', evidence },
    questions: questions.filter(question => question.pattern.test(input.title)).map(({ id, label }) => ({ id, label, evidence: titleEvidence })),
  };
}
