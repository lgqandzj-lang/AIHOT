import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachChineseReadings, mergeSavedChineseReadings, savedChineseReadings } from '../app/features/research/chinese-reading.server.ts';
import { readerProjection } from '../app/features/research/experience.server.ts';
import type { ResearchPaper } from '../app/features/research/contracts.ts';

const title = 'Owned synthetic VARIPULSE workflow study';
const pmid = '900001';
const doi = '10.9999/synthetic.900001';
const sourceUrl = 'https://example.invalid/synthetic-study';
const acquiredAt = '2026-01-01T00:00:00.000Z';

function paper(id: string, recordId: string, readerVersion: number, bibliography: Partial<Pick<ResearchPaper, 'title' | 'pmid' | 'doi'>> = {}): ResearchPaper {
  const paperTitle = bibliography.title ?? title;
  return {
    id, title, pmid, doi, ...bibliography, journal: 'Synthetic Journal', year: 2025, authors: ['Fixture Author'], topic: 'pfa',
    sources: [{ name: 'Owned synthetic source', url: sourceUrl, acquiredAt }],
    privateResearch: {
      recordId, readerVersion, publishedOn: null, studyType: 'Synthetic study', materialScope: 'fulltext',
      product: { id: 'varipulse', status: 'confirmed', evidence: { label: 'Owned synthetic source', quote: paperTitle, url: sourceUrl } },
      questions: [],
    },
  };
}

function savedReading(source: ResearchPaper) {
  return {
    private: true,
    readings: [{
      readerId: source.id, pmid: source.pmid, doi: source.doi, originalTitle: source.title,
      status: 'private_model_draft', humanApprovalGranted: false, materialScope: 'fulltext', semanticStatus: 'assistant_source_comparison',
      generatedAt: acquiredAt, titleZh: '合成研究的中文解读', leadZh: '这是一份仅供测试的合成解读。', markdown: '摘要事实 [AB1]；全文限制 [FT1]。',
      html: '<p>摘要事实 <a href="#reading-evidence-AB1">AB1</a>；全文限制 <a href="#reading-evidence-FT1">FT1</a>。</p>',
      model: 'synthetic-model', correctionNotes: [], corrections: [],
      sources: [
        { id: 'AB1', scope: 'abstract', label: 'Synthetic abstract', text: 'Abstract evidence.', sourceUrl, hash: 'a'.repeat(64) },
        { id: 'FT1', scope: 'fulltext', label: 'Synthetic full text', text: 'Full text evidence.', sourceUrl, hash: 'b'.repeat(64) },
      ],
      license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', copyright: 'Synthetic authors', changesNotice: 'Synthetic fixture' },
    }],
  };
}

function projectPaper(value: unknown): ResearchPaper {
  const enabled = process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED;
  process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED = 'true';
  try { return readerProjection({ preview: true, papers: [value], example: null }).papers[0]!; }
  finally {
    if (enabled === undefined) delete process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED;
    else process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED = enabled;
  }
}

const secondPaper = () => paper('second-v0', 'second-record', 0, { pmid: '900002', doi: '10.9999/synthetic.900002', title: 'Owned second VARIPULSE workflow study' });

test('a version-0 saved reading attaches only to the latest matching version without changing input papers', () => {
  const old = paper('record-one-v0', 'record-one', 0), latest = paper('record-one-v1', 'record-one', 1);
  const papers = [old, latest, paper('other-v0', 'other-record', 0)], before = structuredClone(papers);
  const attached = attachChineseReadings(papers, savedReading(old));
  assert.deepEqual(papers, before);
  assert.equal(attached[0], old);
  assert.equal(attached[0]!.chineseReading, undefined);
  assert.equal(attached[1]!.id, latest.id);
  assert.equal(attached[1]!.chineseReading?.titleZh, '合成研究的中文解读');
  assert.equal(attached[2], papers[2]);
  assert.equal(attached[2]!.chineseReading, undefined);
});

test('another record cannot inherit the reading; changed PMID, DOI or title blocks a version upgrade', () => {
  const old = paper('record-one-v0', 'record-one', 0);
  const unrelated = paper('record-two-v1', 'record-two', 1);
  const separate = attachChineseReadings([old, unrelated], savedReading(old));
  assert.ok(separate[0]!.chineseReading);
  assert.equal(separate[1]!.chineseReading, undefined);

  for (const bibliography of [{ pmid: 'different-pmid' }, { doi: '10.9999/different' }, { title: 'Different synthetic paper' }]) {
    const changed = paper('record-one-v1', 'record-one', 1, bibliography);
    assert.throws(() => attachChineseReadings([old, changed], savedReading(old)), /version bibliography changed/);
  }
  for (const field of ['pmid', 'doi', 'originalTitle'] as const) {
    const payload = savedReading(old);
    payload.readings[0]![field] = 'not the source bibliography';
    assert.throws(() => attachChineseReadings([old], payload), /does not match its bibliography/);
  }
});

test('claimed human approval, unsafe HTML links and citations to absent sources are rejected', () => {
  const old = paper('record-one-v0', 'record-one', 0);
  const approved = savedReading(old);
  approved.readings[0]!.humanApprovalGranted = true;
  assert.throws(() => attachChineseReadings([old], approved), /provenance changed/);

  for (const html of [
    '<script>alert(1)</script><p>摘要事实 <a href="#reading-evidence-AB1">AB1</a></p>',
    '<p>摘要事实 <a href="https://evil.invalid/">AB1</a></p>',
    '<p>摘要事实 <a href="javascript:alert(1)">AB1</a></p>',
  ]) {
    const payload = savedReading(old);
    payload.readings[0]!.html = html;
    assert.throws(() => attachChineseReadings([old], payload), /Unsafe prose markup/);
  }
  const absentCitation = savedReading(old);
  absentCitation.readings[0]!.markdown = '不存在的全文片段 [FT999]';
  assert.throws(() => attachChineseReadings([old], absentCitation), /Missing prose citation/);
});

test('saved prose supports the legacy DTO and adds a missing bibliography through the existing whitelist', () => {
  const existing = paper('record-one-v0', 'record-one', 0), second = secondPaper();
  assert.deepEqual(mergeSavedChineseReadings([existing], { private: true, readings: [] }), [existing]);
  const payload = { ...savedReading(second), papers: [second] }, before = structuredClone(payload);
  const merged = mergeSavedChineseReadings([existing], payload, projectPaper);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], existing);
  assert.equal(merged[1]!.id, second.id);
  assert.equal(merged[1]!.privateDraft, undefined);
  assert.equal(merged[1]!.privateResearch!.recordId, 'second-record');
  assert.equal(merged[1]!.chineseReading?.titleZh, '合成研究的中文解读');
  assert.deepEqual(payload, before);
});

test('merging retains every unique reader id and attaches prose only to the highest readerVersion', () => {
  const old = paper('record-one-v0', 'record-one', 0), version1 = paper('record-one-v1', 'record-one', 1);
  const version2 = paper('record-one-v2', 'record-one', 2), latest = paper('record-one-v3', 'record-one', 3);
  const input = [old, version1], before = structuredClone(input);
  const merged = mergeSavedChineseReadings(input, { ...savedReading(old), papers: [version2, latest, version1, latest] }, projectPaper);
  assert.deepEqual(merged.map(paper => paper.id), [old.id, version1.id, version2.id, latest.id]);
  assert.equal(merged.find(paper => paper.id === latest.id)!.privateResearch!.readerVersion, 3);
  assert.deepEqual(merged.filter(paper => paper.chineseReading).map(paper => paper.id), [latest.id]);
  for (const readerId of [old.id, version1.id]) assert.ok(merged.find(paper => paper.id === readerId));
  assert.deepEqual(input, before);
  assert.deepEqual(mergeSavedChineseReadings([old, latest], { private: true, readings: [] }), [old, latest]);
});

test('existing detail and saved-reader ids still resolve when a new version receives the Chinese reading', () => {
  const old = paper('record-one-v0', 'record-one', 0), latest = paper('record-one-v1', 'record-one', 1), other = secondPaper();
  const alreadyRead = attachChineseReadings([old], savedReading(old))[0]!;
  const input = [alreadyRead, other], before = structuredClone(input), savedIds = [old.id, other.id];
  const merged = mergeSavedChineseReadings(input, { ...savedReading(old), papers: [latest] }, projectPaper);
  const detailId = `/research/read/${old.id}`.split('/read/')[1];
  assert.equal(merged.find(paper => paper.id === detailId)!.title, old.title);
  assert.deepEqual(merged.filter(paper => savedIds.includes(paper.id)).map(paper => paper.id), savedIds);
  assert.equal(merged.find(paper => paper.id === old.id)!.chineseReading, undefined);
  assert.deepEqual(merged.filter(paper => paper.chineseReading).map(paper => paper.id), [latest.id]);
  assert.deepEqual(input, before);
});

test('a same-id bibliography-only paper can receive validated private record metadata', () => {
  const second = secondPaper(), { privateResearch, ...bibliography } = second;
  const merged = mergeSavedChineseReadings([bibliography], { ...savedReading(second), papers: [second] }, projectPaper);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.privateResearch?.recordId, privateResearch!.recordId);
  assert.ok(merged[0]!.chineseReading);
});

test('mismatched PMID, DOI or title rejects only the supplemental record and preserves a valid existing reading', () => {
  const existing = paper('record-one-v0', 'record-one', 0);
  for (const bibliography of [{ pmid: 'different-pmid' }, { doi: '10.9999/different' }, { title: 'Different VARIPULSE synthetic paper' }]) {
    const changed = paper('record-one-v1', 'record-one', 1, bibliography), second = secondPaper();
    const merged = mergeSavedChineseReadings([existing], { private: true, papers: [changed, second],
      readings: [...savedReading(existing).readings, ...savedReading(changed).readings, ...savedReading(second).readings] }, projectPaper);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]!.id, existing.id);
    assert.ok(merged[0]!.chineseReading);
    assert.equal(merged[1]!.id, second.id);
    assert.ok(merged[1]!.chineseReading);
  }
});

test('invalid supplemental provenance and unsafe links cannot remove other bibliography or prose rows', () => {
  const existing = paper('record-one-v0', 'record-one', 0), second = secondPaper();
  const missingIdentity = { ...second, privateResearch: undefined };
  const wrongIdentity = { ...second, privateResearch: { ...second.privateResearch!, readerVersion: 'invalid' } };
  const unsafeSource = { ...second, sources: [{ ...second.sources[0]!, url: 'javascript:alert(1)' }] };
  const outsideEvidence = { ...second, privateResearch: { ...second.privateResearch!, product: { ...second.privateResearch!.product,
    evidence: { ...second.privateResearch!.product.evidence, quote: 'VARIPULSE evidence from another source' } } } };
  for (const invalid of [missingIdentity, wrongIdentity, unsafeSource, outsideEvidence]) {
    const payload = { private: true, papers: [invalid, second], readings: [...savedReading(existing).readings, ...savedReading(second).readings] };
    const merged = mergeSavedChineseReadings([existing], payload, projectPaper);
    assert.equal(merged.length, 2);
    assert.ok(merged.every(paper => paper.chineseReading));
  }
});

test('one unsafe or mismatched reading is omitted while another saved reading stays readable', () => {
  const existing = paper('record-one-v0', 'record-one', 0), second = secondPaper();
  const changed = savedReading(second).readings[0]!;
  for (const invalid of [
    { ...changed, originalTitle: 'Another article' },
    { ...changed, humanApprovalGranted: true },
    { ...changed, html: '<script>alert(1)</script>' },
    { ...changed, markdown: 'Absent evidence [FT999]' },
  ]) {
    const merged = mergeSavedChineseReadings([existing], { private: true, papers: [second], readings: [invalid, ...savedReading(existing).readings] }, projectPaper);
    assert.ok(merged[0]!.chineseReading);
    assert.equal(merged[1]!.chineseReading, undefined);
  }
});

test('supplemental bibliography and prose strip extra diagnostic fields and cannot reassign an existing reader id', () => {
  const existing = paper('record-one-v0', 'record-one', 0), second = secondPaper();
  const marker = 'SYNTHETIC_DIAGNOSTICS_MUST_NOT_REACH_READERS';
  const supplemental = { ...second, rawResponse: marker, privateResearch: { ...second.privateResearch!, rawModel: marker },
    sources: second.sources.map(source => ({ ...source, secret: marker })) };
  const reading = { ...savedReading(second).readings[0]!, debugResponse: marker };
  const merged = mergeSavedChineseReadings([existing], { private: true, papers: [supplemental], readings: [reading] }, projectPaper);
  assert.ok(!JSON.stringify(merged).includes(marker));
  const reassigned = { ...existing, privateResearch: { ...existing.privateResearch!, recordId: 'other-record' } };
  const unchanged = mergeSavedChineseReadings([existing], { ...savedReading(existing), papers: [reassigned] }, projectPaper);
  assert.equal(unchanged[0]!.privateResearch!.recordId, 'record-one');
  assert.ok(unchanged[0]!.chineseReading);
});

test('saved prose requires an explicitly private envelope and bounded supplemental bibliography', () => {
  const existing = paper('record-one-v0', 'record-one', 0);
  for (const payload of [{ private: false, readings: [] }, { readings: [] }, { private: true, readings: [], papers: {} },
    { private: true, readings: [], papers: Array(101).fill(existing) }]) {
    assert.throws(() => mergeSavedChineseReadings([existing], payload, projectPaper));
  }
});

test('the HTTP saved-prose reader reuses the whitelist callback and accepts the old readings-only response', async context => {
  const existing = paper('record-one-v0', 'record-one', 0), second = secondPaper();
  const configured = process.env.EP_CHINESE_READING_API;
  process.env.EP_CHINESE_READING_API = 'http://127.0.0.1:3202/api/research-preview/chinese-readings';
  context.after(() => {
    if (configured === undefined) delete process.env.EP_CHINESE_READING_API;
    else process.env.EP_CHINESE_READING_API = configured;
  });
  let payload: unknown = { ...savedReading(second), papers: [second] }, calls = 0;
  context.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    calls++;
    assert.equal(url.href, process.env.EP_CHINESE_READING_API);
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  });
  const signal = new AbortController().signal;
  const merged = await savedChineseReadings([existing], signal, projectPaper);
  assert.equal(merged[1]!.id, second.id);
  assert.ok(merged[1]!.chineseReading);
  payload = savedReading(existing);
  assert.ok((await savedChineseReadings([existing], signal))[0]!.chineseReading);
  process.env.EP_CHINESE_READING_API = 'https://external.invalid/api/research-preview/chinese-readings';
  await assert.rejects(savedChineseReadings([existing], signal, projectPaper), /private local/);
  assert.equal(calls, 2);
});
