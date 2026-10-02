import { load } from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { sha256 } from '../lib/ids.ts';
import { normalizeDoi } from './normalize.ts';
import type { FulltextSnapshot, ReadingFragment } from './chinese-reading.ts';

export interface PmcIdentity { pmid: string; doi: string; pmcid: string }
const maximumBytes = 2_000_000;
const citationSelector = '[aria-label="Article citation and metadata"],.fm,.front-matter,.article-meta,.article-metadata,header';
const excludedSelector = '.abstract,[id^="abstract"],.ref-list,.references,.bibliography,.copyright,.permissions,.license,#clp_a,script,style,nav,aside';
const excludedHeading = /^(?:abstract|references|bibliography|copyright|licen[cs]e|摘要|参考文献|版权|许可)(?:\b|\s|$)/i;
const methodHeading = /\bmethods?\b|材料.{0,3}方法|研究方法|方法/i;
const resultHeading = /\bresults?\b|结果/i;
const headingSelector = 'h2,h3,h4,h5,h6';
const contentSelector = 'p,table,figcaption,.caption,ul,ol,.p';

function identifiers(pmid: string, doi: string) {
  if (typeof pmid !== 'string' || !/^[1-9]\d{0,9}$/.test(pmid)) throw new Error('Invalid PMID for PMC lookup');
  const normalizedDoi = normalizeDoi(doi);
  if (!normalizedDoi) throw new Error('A DOI is required to verify PMC identity');
  return { pmid, doi: normalizedDoi };
}

/** One official lookup, with no retries or DOI-only fallback to a different article. */
export async function resolvePmcIdentity(pmid: string, doi: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<PmcIdentity> {
  const expected = identifiers(pmid, doi);
  const url = new URL('https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/');
  url.searchParams.set('ids', expected.pmid); url.searchParams.set('idtype', 'pmid');
  url.searchParams.set('format', 'json'); url.searchParams.set('tool', 'epvoice_chinese_reading');
  const response = await (options.fetchImpl ?? fetch)(url.href, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(25_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('PMC identity lookup returned HTTP ' + response.status);
  const body = await response.text();
  if (Buffer.byteLength(body) > maximumBytes) throw new Error('PMC identity response exceeds 2 MB');
  const payload = JSON.parse(body) as { status?: unknown; records?: unknown };
  if (payload?.status !== 'ok' || !Array.isArray(payload.records) || payload.records.length !== 1) throw new Error('PMC identity lookup did not return exactly one article');
  const record = payload.records[0] as Record<string, unknown> | null;
  const returnedPmid = typeof record?.pmid === 'string' ? record.pmid
    : typeof record?.pmid === 'number' && Number.isSafeInteger(record.pmid) && record.pmid > 0 ? String(record.pmid) : null;
  if (!record || record.errmsg || record.error || returnedPmid !== expected.pmid
    || typeof record.doi !== 'string' || normalizeDoi(record.doi) !== expected.doi) throw new Error('PMC lookup PMID/DOI identity mismatch');
  if (typeof record.pmcid !== 'string' || !/^PMC[1-9]\d+$/.test(record.pmcid)) throw new Error('No PMC full text is available for this article');
  return { ...expected, pmcid: record.pmcid };
}

function normalizedText($: CheerioAPI, node: Element): string {
  const copy = $(node).clone();
  copy.find('sup,sub').each((_, element) => {
    const text = $(element).text();
    $(element).replaceWith((element.tagName === 'sup' ? '^(' : '_(') + text + ')');
  });
  copy.find('br').replaceWith(' ');
  return copy.text().replace(/\s+/g, ' ').trim();
}

function ownIdentity($: CheerioAPI, article: Cheerio<Element>, expected: PmcIdentity) {
  const citation = article.children(citationSelector).first();
  const own = citation.length ? citation.clone() : article.find(citationSelector).first().clone();
  if (!own.length) throw new Error('PMC article bibliography is missing');
  own.find('.ref-list,.references,.bibliography,.body,.main-article-body').remove();
  own.find('div,p,section').append(' ');
  const text = own.text().replace(/\s+/g, ' ');
  const pmids = new Set([...text.matchAll(/\bPMID\s*:\s*([1-9]\d*)\b/gi)].map(match => match[1]));
  const pmcids = new Set([...text.matchAll(/\bPMCID\s*:\s*(PMC[1-9]\d*)\b/gi)].map(match => match[1].toUpperCase()));
  const dois = new Set<string>();
  own.find('a[href]').each((_, element) => {
    let url: URL;
    try { url = new URL($(element).attr('href')!, 'https://pmc.ncbi.nlm.nih.gov'); } catch { return; }
    if (['doi.org', 'dx.doi.org'].includes(url.hostname)) {
      const doi = normalizeDoi(decodeURIComponent(url.pathname.slice(1))); if (doi) dois.add(doi);
    }
    if (url.hostname === 'pubmed.ncbi.nlm.nih.gov' && /^\/[1-9]\d*\/$/.test(url.pathname)) pmids.add(url.pathname.slice(1, -1));
  });
  if (!dois.size) for (const match of text.matchAll(/\bdoi\s*:\s*(10\.\d{4,9}\/\S+)/gi)) {
    const doi = normalizeDoi(match[1]); if (doi) dois.add(doi);
  }
  if (pmids.size !== 1 || !pmids.has(expected.pmid) || pmcids.size !== 1 || !pmcids.has(expected.pmcid)
    || dois.size !== 1 || !dois.has(expected.doi)) throw new Error('PMC article bibliography PMID/DOI/PMCID identity mismatch');
  for (const [name, value] of [['citation_pmid', expected.pmid], ['citation_doi', expected.doi]]) {
    $('head meta[name="' + name + '"]').each((_, element) => {
      const content = $(element).attr('content') || '';
      if ((name === 'citation_doi' ? normalizeDoi(content) : content) !== value) throw new Error('PMC page metadata conflicts with article bibliography');
    });
  }
}

function articleLicense($: CheerioAPI, article: Cheerio<Element>) {
  const candidates = article.find('#clp_a,.permissions,.copyright,.license,.copyright-and-license,[id^="copyright"],[id^="license"],[aria-label*="Copyright"],[aria-label*="License"]');
  let accepted: { copyright: string; licenseUrl: string } | undefined;
  for (const element of candidates.toArray()) {
    const region = $(element);
    if (region.parents('.ref-list,.references,.bibliography').length
      || region.parents('section,div').toArray().some(parent => /^(?:references|bibliography|参考文献)(?:\b|\s|$)/i.test($(parent).children(headingSelector).first().text().trim()))) continue;
    const text = normalizedText($, element);
    if (!/creative commons attribution|\bCC\s*BY\b|open access article under the terms of\b.*\blicense\b/i.test(text)) continue;
    const urls: URL[] = [];
    region.find('a[href]').each((_, link) => {
      try {
        const url = new URL($(link).attr('href')!);
        if (['creativecommons.org', 'www.creativecommons.org'].includes(url.hostname)) urls.push(url);
      } catch { /* A malformed link is not a license grant. */ }
    });
    if (!urls.length || urls.some(url => !['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || !/^\/licenses\/by\/4\.0\/?$/.test(url.pathname) || url.search || url.hash)
      || /non[ -]?commercial|\bCC\s*BY\s*-\s*(?:NC|ND|SA)\b/i.test(text)) throw new Error('PMC article license is not CC BY 4.0');
    const copyright = text.match(/(?:©|Copyright\b)[^.\n]{1,280}\.?/i)?.[0]?.trim();
    if (!copyright) throw new Error('PMC article copyright notice is missing');
    accepted = { copyright, licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' };
  }
  if (accepted) return accepted;
  throw new Error('PMC article has no explicit CC BY 4.0 permission in its Copyright/License region');
}

function sectionLabel($: CheerioAPI, element: Element, body: Cheerio<Element>) {
  let node = $(element);
  const labels: string[] = [];
  while (node.length && node[0] !== body[0]) {
    const previousHeading = node.prevAll(headingSelector).first();
    if (previousHeading.length) labels.unshift(previousHeading.text().replace(/\s+/g, ' ').trim());
    node = node.parent();
  }
  return [...new Set(labels)].join(' · ') || 'Article body';
}

function chunks(text: string): string[] {
  const pieces: string[] = [];
  while (text.length > 24_000) {
    let end = text.lastIndexOf('\n', 24_000);
    if (end < 12_000) end = text.lastIndexOf(' ', 24_000);
    if (end < 12_000) end = 24_000;
    pieces.push(text.slice(0, end).trim()); text = text.slice(end).trim();
  }
  if (text) pieces.push(text);
  return pieces;
}

/** Article-scoped rights and identity checks precede extraction; source HTML stays unchanged. */
export function genericFulltextSnapshot(html: string, identity: PmcIdentity, acquiredAt: string): FulltextSnapshot {
  const expected = { ...identifiers(identity.pmid, identity.doi), pmcid: identity.pmcid };
  if (!/^PMC[1-9]\d+$/.test(expected.pmcid)) throw new Error('Invalid PMCID');
  if (!Number.isFinite(Date.parse(acquiredAt))) throw new Error('Invalid full-text acquisition time');
  if (Buffer.byteLength(html) > maximumBytes) throw new Error('PMC full text exceeds 2 MB');
  const $ = load(html), article = $('article').first();
  if (!article.length) throw new Error('PMC full-text article is missing');
  ownIdentity($, article, expected);
  const rights = articleLicense($, article);
  const selected = article.find('.main-article-body,.body,[aria-label="Article content"]').first();
  if (!selected.length) throw new Error('PMC article body is missing');
  const body = selected.clone();
  body.find(excludedSelector).remove();
  body.find('section,div').each((_, element) => {
    const title = $(element).children(headingSelector).first().text().trim().replace(/^\d+[.\s]+/, '');
    if (excludedHeading.test(title)) $(element).remove();
  });
  // Flat older articles delimit references and abstracts with sibling headings.
  body.find(headingSelector).each((_, element) => {
    if (!excludedHeading.test($(element).text().trim().replace(/^\d+[.\s]+/, ''))) return;
    const level = Number(element.tagName.slice(1));
    let next = $(element).next();
    while (next.length && (!next.is(headingSelector) || Number((next[0] as Element).tagName.slice(1)) > level)) {
      const following = next.next(); next.remove(); next = following;
    }
    $(element).remove();
  });
  // Short reports can present methods and results as continuous body prose.
  // Count actual paragraphs and tabular observations, never abstract or caption text.
  const administrativeHeading = /funding|conflict of interest|acknowledg|ethics|consent|contribut|author information|data availability/i;
  const longBodyParagraphs = body.find('p').toArray().filter(element =>
    !$(element).parentsUntil(body).is('table,figure,.fig,figcaption,.caption')
    && !administrativeHeading.test(sectionLabel($, element, body)))
    .map(element => normalizedText($, element)).filter(text => text.length >= 200);
  const unheadedReportCoverage = !body.find(headingSelector).toArray().some(element =>
    methodHeading.test($(element).text()) || resultHeading.test($(element).text()) || /\bcase (?:report|description|presentation|summary)\b/i.test($(element).text()))
    && longBodyParagraphs.length >= 4 && longBodyParagraphs.join(' ').length >= 1500
    && body.find('table').toArray().some(element => $(element).find('th').length > 0
      && $(element).find('tr').toArray().some(row => $(row).find('td').length >= 2 && $(row).text().trim().length > 0));
  const sourceUrl = 'https://pmc.ncbi.nlm.nih.gov/articles/' + expected.pmcid + '/';
  const fragments: ReadingFragment[] = [];
  body.find(contentSelector).each((_, element) => {
    const item = $(element);
    const tableWrapper = (node: Element) => unheadedReportCoverage && $(node).is('.p') && $(node).find('table').length > 0;
    if (tableWrapper(element) || item.parentsUntil(body).filter(contentSelector).toArray().some(node => !tableWrapper(node))) return;
    const label = sectionLabel($, element, body);
    const caption = item.is('figcaption,.caption') || item.parents('figure,.fig').length > 0;
    const text = item.is('table') ? item.find('tr').map((_, row) => $(row).find('th,td')
      .map((_, cell) => normalizedText($, cell)).get().join(' | ')).get().join('\n') : normalizedText($, element);
    if (!text) return;
    const locator = item.attr('id') || item.closest('[id]').attr('id');
    const url = sourceUrl + (locator ? '#' + encodeURIComponent(locator) : '');
    const pieces = chunks(text);
    for (const [index, piece] of pieces.entries()) fragments.push({ id: 'FT' + (fragments.length + 1), scope: 'fulltext',
      label: label + (item.is('table') ? ' · Table' : caption ? ' · Figure caption' : '') + (pieces.length > 1 ? ' · Part ' + (index + 1) : ''),
      text: piece, sourceUrl: url, hash: sha256(piece) });
  });
  const methodText = fragments.filter(fragment => methodHeading.test(fragment.label)).map(fragment => fragment.text).join(' ');
  const resultText = fragments.filter(fragment => resultHeading.test(fragment.label)).map(fragment => fragment.text).join(' ');
  const caseReport = fragments.some(fragment => /\bcase (?:report|description|presentation|summary)\b|病例报告|病例描述|病例资料/i.test(fragment.label));
  const caseCoverage = caseReport && fragments.length >= 4 && fragments.map(fragment => fragment.text).join(' ').length >= 800
    && fragments.some(fragment => /\bdiscussion\b|\bconclusion\b|\boutcome\b|\bfollow.up\b|讨论|结论|结局|随访/i.test(fragment.label));
  if (fragments.length < 2 || fragments.length > 100 || (methodText.length < 80 || resultText.length < 80) && !caseCoverage && !unheadedReportCoverage) throw new Error('PMC full-text extraction omitted Methods/Results body or sufficient report coverage');
  return { pmid: expected.pmid, doi: expected.doi, sourceUrl, acquiredAt, bodyHash: sha256(html),
    license: 'CC BY 4.0', ...rights,
    processingBasis: 'The article Copyright/License region explicitly licenses this identified full text under CC BY 4.0; retain source, authorship, license and a changes notice for private model transformation.', fragments };
}
