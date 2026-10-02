import type { PrivateResearchDisplay, PrivateResearchEntry, ProductAssociationSource, ProductAssociationVerification } from './private-product.ts';

interface ContentPaper {
  title: string; doi: string | null; pmid: string | null; sources: { url: string }[];
  privateDraft?: { sourceAbstract?: { sourceUrl: string } };
  privateResearch?: PrivateResearchEntry;
}
export interface PrivateProductContent {
  recordId: string; pmid: string; doi: string; originalTitle: string;
  display: PrivateResearchDisplay; association: ProductAssociationVerification | null;
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected private content object');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 300): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid private content text');
  return value;
};
const timestamp = (value: unknown): string => { const result = text(value, 50); if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid private content timestamp'); return result; };
const https = (value: unknown): string => { const result = text(value, 2000), url = new URL(result); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid private content source'); return result; };

/** This local sidecar contains assistant curation, never model output, clinical review or a publication command. */
export function parsePrivateProductContent(value: unknown): PrivateProductContent[] {
  const raw = object(value);
  if (raw.version !== 'private-product-content-v1' || raw.curation !== 'assistant_curated' || raw.runtimeAutomaticExtraction !== false
    || !Array.isArray(raw.entries) || raw.entries.length > 100) throw new Error('Invalid private content sidecar');
  const entries = raw.entries.map(value => {
    const item = object(value), display = object(item.display);
    const recordId = text(item.recordId, 100), pmid = text(item.pmid, 50), doi = text(item.doi, 300);
    if (!/^[a-zA-Z0-9_-]+$/.test(recordId) || !/^\d+$/.test(pmid) || !/^10\.\d{4,9}\//.test(doi)) throw new Error('Invalid private content identity');
    if (display.curation !== 'assistant_curated' || !['title', 'abstract'].includes(String(display.basisScope))) throw new Error('Invalid display provenance');
    const titleZh = text(display.titleZh, 180), leadZh = text(display.leadZh, 400);
    if (!/[\u3400-\u9fff]/.test(titleZh) || !/[\u3400-\u9fff]/.test(leadZh)) throw new Error('Expected Chinese reading copy');
    return { recordId, pmid, doi, originalTitle: text(item.originalTitle, 3000),
      display: { titleZh, leadZh, curation: 'assistant_curated' as const, basisScope: display.basisScope as 'title' | 'abstract', basisUrl: https(display.basisUrl), preparedAt: timestamp(display.preparedAt) },
      association: item.association === null ? null : productAssociationVerification(item.association, { pmid, doi }) };
  });
  if (new Set(entries.map(entry => entry.recordId)).size !== entries.length || new Set(entries.map(entry => entry.pmid)).size !== entries.length) throw new Error('Duplicate private content identity');
  return entries;
}

/** Independent evidence can confirm an association only after article identity and the complete source chain match. */
export function productAssociationVerification(value: unknown, paper: { pmid: string | null; doi: string | null }): ProductAssociationVerification {
  const raw = object(value);
  if (raw.reviewer !== 'assistant_source_check' || !['article_fulltext', 'study_registration'].includes(String(raw.method))
    || !Array.isArray(raw.sources) || raw.sources.length < 1 || raw.sources.length > 6) throw new Error('Invalid association check');
  const checkedAt = timestamp(raw.checkedAt), studyId = raw.studyId === null ? null : text(raw.studyId, 50);
  const sources = raw.sources.map(value => {
    const source = object(value), url = https(source.url), host = new URL(url).hostname;
    const kind = source.kind as ProductAssociationSource['kind'], role = source.role as ProductAssociationSource['role'];
    const domains = { publisher: ['onlinelibrary.wiley.com', 'www.mdpi.com', 'academic.oup.com', 'oup.silverchair-cdn.com'], pmc: ['pmc.ncbi.nlm.nih.gov'], pubmed: ['pubmed.ncbi.nlm.nih.gov'], official_product: ['www.jnjmedtech.com'] };
    if (!domains[kind]?.includes(host) || !['article_device', 'article_registration', 'official_registration', 'official_device'].includes(role)) throw new Error('Unrecognized association source');
    const articlePmid = source.articlePmid === null ? null : text(source.articlePmid, 50), articleDoi = source.articleDoi === null ? null : text(source.articleDoi, 300);
    if (role.startsWith('article_') && (kind === 'official_product' || articlePmid !== paper.pmid || articleDoi?.toLowerCase() !== paper.doi?.toLowerCase())) throw new Error('Association evidence belongs to another article');
    if (role.startsWith('official_') && (kind !== 'official_product' || articlePmid !== null || articleDoi !== null)) throw new Error('Invalid official study source');
    const acquiredAt = timestamp(source.acquiredAt);
    if (Date.parse(acquiredAt) > Date.parse(checkedAt)) throw new Error('Association was checked before its sources were acquired');
    return { label: text(source.label), quote: text(source.quote, 2000), url, location: text(source.location, 600), acquiredAt, kind, role, articlePmid, articleDoi };
  });
  if (raw.method === 'article_fulltext') {
    if (studyId !== null || !sources.every(source => source.role === 'article_device' && ['publisher', 'pmc'].includes(source.kind))
      || !sources.some(source => /\bVARIPULSE\b/i.test(source.quote))) throw new Error('Full-text association requires an explicit device in this article');
  } else {
    if (!studyId || !/^NCT\d{8}$/.test(studyId)) throw new Error('Missing study registration identifier');
    const article = sources.find(source => source.role === 'article_registration' && source.quote.includes(studyId));
    const official = sources.find(source => source.role === 'official_registration' && source.quote.includes(studyId));
    const device = sources.find(source => source.role === 'official_device' && /\bVARIPULSE\b/i.test(source.quote));
    if (!article || !official || !device || official.url !== device.url) throw new Error('Incomplete article-registration-product evidence chain');
  }
  return { reviewer: 'assistant_source_check', method: raw.method as ProductAssociationVerification['method'], checkedAt, studyId, note: text(raw.note, 1000), sources };
}

export function applyPrivateProductContent<T extends ContentPaper>(paper: T, contents: PrivateProductContent[]): T {
  const entry = paper.privateResearch;
  if (!entry) return paper;
  const content = contents.find(content => content.recordId === entry.recordId);
  if (!content) return paper;
  if (content.pmid !== paper.pmid || content.doi.toLowerCase() !== paper.doi?.toLowerCase() || content.originalTitle !== paper.title) throw new Error('Saved content does not match the original bibliography');
  if (!paper.sources.some(source => source.url === content.display.basisUrl)
    || content.display.basisScope === 'abstract' && (entry.materialScope === 'metadata' || paper.privateDraft?.sourceAbstract?.sourceUrl !== content.display.basisUrl)) throw new Error('Chinese copy is outside its saved material scope');
  const verified = content.association;
  const named = verified?.sources.find(source => /\bVARIPULSE\b/i.test(source.quote));
  return { ...paper, privateResearch: { ...entry, display: content.display,
    product: verified && named ? { ...entry.product, status: 'confirmed', evidence: { label: named.label, quote: named.quote, url: named.url }, verification: verified } : entry.product } };
}
