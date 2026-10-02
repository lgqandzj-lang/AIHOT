import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proseHtml, reviewedReadingText, saveChineseReading } from '../packages/backend/src/research/chinese-reading.ts';
import type { ReadingSourceReview, SavedChineseReading, FulltextSnapshot } from '../packages/backend/src/research/chinese-reading.ts';
import type { Database, Session, Statement } from '../packages/backend/src/research/contracts.ts';
import { sha256, stableJson } from '../packages/backend/src/lib/ids.ts';

const originalTitle = 'Synthetic study of two workflows';
const originalLead = '这是一项合成研究，摘要报告了两种流程。';
const originalMarkdown = '## 研究问题\n【研究事实】摘要报告两种流程。[AB1]\n\n## 阅读分析\n【阅读分析】全文说明比较的限制。[FT1]';
const sources: SavedChineseReading['sources'] = [
  { id: 'AB1', scope: 'abstract', label: 'Synthetic abstract', text: 'Two workflows were reported.', sourceUrl: 'https://example.test/abstract', hash: sha256('Two workflows were reported.') },
  { id: 'FT1', scope: 'fulltext', label: 'Synthetic full text', text: 'The comparison has limitations.', sourceUrl: 'https://example.test/fulltext', hash: sha256('The comparison has limitations.') },
];
const draft: SavedChineseReading = {
  status: 'private_model_draft', readerId: 'synthetic-reader', recordId: 'synthetic-record', pmid: 'synthetic-pmid', doi: '10.9999/synthetic',
  originalTitle, titleZh: '两种流程的合成研究', leadZh: originalLead, markdown: originalMarkdown, html: proseHtml(originalMarkdown), materialScope: 'fulltext',
  generatedAt: '2026-01-01T00:00:00.000Z', model: 'synthetic-model', receiptId: 1, promptVersion: 'synthetic-v1', requestHash: 'r'.repeat(64),
  fulltextHash: 'f'.repeat(64), inputHash: 'i'.repeat(64), humanApprovalGranted: false, publicApprovalGranted: false,
  semanticStatus: 'not_evaluated', sources,
  license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', copyright: 'Synthetic authors', changesNotice: 'Synthetic fixture' },
};
const originalOutputHash = sha256(stableJson({ titleZh: draft.titleZh, leadZh: draft.leadZh, markdown: draft.markdown }));
const review: ReadingSourceReview = {
  method: 'assistant_source_comparison', reviewedAt: '2026-01-02T00:00:00.000Z', humanApprovalGranted: false, originalOutputHash,
  changes: [{ field: 'leadZh', before: '摘要报告了两种流程', after: '摘要描述了两种流程', occurrences: 1,
    reason: 'Use source-supported wording', sourceIds: ['AB1'] }],
};

test('source review is bound to the original output hash and leaves the model draft intact', () => {
  const before = structuredClone(draft);
  const displayed = reviewedReadingText(draft, review);
  assert.equal(displayed.leadZh, '这是一项合成研究，摘要描述了两种流程。');
  assert.equal(displayed.markdown, originalMarkdown);
  assert.deepEqual(displayed.correctionNotes, ['Use source-supported wording（AB1）']);
  assert.deepEqual(draft, before);
  assert.equal(sha256(stableJson({ titleZh: draft.titleZh, leadZh: draft.leadZh, markdown: draft.markdown })), originalOutputHash);
  assert.throws(() => reviewedReadingText({ ...draft, markdown: draft.markdown + ' 新内容' }, review), /bound to the original model output/);
  assert.throws(() => reviewedReadingText(draft, { ...review, originalOutputHash: '0'.repeat(64) }), /bound to the original model output/);
});

test('source corrections reject a sentence not in the draft and an unknown source ID', () => {
  assert.throws(() => reviewedReadingText(draft, { ...review, changes: [{ ...review.changes[0]!, before: '原稿中不存在的句子' }] }), /does not match the unchanged model text/);
  assert.throws(() => reviewedReadingText(draft, { ...review, changes: [{ ...review.changes[0]!, sourceIds: ['FT999'] }] }), /has no original evidence/);
});

test('prose HTML removes active and external links while keeping AB and FT evidence anchors', () => {
  const html = proseHtml('来源 [AB1] 和 [FT1]。 [外站](https://evil.example/x) [脚本](javascript:alert(1)) [协议相对](//evil.example/x)\n\n<script>alert("x")</script><img src="https://evil.example/p.png" onerror="alert(1)">');
  assert.match(html, /<a href="#reading-evidence-AB1">AB1<\/a>/);
  assert.match(html, /<a href="#reading-evidence-FT1">FT1<\/a>/);
  assert.doesNotMatch(html, /href="(?:https?:|javascript:|\/\/)/i);
  assert.doesNotMatch(html, /<(?:script|img)\b|\bonerror\s*=|\bonclick\s*=/i);
  assert.doesNotMatch(html, /evil\.example|javascript:/i);
});

test('saving the same request never replaces an existing output or its separate source review', async () => {
  const fulltext: FulltextSnapshot = {pmid:draft.pmid,doi:draft.doi,sourceUrl:'https://example.test/fulltext',acquiredAt:draft.generatedAt,
    bodyHash:draft.fulltextHash,license:'CC BY 4.0',licenseUrl:draft.license.url,copyright:draft.license.copyright,processingBasis:'Synthetic fixture',fragments:sources.filter(source=>source.scope==='fulltext')};
  const stored = {doi:draft.doi,private_data:{chineseReading:structuredClone(draft),chineseReadingFulltext:fulltext,chineseReadingSourceReview:review}};
  let writes = 0;
  const session: Session = {async query<Row extends Record<string,unknown>>(statement: Statement) {
    if (statement.text.startsWith('SELECT')) return [stored] as unknown as Row[];
    writes++; return [];
  }};
  const db: Database = {...session,transaction:work=>work(session)};
  await saveChineseReading(db,structuredClone(draft),structuredClone(fulltext));
  assert.equal(writes,0);
  await assert.rejects(()=>saveChineseReading(db,{...draft,markdown:draft.markdown+' Changed output'},fulltext),/do not overwrite model history/);
  await assert.rejects(()=>saveChineseReading(db,draft,{...fulltext,copyright:'Changed notice'}),/do not overwrite model history/);
  assert.equal(writes,0);
  assert.deepEqual(stored.private_data.chineseReading,draft);
  assert.deepEqual(stored.private_data.chineseReadingSourceReview,review);
});
