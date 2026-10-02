import assert from 'node:assert/strict';
import { test } from 'node:test';
import { genericFulltextSnapshot, resolvePmcIdentity } from '../packages/backend/src/research/reading-materials.ts';
import { sha256 } from '../packages/backend/src/lib/ids.ts';

const identity = { pmid: '39820338', doi: '10.1093/europace/euaf007', pmcid: 'PMC11879039' };
const acquiredAt = '2026-10-02T00:00:00.000Z';
const methods = 'Synthetic methods: investigators prospectively enrolled a defined patient cohort, recorded the procedure sequence, and measured outcomes using prespecified definitions.';
const results = 'Synthetic results: 10 patients completed the procedure, 40 veins were assessed, and one event occurred during the recorded observation window; long-term outcomes were unavailable.';
const rights = '<div id="clp_a"><div>© The Synthetic Authors 2026.</div><p>This article is distributed under the Creative Commons Attribution License <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.</p></div>';
const citation = `<div>doi: <a href="https://doi.org/${identity.doi}">${identity.doi}</a></div><div>PMCID: ${identity.pmcid} PMID: <a href="https://pubmed.ncbi.nlm.nih.gov/${identity.pmid}/">${identity.pmid}</a></div>`;
const modern = (license = rights, body = `<section id="methods"><h2>Materials and methods</h2><section id="workflow"><h3>Workflow</h3><p>${methods}</p></section></section><section id="results"><h2>Results</h2><p>${results}</p><figure id="figure1"><figcaption>Figure 1. Synthetic procedure workflow.</figcaption><img src="https://never-fetch.example/figure.png"></figure><div class="table-wrap" id="table1"><div class="caption">Table 1. Synthetic measurements.</div><table><tr><th>Group</th><th>Count</th></tr><tr><td>Participants</td><td>10</td></tr></table></div></section>`) =>
  `<html><head><meta name="citation_pmid" content="${identity.pmid}"><meta name="citation_doi" content="${identity.doi}"></head><body><article><section aria-label="Article citation and metadata">${citation}${license}</section><section aria-label="Article content"><section class="body main-article-body"><section class="abstract" id="abstract1"><h2>Abstract</h2><p>Excluded synthetic abstract.</p></section>${body}<section class="ref-list"><h2>References</h2><p>Excluded synthetic reference.</p></section></section></section></article></body></html>`;

test('PMC identity resolver issues exactly one bounded official request and binds all identifiers', async () => {
  let calls = 0;
  const fetchImpl = (async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://pmc.ncbi.nlm.nih.gov');
    assert.equal(url.pathname, '/tools/idconv/api/v1/articles/');
    assert.equal(url.searchParams.get('ids'), identity.pmid);
    assert.equal(url.searchParams.get('idtype'), 'pmid');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return new Response(JSON.stringify({ status: 'ok', records: [{ ...identity, doi: identity.doi.toUpperCase() }] }));
  }) as typeof fetch;
  assert.deepEqual(await resolvePmcIdentity(identity.pmid, identity.doi, { fetchImpl }), identity);
  assert.equal(calls, 1);
});

test('resolver blocks conflicts, ambiguous records and missing PMC without retries', async () => {
  for (const payload of [
    { status: 'ok', records: [{ ...identity, pmid: '40566035' }] },
    { status: 'ok', records: [{ ...identity, doi: '10.9999/other-paper' }] },
    { status: 'ok', records: [{ ...identity, pmid: 39820338.5 }] },
    { status: 'ok', records: [{ ...identity, pmid: null }] },
    { status: 'ok', records: [identity, identity] },
    { status: 'ok', records: [{ pmid: identity.pmid, doi: identity.doi }] },
    { status: 'error', records: [] },
  ]) {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response(JSON.stringify(payload)); }) as typeof fetch;
    await assert.rejects(resolvePmcIdentity(identity.pmid, identity.doi, { fetchImpl }), /identity mismatch|exactly one article|No PMC full text/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response('', { status: 503 }); }) as typeof fetch;
  await assert.rejects(resolvePmcIdentity(identity.pmid, identity.doi, { fetchImpl }), /HTTP 503/);
  assert.equal(calls, 1);
});

test('resolver accepts the numeric PMID returned by the official JSON endpoint', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ status: 'ok', records: [{ ...identity, pmid: Number(identity.pmid) }] }));
  }) as typeof fetch;
  assert.deepEqual(await resolvePmcIdentity(identity.pmid, identity.doi, { fetchImpl }), identity);
  assert.equal(calls, 1);
});

test('modern nested PMC body preserves section coverage, tables and figure captions deterministically', () => {
  // Fixture prose and legal notice are synthetic; identifiers test the requested article identity only.
  const html = modern();
  const snapshot = genericFulltextSnapshot(html, identity, acquiredAt);
  assert.equal(snapshot.bodyHash, sha256(html));
  assert.equal(snapshot.copyright, '© The Synthetic Authors 2026.');
  assert.equal(snapshot.license, 'CC BY 4.0');
  assert.equal(snapshot.sourceUrl, 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11879039/');
  assert.deepEqual(snapshot.fragments.map(fragment => fragment.id), ['FT1', 'FT2', 'FT3', 'FT4', 'FT5']);
  assert.equal(snapshot.fragments[0].label, 'Materials and methods · Workflow');
  assert.equal(snapshot.fragments[0].text, methods);
  assert.ok(snapshot.fragments.some(fragment => fragment.text === 'Group | Count\nParticipants | 10'));
  assert.ok(snapshot.fragments.some(fragment => fragment.label.includes('Figure caption') && fragment.text.startsWith('Figure 1.')));
  assert.ok(snapshot.fragments.some(fragment => fragment.sourceUrl.endsWith('#workflow')));
  assert.ok(snapshot.fragments.every(fragment => fragment.hash === sha256(fragment.text)));
  assert.doesNotMatch(snapshot.fragments.map(fragment => fragment.text).join(' '), /Excluded|Creative Commons|Synthetic Authors/);
  assert.deepEqual(genericFulltextSnapshot(html, identity, '2026-10-03T00:00:00.000Z').fragments, snapshot.fragments);
});

test('legacy flat PMC body supports unnumbered and numbered Methods/Results, without article-specific safety headings', () => {
  const html = `<article><div class="fm">${citation}${rights.replace('2026', '2021')}</div><div class="body"><h2>摘要</h2><p>Excluded abstract.</p><h2 id="methods">2. 材料与方法</h2><p>${methods} 10<sup>−3</sup> mol and H<sub>2</sub>O.</p><h2 id="results">3. 结果</h2><p>${results}</p><h2>References</h2><p>Excluded reference.</p><h3>Reference category</h3><p>Excluded nested reference.</p></div></article>`;
  const snapshot = genericFulltextSnapshot(html, identity, acquiredAt);
  assert.equal(snapshot.copyright, '© The Synthetic Authors 2021.');
  assert.equal(snapshot.fragments.length, 2);
  assert.match(snapshot.fragments[0].text, /10\^\(−3\) mol and H_\(2\)O/);
  assert.doesNotMatch(snapshot.fragments.map(fragment => fragment.text).join(' '), /Excluded/);
});

test('article license region supports an explicit CCBY4 URL in the publisher terms wording', () => {
  const linkedTerms = '<div id="clp_a"><div>© The Synthetic Authors 2026.</div><p>This is an open access article under the terms of the <a href="http://creativecommons.org/licenses/by/4.0/">http://creativecommons.org/licenses/by/4.0/</a> License, which permits use, distribution and reproduction when cited.</p></div>';
  assert.equal(genericFulltextSnapshot(modern(linkedTerms), identity, acquiredAt).license, 'CC BY 4.0');
  assert.throws(() => genericFulltextSnapshot(modern(linkedTerms.replace('by/4.0', 'by-nc/4.0')), identity, acquiredAt), /license is not CC BY 4.0/);
});

test('bibliography conflicts cannot be rescued by matching identifiers in references', () => {
  for (const [before, after] of [[identity.pmid, '40566035'], [identity.doi, '10.9999/other'], [identity.pmcid, 'PMC12194171']]) {
    const html = modern().replaceAll(before, after).replace('Excluded synthetic reference.', `${identity.pmid} ${identity.doi} ${identity.pmcid}`);
    assert.throws(() => genericFulltextSnapshot(html, identity, acquiredAt), /bibliography.*identity mismatch/);
  }
  assert.throws(() => genericFulltextSnapshot(modern().replace('content="39820338"', 'content="40566035"'), identity, acquiredAt), /metadata conflicts/);
});

test('a reference, site footer or ordinary body CCBY link cannot authorize the article', () => {
  const referenceGrant = modern('').replace('Excluded synthetic reference.', rights);
  const bodyGrant = modern('', `<section><h2>Methods</h2><p>${methods}</p><p><a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a></p></section><section><h2>Results</h2><p>${results}</p></section>`);
  for (const html of [referenceGrant, bodyGrant, modern('') + `<footer>${rights}</footer>`]) {
    assert.throws(() => genericFulltextSnapshot(html, identity, acquiredAt), /no explicit CC BY 4.0 permission/);
  }
});

test('NC, ND and other licenses remain blocked even when references contain a CCBY grant', () => {
  for (const alternative of ['by-nc/4.0', 'by-nd/4.0', 'by-sa/4.0', 'by/3.0']) {
    const html = modern(rights.replace('by/4.0', alternative)).replace('Excluded synthetic reference.', rights);
    assert.throws(() => genericFulltextSnapshot(html, identity, acquiredAt), /license is not CC BY 4.0/);
  }
  assert.throws(() => genericFulltextSnapshot(modern(rights.replace('This article', 'Non-commercial use only. This article')), identity, acquiredAt), /license is not CC BY 4.0/);
  assert.throws(() => genericFulltextSnapshot(modern(rights + rights.replace('id="clp_a"', 'class="license"').replace('by/4.0', 'by-nc/4.0')), identity, acquiredAt), /license is not CC BY 4.0/);
});

test('missing methods/results body and an incomplete case report block preparation', () => {
  for (const body of [
    `<section><h2>Methods</h2></section><section><h2>Results</h2><p>${results}</p></section>`,
    `<section><h2>Methods</h2><p>${methods}</p></section><section><h2>Discussion</h2><p>${results}</p></section>`,
    `<section><h2>Case report</h2><p>${methods}</p><p>${results}</p></section>`,
  ]) assert.throws(() => genericFulltextSnapshot(modern(rights, body), identity, acquiredAt), /omitted Methods\/Results/);
});

test('a sufficiently covered case report can use case and discussion sections', () => {
  const body = `<section id="case"><h2>Case report</h2><p>${methods.repeat(2)}</p><p>${results.repeat(2)}</p></section><section id="discussion"><h2>Discussion</h2><p>${methods.repeat(2)}</p><p>${results.repeat(2)}</p></section>`;
  const snapshot = genericFulltextSnapshot(modern(rights, body), identity, acquiredAt);
  assert.equal(snapshot.fragments.length, 4);
  assert.equal(snapshot.fragments[0].label, 'Case report');
});

test('an unheaded short report preserves complete body paragraphs and structured observed data', () => {
  const prose = `<p>${methods.repeat(3)}</p><p>${methods.repeat(3)}</p><p>${results.repeat(3)}</p><p>${results.repeat(3)}</p>`;
  const table = '<div class="tbl-box p"><div class="caption">Table 1. Synthetic observations.</div><table><tr><th>Patient</th><th>Observation</th></tr><tr><td>1</td><td>Recorded</td></tr></table></div>';
  const snapshot = genericFulltextSnapshot(modern(rights, prose + table), identity, acquiredAt);
  assert.ok(snapshot.fragments.some(fragment => fragment.text === 'Patient | Observation\n1 | Recorded'));
  assert.equal(snapshot.fragments.filter(fragment => fragment.text.includes('Synthetic observations')).length, 1);
  assert.equal(snapshot.fragments.filter(fragment => fragment.text.startsWith('Synthetic methods:')).length, 2);
});

test('an abstract, captions or administrative prose cannot complete an incomplete short report', () => {
  const table = '<table><tr><th>Patient</th><th>Observation</th></tr><tr><td>1</td><td>Recorded</td></tr></table>';
  const shortBody = `<p>${methods.repeat(3)}</p><p>${results.repeat(3)}</p>`;
  for (const padding of [
    `<figure><figcaption><p>${results.repeat(12)}</p><p>${methods.repeat(12)}</p></figcaption></figure>`,
    `<section><h2>Funding information</h2><p>${results.repeat(12)}</p><p>${methods.repeat(12)}</p></section>`,
  ]) assert.throws(() => genericFulltextSnapshot(modern(rights, shortBody + table + padding), identity, acquiredAt), /omitted Methods\/Results/);
  const fullProse = shortBody + shortBody;
  assert.throws(() => genericFulltextSnapshot(modern(rights, fullProse + '<table><tr><th>Patient</th></tr></table>'), identity, acquiredAt), /omitted Methods\/Results/);
});
