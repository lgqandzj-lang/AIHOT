import { XMLParser } from 'fast-xml-parser';
import { ResearchValidationError } from './contracts.ts';
import { normalizeDoi } from './normalize.ts';

export type MetadataProvider = 'crossref' | 'pubmed';
export interface LiteratureMetadata {
  provider: MetadataProvider;
  providerId: string;
  sourceUrl: string;
  acquiredAt: string;
  doi: string | null;
  pmid: string | null;
  title: string | null;
  authors: string[];
  journal: string | null;
  publishedYear: number | null;
  publishedOn: string | null;
  abstract: string | null;
  abstractFormat: 'plain' | 'jats' | null;
  abstractLocator: string | null;
  versionLabel: string | null;
}
export interface MetadataFetchOptions {
  fetcher?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  contactEmail?: string;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value];
function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= max && !result.includes('\0') ? result : null;
}
function firstString(value: unknown, max: number): string | null {
  return clean(Array.isArray(value) ? value[0] : value, max);
}
function xmlText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return value.map(xmlText).filter(Boolean).join(' ');
  return Object.entries(obj(value)).filter(([key]) => !key.startsWith('@_'))
    .map(([, child]) => xmlText(child)).filter(Boolean).join(' ');
}
function pmidValue(value: unknown): string | null {
  const result = typeof value === 'string' ? value.trim() : null;
  return result && /^[1-9][0-9]{0,11}$/.test(result) ? result : null;
}
function dateParts(yearValue: unknown, monthValue: unknown, dayValue: unknown): { year: number | null; date: string | null } {
  const year = Number(yearValue);
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return { year: null, date: null };
  const monthNames: Record<string, number> = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const month = typeof monthValue === 'string' && /^[A-Za-z]/.test(monthValue)
    ? monthNames[monthValue.slice(0, 3).toLowerCase()] : Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) {
    return { year, date: null };
  }
  const date = String(year) + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  return new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date ? { year, date } : { year, date: null };
}
function crossrefDate(message: Json): { year: number | null; date: string | null } {
  let partial: { year: number | null; date: string | null } = { year: null, date: null };
  for (const key of ['published-online', 'published-print', 'published', 'issued']) {
    const parts = array(obj(message[key])['date-parts'])[0];
    if (!Array.isArray(parts)) continue;
    const next = dateParts(parts[0], parts[1], parts[2]);
    if (next.date) return next;
    if (partial.year === null && next.year !== null) partial = next;
  }
  return partial;
}
function pubmedDate(article: Json): { year: number | null; date: string | null } {
  const journalDate = obj(obj(obj(article.Journal).JournalIssue).PubDate);
  const candidates = [...array(article.ArticleDate), journalDate];
  let partial: { year: number | null; date: string | null } = { year: null, date: null };
  for (const candidate of candidates) {
    const x = obj(candidate);
    const next = dateParts(xmlText(x.Year), xmlText(x.Month), xmlText(x.Day));
    if (next.date) return next;
    if (partial.year === null && next.year !== null) partial = next;
  }
  return partial;
}
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

/** Validate a normalized provider snapshot before any database write. Missing data stays null. */
export function normalizeMetadata(input: LiteratureMetadata): LiteratureMetadata {
  if (input.provider !== 'crossref' && input.provider !== 'pubmed') throw new ResearchValidationError('Unsupported metadata provider.');
  const providerId = input.provider === 'crossref' ? normalizeDoi(input.providerId) : pmidValue(input.providerId);
  const doi = normalizeDoi(input.doi);
  const pmid = input.pmid == null ? null : pmidValue(input.pmid);
  if (!providerId || (input.provider === 'crossref' && doi !== providerId)
    || (input.provider === 'pubmed' && pmid !== providerId)) {
    throw new ResearchValidationError('Provider identity does not match DOI/PMID metadata.');
  }
  const acquired = new Date(input.acquiredAt);
  if (!Number.isFinite(acquired.getTime())) throw new ResearchValidationError('Invalid metadata acquisition time.');
  let sourceUrl: URL;
  try { sourceUrl = new URL(input.sourceUrl); } catch { throw new ResearchValidationError('Invalid metadata source URL.'); }
  if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password) {
    throw new ResearchValidationError('Metadata source URL must be HTTPS without credentials.');
  }
  if ((input.provider === 'crossref' && sourceUrl.hostname !== 'api.crossref.org')
    || (input.provider === 'pubmed' && sourceUrl.hostname !== 'pubmed.ncbi.nlm.nih.gov')) {
    throw new ResearchValidationError('Metadata source URL does not match provider.');
  }
  const title = input.title == null ? null : clean(input.title, 2000);
  const abstract = input.abstract == null ? null : clean(input.abstract, 100_000);
  const journal = input.journal == null ? null : clean(input.journal, 500);
  const versionLabel = input.versionLabel == null ? null : clean(input.versionLabel, 200);
  const abstractLocator = input.abstractLocator == null ? null : clean(input.abstractLocator, 200);
  if ((input.title != null && !title) || (input.abstract != null && !abstract)
    || (input.journal != null && !journal) || (input.versionLabel != null && !versionLabel)
    || (input.abstractLocator != null && !abstractLocator)) throw new ResearchValidationError('Invalid metadata text field.');
  if (!Array.isArray(input.authors) || input.authors.length > 200
    || input.authors.some(author => !clean(author, 500))) throw new ResearchValidationError('Invalid metadata authors.');
  if (input.publishedYear != null && (!Number.isInteger(input.publishedYear)
    || input.publishedYear < 1000 || input.publishedYear > 9999)) throw new ResearchValidationError('Invalid publication year.');
  if (input.publishedOn != null && (!validDate(input.publishedOn)
    || (input.publishedYear != null && Number(input.publishedOn.slice(0, 4)) !== input.publishedYear))) {
    throw new ResearchValidationError('Invalid exact publication date.');
  }
  if (abstract && input.abstractFormat !== 'plain' && input.abstractFormat !== 'jats') {
    throw new ResearchValidationError('Abstract format is required for an abstract.');
  }
  return {
    provider: input.provider, providerId, sourceUrl: sourceUrl.href, acquiredAt: acquired.toISOString(),
    doi, pmid, title, authors: input.authors.map(author => author.trim()), journal,
    publishedYear: input.publishedYear ?? null, publishedOn: input.publishedOn ?? null,
    abstract, abstractFormat: abstract ? input.abstractFormat : null,
    abstractLocator: abstract ? abstractLocator : null, versionLabel,
  };
}

async function getText(url: string, accept: string, options: MetadataFetchOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new ResearchValidationError('Invalid metadata request timeout.');
  const response = await (options.fetcher ?? fetch)(url, {
    headers: { Accept: accept, 'User-Agent': 'EPResearch-PR2A/1.0 (metadata lookup)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('Metadata provider returned HTTP ' + response.status + ' for ' + url);
  const body = await response.text();
  if (Buffer.byteLength(body) > 2_000_000) throw new Error('Metadata response exceeds 2 MB.');
  return body;
}

/** Crossref is used only for supplied DOI metadata; it does not infer study results. */
export async function fetchCrossrefMetadata(doiInput: string, options: MetadataFetchOptions = {}): Promise<LiteratureMetadata> {
  const doi = normalizeDoi(doiInput);
  if (!doi) throw new ResearchValidationError('DOI is required.');
  const url = 'https://api.crossref.org/works/' + encodeURIComponent(doi);
  const payload = obj(JSON.parse(await getText(url, 'application/json', options)));
  const message = obj(payload.message);
  const sourceDoi = normalizeDoi(firstString(message.DOI, 1000));
  if (sourceDoi !== doi) throw new ResearchValidationError('Crossref returned a different DOI.');
  const published = crossrefDate(message);
  const authors = array(message.author).map(author => {
    const x = obj(author);
    return [clean(x.given, 250), clean(x.family, 250)].filter(Boolean).join(' ') || clean(x.name, 500) || '';
  }).filter(Boolean);
  const abstract = clean(message.abstract, 100_000);
  return normalizeMetadata({
    provider: 'crossref', providerId: doi, sourceUrl: url,
    acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
    doi, pmid: null, title: firstString(message.title, 2000), authors,
    journal: firstString(message['container-title'], 500),
    publishedYear: published.year, publishedOn: published.date,
    abstract, abstractFormat: abstract ? (/<[A-Za-z][^>]*>/.test(abstract) ? 'jats' : 'plain') : null,
    abstractLocator: abstract ? 'Crossref:message.abstract' : null,
    versionLabel: clean(obj(message.deposited)['date-time'], 200),
  });
}

/** PubMed EFetch is a single-record lookup. Full text is never requested here. */
export async function fetchPubmedMetadata(pmidInput: string, options: MetadataFetchOptions = {}): Promise<LiteratureMetadata> {
  const pmid = pmidValue(pmidInput);
  if (!pmid) throw new ResearchValidationError('Invalid PMID.');
  const url = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi');
  url.searchParams.set('db', 'pubmed');
  url.searchParams.set('id', pmid);
  url.searchParams.set('retmode', 'xml');
  url.searchParams.set('tool', 'ep_research_pr2a');
  if (options.contactEmail) url.searchParams.set('email', options.contactEmail);
  const xml = await getText(url.href, 'application/xml', options);
  const parsed = obj(new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_',
    textNodeName: '#text', parseTagValue: false, htmlEntities: true }).parse(xml));
  const articles = array(obj(parsed.PubmedArticleSet).PubmedArticle);
  if (articles.length !== 1) throw new ResearchValidationError('PubMed did not return exactly one article.');
  const item = obj(articles[0]);
  const citation = obj(item.MedlineCitation);
  if (xmlText(citation.PMID) !== pmid) throw new ResearchValidationError('PubMed returned a different PMID.');
  const article = obj(citation.Article);
  const ids = array(obj(obj(item.PubmedData).ArticleIdList).ArticleId);
  const doiNode = ids.find(id => obj(id)['@_IdType'] === 'doi');
  const doi = normalizeDoi(doiNode ? xmlText(doiNode) : null);
  const authors = array(obj(article.AuthorList).Author).map(author => {
    const x = obj(author);
    return [xmlText(x.ForeName), xmlText(x.LastName)].filter(Boolean).join(' ') || xmlText(x.CollectiveName);
  }).filter(Boolean);
  const abstractParts = array(obj(article.Abstract).AbstractText).map(part => {
    const x = obj(part);
    const body = xmlText(part);
    const label = clean(x['@_Label'], 100);
    return body ? (label ? label + ': ' + body : body) : '';
  }).filter(Boolean);
  const abstract = abstractParts.length ? abstractParts.join('\n') : null;
  const published = pubmedDate(article);
  const revised = obj(citation.DateRevised);
  const revisedDate = dateParts(xmlText(revised.Year), xmlText(revised.Month), xmlText(revised.Day)).date;
  return normalizeMetadata({
    provider: 'pubmed', providerId: pmid,
    sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/',
    acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
    doi, pmid, title: clean(xmlText(article.ArticleTitle), 2000), authors,
    journal: clean(xmlText(obj(article.Journal).Title), 500),
    publishedYear: published.year, publishedOn: published.date,
    abstract, abstractFormat: abstract ? 'plain' : null,
    abstractLocator: abstract ? 'PubMed:Article.Abstract' : null,
    versionLabel: revisedDate,
  });
}
