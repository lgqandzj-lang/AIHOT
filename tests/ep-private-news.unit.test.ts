import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newsKind, productFromTitle, titleMetadata, newsDisplay, parseNewsMaterial, newsCostCeiling, PRIVATE_NEWS_VERSION, NEWS_SOURCES, explicitNewsReferences } from '../packages/backend/src/research/private-news.ts';
import type { NewsMaterial } from '../packages/backend/src/research/private-news.ts';
import { discoverPrivateNews } from '../packages/backend/src/research/private-news-store.ts';
import { newsArguments, validateNewsAuthorization } from '../scripts/ep-private-news.ts';
import { pubmedResponse, fixturePmid } from './fixtures/ep-metadata.ts';

const now = '2026-10-01T14:00:00.000Z';
function material(title = 'VARIPULSE prospective study'): NewsMaterial {
  const source = NEWS_SOURCES[1]!, url = 'https://www.jnj.com/media-center/press-releases/synthetic-owned-fixture';
  return { version: PRIVATE_NEWS_VERSION, kind: 'official', scope: 'title', sourceId: source.id, sourceName: source.name,
    title, url, acquiredAt: now, metadata: null, recordId: null, relatedResearch: null, product: productFromTitle(title, url) };
}
test('source titles determine brand association and report type; model output never does', () => {
  assert.equal(productFromTitle('Pulsed field ablation in admIRE', 'https://example.invalid').status, 'candidate');
  assert.equal(productFromTitle('VARIPULSE follow-up', 'https://example.invalid').status, 'confirmed');
  assert.equal(newsKind('VARIPULSE prospective study', false), 'paper');
  assert.equal(newsKind('VARIPULSE sub-analysis', false), 'follow_up');
  assert.equal(newsKind('VARIPULSE sub-analysis', true), 'official');
});
test('saved news provenance rejects a forged brand, source and material scope', () => {
  const own = material(); assert.equal(parseNewsMaterial(own).title, own.title);
  assert.throws(() => parseNewsMaterial({ ...own, product: { ...own.product, quote: 'Different title' } }));
  assert.throws(() => parseNewsMaterial({ ...own, url: 'https://other.invalid/news' }));
  assert.throws(() => parseNewsMaterial({ ...own, scope: 'fulltext' }));
});
test('title-only metadata removes abstracts and sections instead of implying processing permission', () => {
  const output = titleMetadata({ provider: 'pubmed', providerId: '123', pmid: '123', doi: null, title: 'Owned fixture',
    authors: [], journal: null, publishedYear: 2026, publishedOn: null, acquiredAt: now, sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/123/',
    abstract: 'Must not enter the news model', abstractFormat: 'plain', abstractLocator: 'Abstract', versionLabel: null,
    abstractSections: [{ label: 'RESULTS', text: 'Must not enter the news model' }] });
  assert.equal(output.abstract, null); assert.equal(output.abstractFormat, null); assert.ok(!('abstractSections' in output));
});
test('Chinese copy has a source quote and cannot introduce numerical or clinical conclusions', () => {
  const source = material(), copy = { titleZh: 'VARIPULSE 研究动态', leadZh: '介绍题名中的研究话题。', basisQuote: source.title };
  assert.match(newsDisplay(copy, source, now).leadZh, /^厂商题名信息：/);
  for (const invalid of [{ ...copy, basisQuote: 'Not supplied' }, { ...copy, leadZh: '研究发现死亡率下降。' }, { ...copy, leadZh: '纳入50人。' }]) assert.throws(() => newsDisplay(invalid, source, now));
  const candidate = material('Pulsed field study');
  assert.throws(() => newsDisplay({ ...copy, basisQuote: candidate.title }, candidate, now));
});
test('free discovery reuses PubMed lookup, saves no abstract, and treats an empty official feed as success', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input); calls.push(url);
    return url.includes('esearch.fcgi') ? Response.json({ esearchresult: { count: '1', idlist: [fixturePmid] } }) : new Response(pubmedResponse);
  };
  const result = await discoverPrivateNews({ days: 30, limit: 2, now: new Date(now), fetcher, officialReader: async () => [] });
  assert.equal(result[0]!.status, 'ok'); assert.equal(result[0]!.candidates.length, 1);
  assert.equal(result[0]!.candidates[0]!.material.metadata!.abstract, null);
  assert.equal(result[0]!.candidates[0]!.input.bodyText, undefined);
  assert.equal(result[1]!.status, 'ok'); assert.equal(result[1]!.candidates.length, 0);
  assert.equal(calls.length, 2); assert.ok(calls.every(url => url.startsWith('https://eutils.ncbi.nlm.nih.gov/')));
  const duplicate = await discoverPrivateNews({ days: 30, limit: 2, now: new Date(now), fetcher,
    officialReader: async () => [], historicalIds: new Set(['pmid:' + fixturePmid]) });
  assert.equal(duplicate[0]!.candidates.length, 0); assert.equal(calls.length, 3);
});
test('source failure is retained distinctly from an empty result, with zero retries', async () => {
  let attempts = 0;
  const result = await discoverPrivateNews({ days: 30, limit: 2, fetcher: async () => { attempts++; throw new Error('Synthetic failure'); }, officialReader: async () => [] });
  assert.equal(attempts, 1); assert.equal(result[0]!.status, 'unavailable'); assert.equal(result[1]!.status, 'ok');
});
test('an undated official record cannot be introduced as current-day news', async () => {
  const result = await discoverPrivateNews({ days: 30, limit: 2, now: new Date(now),
    fetcher: async () => Response.json({ esearchresult: { count: '0', idlist: [] } }),
    officialReader: async () => [{ title: 'VARIPULSE owned undated fixture', url: material().url, publishedAt: null }] });
  const candidate = result[1]!.candidates[0]!;
  assert.equal(candidate.input.publishedAt, null);assert.equal(candidate.input.backfill, 'publication-date-unknown');
  assert.equal(candidate.material.kind, 'official');
});
test('a news reference keeps literal identifiers instead of guessing that a report is the paper', () => {
  assert.deepEqual(explicitNewsReferences('admIRE results match a known cohort'), []);
  const references = explicitNewsReferences('See https://pubmed.ncbi.nlm.nih.gov/123/ and https://doi.org/10.9999/owned-fixture');
  assert.equal(references.length, 2); assert.equal(references[0]!.kind, 'pmid'); assert.equal(references[1]!.value, '10.9999/owned-fixture');
  const source = material();
  assert.throws(() => parseNewsMaterial({ ...source, relatedResearch: { recordId: '11111111-1111-4111-8111-111111111111',
    pmid: '123', doi: null, sourceReference: references[0]!.url, method: 'exact_identifier' } }));
});
test('one batch authorization binds exact requests and budget; old extraction approvals are rejected', () => {
  const plan = { hash: 'owned-plan', maxRequests: 2, upperBoundMicros: 20, requests: [{ requestHash: 'a' }, { requestHash: 'b' }] };
  const approval = { version: 'ep-private-news-authorization-v1' as const, planHash: plan.hash, currency: 'CNY' as const,
    authorizedMicros: 20, maxRequests: 2, requestHashes: ['a', 'b'], expiresAt: '2026-10-02T00:00:00Z', humanRequest: 'Owned synthetic explicit authorization' };
  validateNewsAuthorization(approval, plan, Date.parse(now));
  assert.throws(() => validateNewsAuthorization({ ...approval, authorizedMicros: 19 }, plan, Date.parse(now)));
  assert.throws(() => validateNewsAuthorization({ ...approval, requestHashes: ['a', 'c'] }, plan, Date.parse(now)));
  assert.throws(() => validateNewsAuthorization({ ...approval, expiresAt: now }, plan, Date.parse(now)));
  assert.throws(() => validateNewsAuthorization({ ...approval, version: 'abstract-trial-v1' } as never, plan, Date.parse(now)));
  assert.equal(newsCostCeiling(2243, 512, 2000000, 8000000), 8582);
  assert.throws(() => newsArguments(['--days', '366']));
  assert.throws(() => newsArguments(['--enable-scheduler']));
});
