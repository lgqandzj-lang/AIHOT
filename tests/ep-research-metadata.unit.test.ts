import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossrefResponse, fixtureDoi, fixturePmid, pubmedResponse } from './fixtures/ep-metadata.ts';
import { fetchCrossrefMetadata, fetchPubmedMetadata, normalizeMetadata } from '../packages/backend/src/research/metadata.ts';

const acquired = new Date('2026-09-30T02:30:00.000Z');
const fixedNow = () => acquired;

test('Crossref DOI lookup maps only supplied bibliographic fields', async () => {
  let calls = 0;
  const fetcher = (async (url: string | URL | Request) => {
    calls++;
    assert.equal(String(url), 'https://api.crossref.org/works/10.9999%2Fvaripulse-metadata-fixture');
    return new Response(JSON.stringify(crossrefResponse), { status: 200 });
  }) as typeof fetch;
  const result = await fetchCrossrefMetadata('https://doi.org/' + fixtureDoi.toUpperCase(), { fetcher, now: fixedNow });
  assert.equal(calls, 1);
  assert.equal(result.doi, fixtureDoi);
  assert.equal(result.pmid, null);
  assert.equal(result.title, '[SYNTHETIC] VARIPULSE metadata fixture');
  assert.equal(result.publishedOn, '2025-10-23');
  assert.equal(result.abstract, null);
  assert.equal(result.acquiredAt, acquired.toISOString());
  assert.ok(!('studyDesign' in result));
});

test('PubMed PMID lookup preserves source, abstract locator, and unknown clinical fields', async () => {
  const fetcher = (async (url: string | URL | Request) => {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.hostname, 'eutils.ncbi.nlm.nih.gov');
    assert.equal(requestUrl.searchParams.get('id'), fixturePmid);
    assert.equal(requestUrl.searchParams.get('db'), 'pubmed');
    return new Response(pubmedResponse, { status: 200 });
  }) as typeof fetch;
  const result = await fetchPubmedMetadata(fixturePmid, { fetcher, now: fixedNow });
  assert.equal(result.doi, fixtureDoi);
  assert.equal(result.pmid, fixturePmid);
  assert.equal(result.title, '[SYNTHETIC] VARIPULSE™ metadata fixture');
  assert.equal(result.journal, 'Example Electrophysiology Journal');
  assert.equal(result.abstract, 'Background: Fixed abstract text for offline testing.');
  assert.equal(result.abstractLocator, 'PubMed:Article.Abstract');
  assert.equal(result.versionLabel, '2025-11-04');
  assert.ok(!('population' in result));
});

test('partial dates and missing title remain unknown', () => {
  const result = normalizeMetadata({
    provider: 'pubmed', providerId: fixturePmid,
    sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/' + fixturePmid + '/',
    acquiredAt: acquired.toISOString(), doi: null, pmid: fixturePmid,
    title: null, authors: [], journal: null, publishedYear: 2025, publishedOn: null,
    abstract: null, abstractFormat: null, abstractLocator: null, versionLabel: null,
  });
  assert.equal(result.title, null);
  assert.equal(result.publishedYear, 2025);
  assert.equal(result.publishedOn, null);
  assert.equal(result.abstract, null);
});

test('provider identity mismatch fails before persistence', async () => {
  const payload = structuredClone(crossrefResponse);
  payload.message.DOI = '10.9999/another-paper';
  const fetcher = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  await assert.rejects(fetchCrossrefMetadata(fixtureDoi, { fetcher, now: fixedNow }), /different DOI/);
});
