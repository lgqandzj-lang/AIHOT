import { apiGet } from "../../lib/api.server.ts";
import { savedChineseReadings } from './chinese-reading.server.ts';
import type { PrivateNewsFeed, PrivateReadingDraft, PrivateReadingView, PrivateResearchEntry, ProductAssociationVerification, ReadingValue, ResearchExperience } from "./contracts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preview object");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid preview text");
  return value;
}
function list(value: unknown, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid preview list");
  return value;
}
function https(value: unknown): string {
  const url = new URL(text(value, 3000));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid source URL");
  return url.href;
}

function privateDraft(value: unknown): PrivateReadingDraft {
  const draft = object(value);
  if (draft.status !== "private_auto_draft" || !["assistant_source_comparison", "not_evaluated"].includes(String(draft.reviewMethod))) throw new Error("Invalid private draft status");
  const state = draft.state ?? "private_draft";
  if (!["private_draft", "degraded", "invalid_output", "unknown", "unreviewed", "index_only"].includes(String(state))) throw new Error("Invalid private draft state");
  const groups = list(draft.groups, 20).map(value => {
    const group = object(value);
    if (group.quantity !== null && (!Number.isSafeInteger(group.quantity) || Number(group.quantity) <= 0)) throw new Error("Invalid group count");
    if (group.quantity !== null && (group.unit === null || group.populationScope === null)) throw new Error("A count needs its unit and population scope");
    const evidence = list(group.evidence, 20).map(value => {
      const entry = object(value);
      return { label: text(entry.label, 300), quote: text(entry.quote, 2000) };
    });
    if (!evidence.length) throw new Error("Private draft needs field evidence");
    return { id: text(group.id, 100), label: text(group.label, 2000), quantity: group.quantity as number | null,
      unit: group.unit === null ? null : text(group.unit, 100), subjects: group.subjects === null ? null : text(group.subjects, 3000),
      populationScope: group.populationScope === null ? null : text(group.populationScope, 3000), evidence };
  });
  if (new Set(groups.map(g => g.id)).size !== groups.length || groups.length && (!["private_draft", "degraded"].includes(String(state)) || draft.reviewMethod !== "assistant_source_comparison")) throw new Error("Invalid private reading groups");
  const attribution = object(draft.attribution);
  const sections = draft.sections === undefined ? undefined : list(draft.sections, 30).map(value => {
    const section = object(value);
    const fields = list(section.fields, 150).map(value => {
      const field = object(value);
      if (!["source_supported", "pending", "not_reported"].includes(String(field.review))) throw new Error("Invalid private field review");
      return { key: text(field.key, 100), label: text(field.label, 300), modelValue: text(field.modelValue, 6000),
        review: field.review as "source_supported" | "pending" | "not_reported", note: text(field.note, 3000),
        evidence: list(field.evidence, 20).map(value => { const source = object(value); return { label: text(source.label, 300), quote: text(source.quote, 20000) }; }) };
    });
    if (!fields.length || new Set(fields.map(field => field.key)).size !== fields.length) throw new Error("Invalid private section fields");
    return { id: text(section.id, 100), label: text(section.label, 2000), fields };
  });
  if (sections && (new Set(sections.map(section => section.id)).size !== sections.length || ["index_only", "unknown"].includes(String(state)))) throw new Error("Invalid private sections");
  const source = draft.sourceAbstract === undefined ? undefined : object(draft.sourceAbstract);
  let sourceAbstract: PrivateReadingDraft["sourceAbstract"];
  if (source) {
    if (source.scope !== "abstract" || source.fullTextProvided !== false) throw new Error("Reader source must be an abstract");
    const fragments = list(source.fragments, 100).map(value => { const fragment = object(value); return { id: text(fragment.id, 100), label: fragment.label === null ? null : text(fragment.label, 300), text: text(fragment.text, 20000) }; });
    if (!fragments.length || new Set(fragments.map(fragment => fragment.id)).size !== fragments.length) throw new Error("Invalid source fragments");
    const acquiredAt = text(source.acquiredAt, 50);
    if (!Number.isFinite(Date.parse(acquiredAt))) throw new Error("Invalid abstract timestamp");
    sourceAbstract = { scope: "abstract", fullTextProvided: false, sourceName: text(source.sourceName, 300), sourceUrl: https(source.sourceUrl), acquiredAt, fragments };
  }
  const checks = draft.readingChecks === undefined ? undefined : object(draft.readingChecks);
  if (checks && (typeof checks.formatConverted !== "boolean" || !Number.isSafeInteger(checks.deferredCount) || Number(checks.deferredCount) < 0 || checks.semanticStatus !== "not_evaluated")) throw new Error("Invalid reading checks");
  const readingView = draft.readingView === undefined ? undefined : privateReadingView(draft.readingView, sourceAbstract);
  if (readingView && !['private_draft', 'degraded', 'unreviewed'].includes(String(state))) throw new Error('Invalid reading organization state');
  let diagnosticUrl: string | undefined;
  if (draft.diagnosticUrl !== undefined) {
    const url = new URL(text(draft.diagnosticUrl, 1000));
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || !/^\/api\/research-preview\/admin\/diagnostics\/[A-Za-z0-9_-]{1,100}$/.test(url.pathname)) throw new Error("Invalid admin diagnostic URL");
    diagnosticUrl = url.href;
  }
  return { status: "private_auto_draft", reviewMethod: draft.reviewMethod as PrivateReadingDraft["reviewMethod"], state: state as PrivateReadingDraft["state"], groups,
    ...(sections ? { sections } : {}),
    ...(sourceAbstract ? { sourceAbstract } : {}),
    ...(readingView ? { readingView } : {}),
    ...(checks ? { readingChecks: { formatConverted: checks.formatConverted as boolean, deferredCount: checks.deferredCount as number, semanticStatus: "not_evaluated" as const } } : {}),
    ...(diagnosticUrl ? { diagnosticUrl } : {}),
    attribution: { copyright: text(attribution.copyright, 2000), license: text(attribution.license),
      licenseUrl: https(attribution.licenseUrl), changesNotice: text(attribution.changesNotice, 3000) } };
}

/** Whitelist the read organization; raw model/debug data is never forwarded. */
function privateReadingView(value: unknown, source: PrivateReadingDraft["sourceAbstract"]): PrivateReadingView {
  if (!source) throw new Error("Reading organization needs its saved abstract");
  const raw = object(value);
  const evidence = (value: unknown) => list(value, 100).map(value => {
    const entry = object(value), quote = text(entry.quote, 20000);
    if (!source.fragments.some(fragment => fragment.text.includes(quote))) throw new Error("Reading evidence is outside its saved abstract");
    return { label: text(entry.label, 300), quote };
  });
  const field = (value: unknown): ReadingValue => {
    const item = object(value);
    if (item.value !== null && typeof item.value !== "string" && typeof item.value !== "number" || typeof item.value === "number" && !Number.isFinite(item.value)) throw new Error("Invalid reading value");
    if (item.absence !== null && !["unknown", "not_reported", "not_applicable"].includes(String(item.absence)) || item.value !== null && item.absence !== null) throw new Error("Invalid reading absence");
    return { value: typeof item.value === "string" ? text(item.value, 3000) : item.value as number | null, absence: item.absence as ReadingValue["absence"] };
  };
  const counts = (value: unknown) => list(value, 20).map(value => {
    const item = object(value), quantity = field(item.quantity), unit = field(item.unit), populationScope = field(item.populationScope);
    if (quantity.value !== null && (!Number.isSafeInteger(quantity.value) || Number(quantity.value) < 0 || unit.value === null || populationScope.value === null)) throw new Error("Invalid scoped reading count");
    return { key: text(item.key, 100), quantity, unit, populationScope, evidence: evidence(item.evidence) };
  });
  const contextual = (value: unknown) => list(value, 20).map(value => { const item = object(value); return { key: text(item.key, 100), value: text(item.value, 6000), evidence: evidence(item.evidence) }; });
  const groups = list(raw.groups, 20).map(value => {
    const group = object(value);
    return { id: text(group.id, 100), label: text(group.label, 2000), subjects: group.subjects === null ? null : text(group.subjects, 3000),
      counts: counts(group.counts), methods: list(group.methods, 20).map(value => {
        const item = object(value); return { key: text(item.key, 100), label: text(item.label, 300), value: text(item.value, 6000), evidence: evidence(item.evidence) };
      }), contexts: contextual(group.contexts), evidence: evidence(group.evidence) };
  });
  const groupIds = new Set(groups.map(group => group.id));
  if (groupIds.size !== groups.length) throw new Error("Duplicate reading groups");
  const results = list(raw.results, 80).map(value => {
    const item = object(value), groupId = text(item.groupId, 100);
    if (groupId !== "overall" && !groupIds.has(groupId) || !["duration", "outcome"].includes(String(item.kind))) throw new Error("Invalid result owner or kind");
    return { id: text(item.id, 100), groupId, kind: item.kind as "duration" | "outcome", metric: field(item.metric), resultValue: field(item.resultValue),
      unit: field(item.unit), statistic: field(item.statistic), numerator: field(item.numerator), outcomeDenominator: field(item.outcomeDenominator), countUnit: field(item.countUnit),
      windows: contextual(item.windows), evidence: evidence(item.evidence) };
  });
  const resultIds = new Set(results.map(result => result.id));
  if (resultIds.size !== results.length) throw new Error("Duplicate reading results");
  const comparisons = list(raw.comparisons, 20).map(value => {
    const item = object(value), resultIds = list(item.resultIds, 20).map(value => text(value, 100));
    if (resultIds.length < 2 || new Set(resultIds).size !== resultIds.length || resultIds.some(id => !results.some(result => result.id === id))) throw new Error("Invalid reading comparison");
    return { key: text(item.key, 100), resultIds, description: text(item.description, 6000), evidence: evidence(item.evidence) };
  });
  return { overallCounts: counts(raw.overallCounts), groups, results, comparisons };
}

/** Explicitly projects reader fields; unexpected private/debug properties never enter SSR data. */
function associationVerification(value: unknown, paper: { pmid: string | null; doi: string | null }): ProductAssociationVerification {
  const raw = object(value), checkedAt = text(raw.checkedAt, 50), studyId = raw.studyId === null ? null : text(raw.studyId, 50);
  if (raw.reviewer !== 'assistant_source_check' || !['article_fulltext', 'study_registration'].includes(String(raw.method)) || !Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid independent association check');
  const domains = { publisher: ['onlinelibrary.wiley.com', 'www.mdpi.com', 'academic.oup.com', 'oup.silverchair-cdn.com'], pmc: ['pmc.ncbi.nlm.nih.gov'], pubmed: ['pubmed.ncbi.nlm.nih.gov'], official_product: ['www.jnjmedtech.com'] };
  const sources = list(raw.sources, 6).map(value => {
    const source = object(value), url = https(source.url), kind = source.kind as ProductAssociationVerification['sources'][number]['kind'], role = source.role as ProductAssociationVerification['sources'][number]['role'];
    const articlePmid = source.articlePmid === null ? null : text(source.articlePmid, 50), articleDoi = source.articleDoi === null ? null : text(source.articleDoi, 300);
    if (!domains[kind]?.includes(new URL(url).hostname) || !['article_device', 'article_registration', 'official_registration', 'official_device'].includes(role)) throw new Error('Invalid independent association source');
    if (role.startsWith('article_') && (kind === 'official_product' || articlePmid !== paper.pmid || articleDoi?.toLowerCase() !== paper.doi?.toLowerCase())) throw new Error('Association source does not match this article');
    if (role.startsWith('official_') && (kind !== 'official_product' || articlePmid !== null || articleDoi !== null)) throw new Error('Invalid official study association');
    const acquiredAt = text(source.acquiredAt, 50);
    if (!Number.isFinite(Date.parse(acquiredAt)) || Date.parse(acquiredAt) > Date.parse(checkedAt)) throw new Error('Invalid association acquisition time');
    return { label: text(source.label, 300), quote: text(source.quote, 2000), url, location: text(source.location, 600), acquiredAt, kind, role, articlePmid, articleDoi };
  });
  if (!sources.length) throw new Error('Missing association sources');
  if (raw.method === 'article_fulltext') {
    if (studyId !== null || !sources.every(source => source.role === 'article_device' && ['publisher', 'pmc'].includes(source.kind)) || !sources.some(source => /\bVARIPULSE\b/i.test(source.quote))) throw new Error('Missing explicit article device evidence');
  } else {
    if (!studyId || !/^NCT\d{8}$/.test(studyId)) throw new Error('Invalid study registration');
    const article = sources.find(source => source.role === 'article_registration' && source.quote.includes(studyId));
    const official = sources.find(source => source.role === 'official_registration' && source.quote.includes(studyId));
    const device = sources.find(source => source.role === 'official_device' && /\bVARIPULSE\b/i.test(source.quote));
    if (!article || !official || !device || official.url !== device.url) throw new Error('Incomplete article-registration-product chain');
  }
  return { reviewer: 'assistant_source_check', method: raw.method as ProductAssociationVerification['method'], checkedAt, studyId, note: text(raw.note, 1000), sources };
}

function privateResearchEntry(value: unknown, paper: { title: string; year: number | null; doi: string | null; pmid: string | null; sources: { url: string }[]; privateDraft?: PrivateReadingDraft }): PrivateResearchEntry {
  const raw = object(value), product = object(raw.product);
  if (product.id !== 'varipulse' || !['confirmed', 'candidate'].includes(String(product.status))) throw new Error('Invalid private product membership');
  const evidence = (value: unknown, titleOnly = false) => {
    const source = object(value), quote = text(source.quote, 20000), url = https(source.url);
    const inTitle = quote === paper.title && paper.sources.some(source => source.url === url);
    const inAbstract = !titleOnly && paper.privateDraft?.sourceAbstract?.sourceUrl === url && paper.privateDraft.sourceAbstract.fragments.some(fragment => fragment.text.includes(quote));
    if (!inTitle && !inAbstract) throw new Error('Product navigation evidence is outside the saved source');
    return { label: text(source.label, 300), quote, url };
  };
  const verification = product.verification ? associationVerification(product.verification, paper) : undefined;
  const supplied = verification ? object(product.evidence) : null;
  const productEvidence = supplied ? { label: text(supplied.label, 300), quote: text(supplied.quote, 2000), url: https(supplied.url) } : evidence(product.evidence);
  if (verification && (product.status !== 'confirmed' || !verification.sources.some(source => source.quote === productEvidence.quote && source.url === productEvidence.url))) throw new Error('Product evidence is outside its independent check');
  if (product.status === 'confirmed' && !/\bVARIPULSE\b/i.test(productEvidence.quote)) throw new Error('Confirmed product requires an explicit name in its own evidence');
  const questions = list(raw.questions, 20).map(value => {
    const question = object(value), id = text(question.id, 100);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid research question');
    return { id, label: text(question.label, 300), evidence: evidence(question.evidence, true) };
  });
  const recordId = text(raw.recordId, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(recordId) || !Number.isSafeInteger(raw.readerVersion) || Number(raw.readerVersion) < 0 || new Set(questions.map(question => question.id)).size !== questions.length) throw new Error('Invalid record navigation identity');
  if (!['metadata', 'abstract', 'partial_fulltext', 'fulltext'].includes(String(raw.materialScope))) throw new Error('Invalid research material scope');
  const publishedOn = raw.publishedOn === null ? null : text(raw.publishedOn, 10);
  if (publishedOn && (!/^\d{4}-\d{2}-\d{2}$/.test(publishedOn) || !Number.isFinite(Date.parse(publishedOn)) || new Date(publishedOn).toISOString().slice(0, 10) !== publishedOn || paper.year !== null && Number(publishedOn.slice(0, 4)) !== paper.year)) throw new Error('Invalid publication date');
  let display: PrivateResearchEntry['display'];
  if (raw.display) {
    const copy = object(raw.display), basisUrl = https(copy.basisUrl), preparedAt = text(copy.preparedAt, 50);
    if (copy.curation !== 'assistant_curated' || !['title', 'abstract'].includes(String(copy.basisScope)) || !Number.isFinite(Date.parse(preparedAt))
      || !paper.sources.some(source => source.url === basisUrl) || copy.basisScope === 'abstract' && (raw.materialScope === 'metadata' || paper.privateDraft?.sourceAbstract?.sourceUrl !== basisUrl)) throw new Error('Invalid Chinese copy provenance');
    display = { titleZh: text(copy.titleZh, 180), leadZh: text(copy.leadZh, 400), curation: 'assistant_curated', basisScope: copy.basisScope as 'title' | 'abstract', basisUrl, preparedAt };
  }
  return { recordId, readerVersion: raw.readerVersion as number, publishedOn, studyType: text(raw.studyType, 100),
    materialScope: raw.materialScope as PrivateResearchEntry['materialScope'],
    product: { id: 'varipulse', status: product.status as 'confirmed' | 'candidate', evidence: productEvidence, ...(verification ? { verification } : {}) }, questions, ...(display ? { display } : {}) };
}

function newsProjection(value: unknown, papers: ResearchExperience['papers']): PrivateNewsFeed {
  const paperIds = new Set(papers.map(paper => paper.id));
  const raw = object(value);
  if (raw.version !== 'ep-private-news-v1' || raw.private !== true) throw new Error('News must be explicitly private');
  const timestamp = (value: unknown) => { const result = text(value, 60); if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid news date'); return result; };
  const sourceIds = ['ep-private-pubmed-varipulse', 'ep-private-jnj-varipulse'];
  const sources = list(raw.sources, 2).map(value => {
    const source = object(value), id = text(source.id, 100), kind = source.kind;
    const research = id === sourceIds[0];
    if (!sourceIds.includes(id) || kind !== (research ? 'research' : 'official') || !['ok', 'unavailable', 'not_run'].includes(String(source.status))
      || !Number.isSafeInteger(source.found) || Number(source.found) < 0 || !Number.isSafeInteger(source.created) || Number(source.created) < 0) throw new Error('Invalid news source');
    const basisUrl = https(source.basisUrl), policyUrl = https(source.policyUrl);
    if (basisUrl !== (research ? 'https://pubmed.ncbi.nlm.nih.gov/download/' : 'https://www.jnj.com/rss')
      || policyUrl !== (research ? 'https://www.ncbi.nlm.nih.gov/home/about/policies/' : 'https://www.jnj.com/terms-of-use')) throw new Error('Unknown news source policy');
    return { id, name: text(source.name, 120), kind: kind as 'research' | 'official', basisUrl, policyUrl,
      checkedAt: source.checkedAt === null ? null : timestamp(source.checkedAt), status: source.status as 'ok' | 'unavailable' | 'not_run', found: source.found as number, created: source.created as number };
  });
  if (sources.length !== 2 || new Set(sources.map(source => source.id)).size !== 2) throw new Error('News needs the two selected sources');
  const items = list(raw.items, 100).map(value => {
    const item = object(value), id = text(item.id, 80), source = object(item.source), product = object(item.product);
    const originalTitle = text(item.originalTitle, 2000), url = https(source.url), official = item.kind === 'official';
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !['paper', 'follow_up', 'official'].includes(String(item.kind)) || item.materialScope !== 'title'
      || typeof item.historical !== 'boolean' || !['model_draft', 'pending'].includes(String(item.curation))
      || new URL(url).hostname !== (official ? 'www.jnj.com' : 'pubmed.ncbi.nlm.nih.gov')) throw new Error('Invalid news identity or material scope');
    const named = /\bVARIPULSE\b/i.test(originalTitle);
    if (product.id !== 'varipulse' || product.status !== (named ? 'confirmed' : 'candidate') || product.method !== (named ? 'source_title' : 'search_candidate')
      || product.quote !== originalTitle || product.url !== url) throw new Error('Invalid news product evidence');
    const titleZh = item.titleZh === null ? null : text(item.titleZh, 180), leadZh = item.leadZh === null ? null : text(item.leadZh, 330);
    if (item.curation === 'model_draft' ? !titleZh || !leadZh : titleZh !== null || leadZh !== null) throw new Error('Invalid news copy provenance');
    if (titleZh && (!/[\u4e00-\u9fff]/.test(titleZh) || !named && /\bVARIPULSE\b/i.test(titleZh + leadZh)
      || !leadZh?.startsWith(official ? '厂商题名信息：' : '题名介绍：'))) throw new Error('Invalid title-only news copy');
    let researchUrl: string | null = null;
    if (item.researchUrl !== null) { researchUrl = text(item.researchUrl, 140); const paper = papers.find(paper => paper.id === researchUrl!.slice('/research/read/'.length));
      if (!researchUrl.startsWith('/research/read/') || !paper || paper.title !== originalTitle
        || !official && paper.pmid && new URL(url).pathname !== '/' + paper.pmid + '/') throw new Error('News research link is not the saved original record'); }
    let relatedResearch: PrivateNewsFeed['items'][number]['relatedResearch'] = null;
    if (item.relatedResearch !== null) {
      const related = object(item.relatedResearch), recordId = text(related.recordId, 100);
      const referenceUrl = https(related.sourceReference), reference = new URL(referenceUrl), paper = papers.find(paper => paper.id === recordId);
      const identityMatches = reference.hostname === 'pubmed.ncbi.nlm.nih.gov' ? reference.pathname === '/' + related.pmid + '/'
        : reference.hostname === 'doi.org' && reference.pathname.slice(1) === related.doi;
      if (related.method !== 'exact_identifier' || !paperIds.has(recordId) || !paper || paper.pmid !== related.pmid || paper.doi !== related.doi
        || !identityMatches) throw new Error('Invalid referenced research identity');
      relatedResearch = { recordId, pmid: related.pmid === null ? null : text(related.pmid, 20), doi: related.doi === null ? null : text(related.doi, 500), sourceReference: referenceUrl, method: 'exact_identifier' };
    }
    return { id, originalTitle, titleZh, leadZh, kind: item.kind as 'paper' | 'follow_up' | 'official', materialScope: 'title' as const,
      publishedAt: item.publishedAt === null ? null : timestamp(item.publishedAt), discoveredAt: timestamp(item.discoveredAt), historical: item.historical as boolean,
      source: { name: text(source.name, 120), url, acquiredAt: timestamp(source.acquiredAt) },
      product: { id: 'varipulse' as const, status: named ? 'confirmed' as const : 'candidate' as const, quote: originalTitle, url, method: named ? 'source_title' as const : 'search_candidate' as const },
      researchUrl, relatedResearch, curation: item.curation as 'model_draft' | 'pending' };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate news card');
  return { version: 'ep-private-news-v1', private: true, items, sources, checkedAt: raw.checkedAt === null ? null : timestamp(raw.checkedAt) };
}

export function readerProjection(value: unknown): ResearchExperience {
  const raw = object(value);
  if (raw.preview !== true) throw new Error("Expected preview material");
  const papers = list(raw.papers).map(value => {
    const paper = object(value);
    const topic = text(paper.topic);
    if (!new Set(["pfa", "rf", "basic"]).has(topic)) throw new Error("Invalid preview topic");
    if (paper.year !== null && (typeof paper.year !== "number" || !Number.isInteger(paper.year))) throw new Error("Invalid publication year");
    const id = text(paper.id, 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid paper identifier");
    const projected = {
      id, title: text(paper.title, 3000), journal: paper.journal === null ? null : text(paper.journal),
      year: paper.year as number | null, authors: list(paper.authors).map(value => text(value, 300)),
      doi: paper.doi === null ? null : text(paper.doi), pmid: paper.pmid === null ? null : text(paper.pmid, 50),
      topic: topic as "pfa" | "rf" | "basic",
      sources: list(paper.sources, 10).map(value => {
        const source = object(value);
        const acquiredAt = text(source.acquiredAt, 50);
        if (!Number.isFinite(Date.parse(acquiredAt))) throw new Error("Invalid source timestamp");
        return { name: text(source.name, 100), url: https(source.url), acquiredAt };
      }),
      ...(process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED === "true" && paper.privateDraft ? { privateDraft: privateDraft(paper.privateDraft) } : {}),
    };
    return { ...projected, ...(process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED === 'true' && paper.privateResearch ? { privateResearch: privateResearchEntry(paper.privateResearch, projected) } : {}) };
  });
  if (new Set(papers.map(paper => paper.id)).size !== papers.length) throw new Error("Duplicate preview paper");
  let example: ResearchExperience["example"] = null;
  if (raw.example !== null) {
    const material = object(raw.example);
    if (material.synthetic !== true) throw new Error("Reader examples must be synthetic");
    const sources = list(material.sources, 50).map(value => {
      const source = object(value);
      return { id: text(source.id, 100), label: text(source.label, 300), text: text(source.text, 20000) };
    });
    const sourceMap = new Map(sources.map(source => [source.id, source]));
    if (sourceMap.size !== sources.length) throw new Error("Duplicate source fragment");
    const groups = list(material.groups, 20).map(value => {
      const group = object(value);
      const fields = list(group.fields, 50).map(value => {
        const field = object(value);
        const sourceIds = list(field.sourceIds, 10).map(value => text(value, 100));
        if (sourceIds.some(id => !sourceMap.has(id))) throw new Error("Missing source fragment");
        if (field.value !== null && sourceIds.length === 0) throw new Error("A reported field needs a source");
        const quote = field.sourceQuote === null || field.sourceQuote === undefined ? null : text(field.sourceQuote, 2000);
        if (quote && !sourceMap.get(sourceIds[0] || "")?.text.includes(quote)) throw new Error("Quote does not match the source");
        return { key: text(field.key, 100), label: text(field.label, 300), value: field.value === null ? null : text(field.value, 3000), sourceIds, sourceQuote: quote };
      });
      if (!fields.length || new Set(fields.map(field => field.key)).size !== fields.length) throw new Error("Invalid reading fields");
      return { id: text(group.id, 100), label: text(group.label, 300), fields };
    });
    if (!groups.length || new Set(groups.map(group => group.id)).size !== groups.length) throw new Error("Invalid reading groups");
    example = { synthetic: true, groups, sources };
  }
  let news: Pick<ResearchExperience, 'news' | 'newsUnavailable'> = process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED === 'true' && raw.newsUnavailable === true ? { newsUnavailable: true } : {};
  if (process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED === 'true' && raw.news) {
    try { news = { news: newsProjection(raw.news, papers) }; } catch { news = { newsUnavailable: true }; }
  }
  return { preview: true, papers, example, ...(process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED === 'true' ? { privateProduct: 'varipulse' as const, ...news } : {}) };
}

/** The loopback backend projects persisted private drafts; the frontend only reads the HTTP projection. */
export async function loadResearchExperience(signal: AbortSignal): Promise<ResearchExperience> {
  if (process.env.EP_RESEARCH_PREVIEW_ENABLED !== "true") {
    return { preview: false, papers: [], example: null };
  }
  const base = new URL(process.env.API_BASE_URL || "http://127.0.0.1:3001");
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(base.hostname)) {
    return { preview: true, papers: [], example: null, unavailable: true, ...(process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED === 'true' ? { privateProduct: 'varipulse' as const } : {}) };
  }
  try {
    const experience = readerProjection(await apiGet<unknown>("/api/research-preview/experience", { signal }));
    if (process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED === 'true') {
      try { experience.papers = await savedChineseReadings(experience.papers,signal, value => readerProjection({ preview: true, papers: [value], example: null }).papers[0]!); }
      catch (error) { if(signal.aborted)throw error; /* Existing bibliography/news remain readable when the separate saved-prose service is unavailable. */ }
    }
    return experience;
  } catch (error) {
    if (signal.aborted) throw error;
    return { preview: true, papers: [], example: null, unavailable: true, ...(process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED === 'true' ? { privateProduct: 'varipulse' as const } : {}) };
  }
}
