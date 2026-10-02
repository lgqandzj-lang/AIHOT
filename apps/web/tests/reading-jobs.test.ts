// Built SSR is exercised in memory; every upstream request is mocked, with no live services or model calls.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createRequestHandler } from 'react-router';
import { loadReadingJobs, readingJobsProjection } from '../app/features/research/reading-jobs.server.ts';
import type { PrivateReadingJobs, ResearchPaper } from '../app/features/research/contracts.ts';

const marker = 'SYNTHETIC_TASK_INTERNALS_MUST_NOT_REACH_READERS';
const acquiredAt = '2026-10-02T00:00:00.000Z';
const paper: ResearchPaper = {
  id: 'owned-reader', pmid: '1', doi: '10.9999/owned-fixture', title: 'Owned VARIPULSE workflow study',
  journal: 'Owned journal', year: 2026, authors: ['Fixture Author'], topic: 'pfa',
  sources: [{ name: 'Owned source', url: 'https://pubmed.ncbi.nlm.nih.gov/1/', acquiredAt }],
  privateResearch: { recordId: 'owned-record', readerVersion: 0, publishedOn: null, studyType: 'Owned study', materialScope: 'fulltext',
    product: { id: 'varipulse', status: 'confirmed', evidence: { label: 'Owned title', quote: 'Owned VARIPULSE workflow study', url: 'https://pubmed.ncbi.nlm.nih.gov/1/' } }, questions: [] },
};
const reading = {
  readerId: paper.id, pmid: paper.pmid, doi: paper.doi, originalTitle: paper.title,
  status: 'private_model_draft', humanApprovalGranted: false, materialScope: 'fulltext', semanticStatus: 'not_evaluated',
  generatedAt: acquiredAt, titleZh: '已有合成中文解读题名', leadZh: '仅用于验证页面读取的自有合成文字。',
  markdown: '摘要事实 [AB1]；全文限制 [FT1]。', html: '<p>摘要事实 <a href="#reading-evidence-AB1">AB1</a>；全文限制 <a href="#reading-evidence-FT1">FT1</a>。</p>',
  model: 'owned-fixture', correctionNotes: [], corrections: [], sources: [
    { id: 'AB1', scope: 'abstract', label: 'Owned abstract', text: 'Owned abstract evidence.', sourceUrl: paper.sources[0]!.url, hash: 'a'.repeat(64) },
    { id: 'FT1', scope: 'fulltext', label: 'Owned full text', text: 'Owned full text evidence.', sourceUrl: 'https://example.invalid/owned-text', hash: 'b'.repeat(64) },
  ], license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', copyright: 'Owned fixture authors', changesNotice: 'Owned fixture.' },
};
function jobsFixture(): PrivateReadingJobs {
  return { private: true, jobs: ['saved', 'ready', 'in_flight', 'blocked', 'pending'].map((status, index) => ({
    pmid: String(index + 1), doi: index ? null : paper.doi, originalTitle: index ? `Owned fixture study ${index + 1}` : paper.title,
    titleZh: index ? null : reading.titleZh, readerId: index ? null : paper.id, status: status as PrivateReadingJobs['jobs'][number]['status'],
    updatedAt: index ? null : acquiredAt, reason: status === 'blocked' ? '来源尚未提供可用全文。' : null,
  })) };
}
function privateEnvironment(context: TestContext, preview = true, privateDrafts = true) {
  const values = { EP_RESEARCH_PREVIEW_ENABLED: String(preview), EP_RESEARCH_PRIVATE_DRAFTS_ENABLED: String(privateDrafts),
    EP_CHINESE_READING_API: 'http://127.0.0.1:3202/api/research-preview/chinese-readings', API_BASE_URL: 'http://127.0.0.1:3001' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  context.after(() => { for (const key of Object.keys(values)) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
}

test('reading progress projects all five saved statuses, original titles and nullable fields without task internals', () => {
  const fixture = jobsFixture();
  const raw = { ...fixture, directory: marker, jobs: fixture.jobs.map(job => ({ ...job, prompt: marker, rawResponse: marker })) };
  assert.deepEqual(readingJobsProjection(raw), fixture);
  assert.ok(!JSON.stringify(readingJobsProjection(raw)).includes(marker));
  assert.equal(readingJobsProjection(raw).jobs[1]!.titleZh, null);
});

test('private progress rejects malformed identifiers, dates, states, duplicates and oversized payloads', () => {
  for (const change of [
    { pmid: '../1' }, { doi: 'javascript:alert(1)' }, { readerId: 'https://external.invalid/reader' },
    { status: 'generated' }, { updatedAt: 'not a timestamp' }, { titleZh: undefined },
  ]) {
    const fixture = jobsFixture();
    assert.throws(() => readingJobsProjection({ ...fixture, jobs: [{ ...fixture.jobs[0], ...change }] }));
  }
  assert.throws(() => readingJobsProjection({ ...jobsFixture(), private: false }));
  assert.throws(() => readingJobsProjection({ private: true, jobs: Array(101).fill(jobsFixture().jobs[0]) }));
  assert.throws(() => readingJobsProjection({ private: true, jobs: [jobsFixture().jobs[0], jobsFixture().jobs[0]] }));
});

test('reader reasons keep material explanations and omit paths, prompts, fingerprints and approval details', () => {
  for (const reason of ['C:\\private\\material.json', '/tmp/private/material', 'prompt: ' + marker, 'hash: ' + 'a'.repeat(64), '预算审批尚未通过', '{"task":"private"}']) {
    const fixture = jobsFixture();
    fixture.jobs[3]!.reason = reason;
    assert.equal(readingJobsProjection(fixture).jobs[3]!.reason, null);
  }
  assert.equal(readingJobsProjection(jobsFixture()).jobs[3]!.reason, '来源尚未提供可用全文。');
});

test('progress fetch is default-off and uses only a fixed, uncached local GET with redirects rejected', async context => {
  privateEnvironment(context, false, false);
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), 'http://127.0.0.1:3202/api/research-preview/reading-jobs');
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    assert.equal((init?.headers as Record<string, string>).accept, 'application/json');
    return Response.json(jobsFixture());
  });
  const signal = new AbortController().signal;
  assert.equal(await loadReadingJobs(signal), null);
  process.env.EP_RESEARCH_PREVIEW_ENABLED = 'true';
  assert.equal(await loadReadingJobs(signal), null);
  process.env.EP_RESEARCH_PREVIEW_ENABLED = 'false'; process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED = 'true';
  assert.equal(await loadReadingJobs(signal), null);
  assert.equal(calls, 0);
  process.env.EP_RESEARCH_PREVIEW_ENABLED = 'true';
  assert.deepEqual(await loadReadingJobs(signal), jobsFixture());
  assert.equal(calls, 1);
});

test('progress loading exposes no response diagnostics and forwards cancellation', async context => {
  privateEnvironment(context);
  context.mock.method(globalThis, 'fetch', async () => new Response(marker, { status: 503 }));
  await assert.rejects(loadReadingJobs(new AbortController().signal), /Reading progress HTTP 503/);
  const controller = new AbortController(); controller.abort();
  context.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => { init?.signal?.throwIfAborted(); return Response.json(jobsFixture()); });
  await assert.rejects(loadReadingJobs(controller.signal), error => error instanceof Error && error.name === 'AbortError');
});

async function builtHandler() {
  const build = await import(new URL('../build/server/index.js', import.meta.url).href);
  return createRequestHandler(build, 'production');
}
function mockUpstream(context: TestContext, getJobs: () => unknown = jobsFixture, jobsStatus = 200, getExperience = () => ({ preview: true, papers: [paper], example: null }), getReadings = () => [reading]) {
  const paths: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, '127.0.0.1'); assert.ok(!init?.method || init.method === 'GET');
    paths.push(url.pathname);
    if (url.pathname === '/api/site/meta') return Response.json({ changelogVersion: null });
    if (url.pathname === '/api/research-preview/experience') return Response.json(getExperience());
    if (url.pathname === '/api/research-preview/chinese-readings') return Response.json({ private: true, papers: [paper], readings: getReadings() });
    if (url.pathname === '/api/research-preview/reading-jobs') return Response.json(getJobs(), { status: jobsStatus });
    throw new Error('Unexpected fixture request: ' + url.pathname);
  });
  return paths;
}

test('built private work page shows real states, saved Chinese and source links, with no generation controls or diagnostics', async context => {
  privateEnvironment(context);
  const paths = mockUpstream(context, () => ({ ...jobsFixture(), files: marker, jobs: jobsFixture().jobs.map(job => ({ ...job, prompt: marker, token: marker })) }));
  const handler = await builtHandler(), response = await handler(new Request('http://127.0.0.1:3200/research/work'));
  const html = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control') || '', /private.*no-store/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  for (const label of ['待整理', '材料已就绪', '整理中', '需补材料', '可阅读', '本页只读', '刷新进度']) assert.ok(html.includes(label));
  assert.ok(html.includes(reading.titleZh)); assert.ok(html.includes('Owned fixture study 2'));
  assert.ok(html.includes('href="/research/read/owned-reader"')); assert.ok(html.includes('https://pubmed.ncbi.nlm.nih.gov/1/'));
  assert.ok(!html.includes(marker)); assert.ok(!html.includes('<form')); assert.ok(!html.includes('生成解读'));
  assert.equal(paths.filter(path => path.endsWith('/reading-jobs')).length, 1);
  const reader = await handler(new Request('http://127.0.0.1:3200/research/read/owned-reader'));
  assert.equal(reader.status, 200); assert.ok((await reader.text()).includes('中文研究解读'));
  assert.equal(paths.filter(path => path.endsWith('/reading-jobs')).length, 1);
});

test('work HTML and loader data are private-only and progress is not fetched from unrelated product pages', async context => {
  privateEnvironment(context);
  const paths = mockUpstream(context), handler = await builtHandler();
  const product = await handler(new Request('http://127.0.0.1:3200/research/products/varipulse'));
  assert.equal(product.status, 200); assert.ok((await product.text()).includes('href="/research/work"'));
  assert.equal(paths.filter(path => path.endsWith('/reading-jobs')).length, 0);
  for (const [preview, privateDrafts] of [['false', 'false'], ['true', 'false'], ['false', 'true']]) {
    process.env.EP_RESEARCH_PREVIEW_ENABLED = preview; process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED = privateDrafts;
    for (const path of ['/research/work', '/research/work.data']) {
      const response = await handler(new Request('http://127.0.0.1:3200' + path)), body = await response.text();
      assert.equal(response.status, 404); assert.ok(!body.includes(reading.titleZh)); assert.ok(!body.includes('readingJobs'));
      assert.ok(!body.includes('href="/research/work"'));
    }
  }
  assert.equal(paths.filter(path => path.endsWith('/reading-jobs')).length, 0);
});

test('a saved job links to the latest readable bibliography even when its saved reader ID is older', async context => {
  privateEnvironment(context);
  const latestPaper = { ...paper, id: 'latest-owned-reader', privateResearch: { ...paper.privateResearch!, readerVersion: 1 } };
  const fixture = jobsFixture(); fixture.jobs[0]!.readerId = 'saved-original-reader';
  mockUpstream(context, () => fixture, 200, () => ({ preview: true, papers: [paper, latestPaper], example: null }));
  const handler = await builtHandler(), response = await handler(new Request('http://127.0.0.1:3200/research/work'));
  const html = await response.text();
  assert.equal(response.status, 200); assert.ok(html.includes('href="/research/read/latest-owned-reader"'));
  assert.ok(!html.includes('href="/research/read/saved-original-reader"')); assert.ok(!html.includes('href="/research/read/owned-reader"'));
  const reader = await handler(new Request('http://127.0.0.1:3200/research/read/latest-owned-reader'));
  assert.equal(reader.status, 200); assert.ok((await reader.text()).includes('中文研究解读'));
});

test('a saved job cannot link to absent Chinese readings or mismatched paper identities, and unavailable progress stays readable', async context => {
  privateEnvironment(context);
  let fixture: unknown = jobsFixture();
  let readings = [reading];
  mockUpstream(context, () => fixture, 200, undefined, () => readings);
  const handler = await builtHandler();
  for (const change of [{ pmid: '9' }, { doi: '10.9999/another-paper' }, { originalTitle: 'Owned other study' }]) {
    fixture = { private: true, jobs: [{ ...jobsFixture().jobs[0], ...change }] };
    const response = await handler(new Request('http://127.0.0.1:3200/research/work')), html = await response.text();
    assert.equal(response.status, 200); assert.ok(!html.includes('阅读中文解读')); assert.ok(html.includes('阅读入口暂不可用'));
  }
  fixture = jobsFixture(); readings = [];
  const missingReading = await handler(new Request('http://127.0.0.1:3200/research/work')), missingHtml = await missingReading.text();
  assert.equal(missingReading.status, 200); assert.ok(!missingHtml.includes('阅读中文解读')); assert.ok(missingHtml.includes('阅读入口暂不可用'));
  fixture = { private: false, jobs: jobsFixture().jobs, error: marker };
  const response = await handler(new Request('http://127.0.0.1:3200/research/work')), html = await response.text();
  assert.equal(response.status, 200); assert.ok(html.includes('进度暂时无法加载')); assert.ok(!html.includes(marker));
  assert.ok(html.includes('刷新进度'));
});
