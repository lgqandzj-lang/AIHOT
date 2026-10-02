// Real built web server; synthetic loopback API only. Run after the web build.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertPrivatePreviewConfiguration } from "../private-preview-policy.ts";

const privateMarker = "SYNTHETIC_PRIVATE_DEBUG_MUST_NOT_REACH_SSR";
const fixture = {
  preview: true, privatePayload: privateMarker,
  papers: [{ id: "fixture-paper", title: "Owned synthetic bibliography title", journal: "Synthetic journal", year: 2025, authors: ["Fixture Author"], doi: "10.9999/ui-fixture", pmid: "1", topic: "pfa", privateData: privateMarker,
    sources: [{ name: "Fixture source", url: "https://example.invalid/source", acquiredAt: "2026-09-30T00:00:00.000Z", raw: privateMarker }] }],
  example: { synthetic: true, rawDraft: privateMarker,
    sources: [{ id: "s1", label: "Synthetic fragment", text: "The study enrolled 12 participants.", raw: privateMarker }],
    groups: [{ id: "g1", label: "示例组", privateData: privateMarker, fields: [{ key: "sample", label: "研究对象", value: "12 participants", sourceIds: ["s1"], sourceQuote: "12 participants", raw: privateMarker }] }] },
};
let payload: unknown = fixture;
let previewRequests = 0;
const api = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/site/meta") return res.end('{"changelogVersion":null}');
  if (req.url === "/api/research-preview/experience") { previewRequests++; return res.end(JSON.stringify(payload)); }
  res.writeHead(404); res.end('{}');
});
const processes: ChildProcess[] = [];
let disabledOrigin: string;
let previewOrigin: string;
let privateOrigin: string;

async function startWeb(enabled: boolean, privateDrafts = false): Promise<string> {
  const web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, WEB_HOST: "127.0.0.1", WEB_PORT: "0", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, EP_RESEARCH_PREVIEW_ENABLED: String(enabled), EP_RESEARCH_PRIVATE_DRAFTS_ENABLED: String(privateDrafts), TRUST_PROXY: "false", MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(web);
  return await new Promise((resolve, reject) => {
    let logs = "";
    const timeout = setTimeout(() => reject(new Error(`Preview web did not start: ${logs}`)), 15000);
    web.on("exit", () => { clearTimeout(timeout); reject(new Error(`Preview web exited: ${logs}`)); });
    web.stderr!.on("data", chunk => { logs += String(chunk); });
    web.stdout!.on("data", chunk => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
}

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  disabledOrigin = await startWeb(false);
  previewOrigin = await startWeb(true);
  privateOrigin = await startWeb(true, true);
});
beforeEach(() => { payload = structuredClone(fixture); });
after(async () => {
  await Promise.all(processes.map(async web => { if (web.exitCode === null && web.signalCode === null) { web.kill("SIGTERM"); await once(web, "exit"); } }));
  api.closeAllConnections();
  await new Promise<void>(resolve => api.close(() => resolve()));
});

test("default-off reader never requests or serializes local preview material", async () => {
  const before = previewRequests;
  const response = await fetch(`${disabledOrigin}/research`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(previewRequests, before);
  assert.ok(!html.includes(fixture.papers[0].title));
  assert.ok(!html.includes(privateMarker));
});

test("explicit loopback preview projects reader fields and strips private/debug properties", async () => {
  const response = await fetch(`${previewOrigin}/research/library`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /private.*no-store/);
  assert.match(response.headers.get("x-robots-tag") || "", /noindex/);
  assert.ok(html.includes(fixture.papers[0].title));
  assert.ok(!html.includes(privateMarker));
  assert.ok(!html.includes("privatePayload"));
});

test("a missing source rejects the preview without exposing the payload or a stack trace", async () => {
  const invalid = structuredClone(fixture);
  invalid.example.groups[0].fields[0].sourceIds = ["not-provided"];
  payload = invalid;
  const response = await fetch(`${previewOrigin}/research/library`);
  const html = await response.text();
  assert.ok(html.includes("文献暂时无法加载"));
  assert.ok(!html.includes(fixture.papers[0].title));
  assert.ok(!html.includes(privateMarker));
  assert.ok(!html.includes("Missing source fragment"));
});

test("a quote outside its supplied fragment is rejected", async () => {
  const invalid = structuredClone(fixture);
  invalid.example.groups[0].fields[0].sourceQuote = "not present in the fragment";
  payload = invalid;
  const html = await (await fetch(`${previewOrigin}/research/read/example`)).text();
  assert.ok(html.includes("文献暂时无法加载"));
  assert.ok(!html.includes("not present in the fragment"));
  assert.ok(!html.includes(privateMarker));
});

test("an unsafe source link fails closed", async () => {
  const invalid = structuredClone(fixture);
  invalid.papers[0].sources[0].url = "javascript:alert('synthetic')";
  payload = invalid;
  const html = await (await fetch(`${previewOrigin}/research/library`)).text();
  assert.ok(html.includes("文献暂时无法加载"));
  assert.ok(!html.includes("javascript:alert"));
});

test("an unknown research route returns a readable 404", async () => {
  const response = await fetch(`${previewOrigin}/research/read/does-not-exist`);
  assert.equal(response.status, 404);
  assert.ok((await response.text()).includes("这篇文献暂时不可阅读"));
});

function withProductRecords() {
  const named = { ...structuredClone(fixture.papers[0]), title: 'Owned VARIPULSE zero-fluoroscopy bibliography' };
  const entry = (paper: typeof named, status: 'confirmed' | 'candidate', version = 0) => ({
    recordId: paper.id, readerVersion: version, publishedOn: null, studyType: '类型待核对', materialScope: 'metadata', privateDebug: privateMarker,
    product: { id: 'varipulse', status, privateDebug: privateMarker, evidence: { label: 'Owned source title', quote: paper.title, url: paper.sources[0].url, raw: privateMarker } },
    questions: [{ id: 'zero-fluoro', label: '零透视工作流', evidence: { label: 'Owned source title', quote: paper.title, url: paper.sources[0].url } }],
  });
  const candidate = { ...structuredClone(named), id: 'candidate-record', title: 'Owned generic catheter zero-fluoroscopy bibliography' };
  const older = { ...named, privateResearch: entry(named, 'confirmed') };
  const latest = { ...named, id: 'newer-reader', privateResearch: entry(named, 'confirmed', 1) };
  return { ...structuredClone(fixture), papers: [older, latest, { ...candidate, privateResearch: entry(candidate, 'candidate') }] };
}

test('product reader is private-only, with no product data serialized in default-off or bibliography-only preview', async () => {
  payload = withProductRecords();
  for (const origin of [disabledOrigin, previewOrigin]) {
    const response = await fetch(`${origin}/research/products/varipulse`), html = await response.text();
    assert.equal(response.status, 200);assert.ok(html.includes('data-cohort-pmid="41129023"'));assert.ok(!html.includes('privateResearch'));assert.ok(!html.includes('Owned source title'));
  }
  assert.equal((await fetch(`${privateOrigin}/research/products/varipulse`)).status, 200);
});

test('a cohort page shows the abstract sentence without requesting the preview API', async () => {
  const before = previewRequests;
  const response = await fetch(`${disabledOrigin}/research/read/cohort-41129023`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(previewRequests, before);
  assert.ok(html.includes('121 patients'));
  assert.ok(html.includes('A total of 121 consecutive patients'));
  assert.ok((await (await fetch(`${disabledOrigin}/research/library`)).text()).includes('/research/read/cohort-41129023'));
});

test('product list separates candidate records and reuses the latest persisted reader without duplicate research cards', async () => {
  payload = withProductRecords();
  const response = await fetch(`${privateOrigin}/research/products/varipulse`), html = await response.text();
  const visible = html.match(/<main id="ep-main">([\s\S]*?)<\/main>/)![1];
  assert.equal((visible.match(/data-product-membership="confirmed"/g) || []).length, 1);
  assert.equal((visible.match(/data-product-membership="candidate"/g) || []).length, 1);
  assert.ok(visible.includes('/research/read/newer-reader'));assert.ok(!visible.includes('/research/read/fixture-paper'));
  assert.ok(visible.includes('发表时间'));assert.ok(visible.includes('平台收录'));assert.ok(visible.includes('产品归属缺少可核对依据'));
  assert.ok(visible.includes('data-cohort-pmid="41129023"'));assert.ok(visible.includes('121 patients'));assert.ok(visible.includes('这篇摘要没有写出本篇入组人数'));
  assert.ok(!visible.includes('12 名患者'));assert.ok(!html.includes(privateMarker));assert.ok(!visible.includes('recordId'));
  assert.equal(response.headers.get('x-robots-tag'), 'noindex');assert.match(response.headers.get('cache-control') || '', /private.*no-store/);
});

test('product query filters and empty-state reset work on the same source-backed records', async () => {
  payload = withProductRecords();
  const onlyCandidate = await (await fetch(`${privateOrigin}/research/products/varipulse?question=zero-fluoro&status=candidate&scope=metadata&order=title`)).text();
  const visible = onlyCandidate.match(/<main id="ep-main">([\s\S]*?)<\/main>/)![1];
  assert.ok(visible.includes('Owned generic catheter'));assert.ok(!visible.includes('data-product-membership="confirmed"'));
  const empty = await (await fetch(`${privateOrigin}/research/products/varipulse?q=owned-nonmatching-search`)).text();
  assert.ok(empty.includes('没有找到相符的资料'));assert.ok(empty.includes('清除筛选，查看全部'));
  assert.ok(!empty.includes('新研究事件'));
});

test('a generic source cannot be promoted to confirmed and evidence from another record is rejected', async () => {
  for (const kind of ['generic-confirmed', 'foreign-quote']) {
    const candidate = withProductRecords() as any;
    if (kind === 'generic-confirmed') candidate.papers[2].privateResearch.product.status = 'confirmed';
    else candidate.papers[1].privateResearch.questions[0].evidence.quote = candidate.papers[2].title;
    payload = candidate;
    const response = await fetch(`${privateOrigin}/research/products/varipulse`), html = await response.text();
    assert.ok(html.includes('文献暂时无法加载'));assert.ok(!html.includes('Owned source title'));assert.ok(!html.includes(privateMarker));
  }
});

test('a detail return URL retains product filters after reload and refuses external or unrelated destinations', async () => {
  payload = withProductRecords();
  const target = '/research/products/varipulse?question=zero-fluoro&status=confirmed&order=title';
  const html = await (await fetch(`${privateOrigin}/research/read/newer-reader?returnTo=${encodeURIComponent(target)}`)).text();
  assert.ok(html.includes('返回 VARIPULSE 研究'));assert.ok(html.includes('question=zero-fluoro'));
  for (const target of ['https://foreign.example/', '/research/products/varipulse-extra', '/research/saved', 'javascript:alert(1)']) {
    const html = await (await fetch(`${privateOrigin}/research/read/newer-reader?returnTo=${encodeURIComponent(target)}`)).text();
    assert.ok(html.includes('返回首页'));assert.ok(!html.includes('返回 VARIPULSE 研究'));
  }
});

function withCuratedProduct() {
  const candidate = withProductRecords() as any, paper = candidate.papers[2];
  paper.privateResearch.display = { titleZh: '自有合成中文研究标题', leadZh: '只介绍已保存题名中的问题。', curation: 'assistant_curated', basisScope: 'title', basisUrl: paper.sources[0].url, preparedAt: '2026-10-01T00:00:00.000Z', privateDebug: privateMarker };
  const source = { label: 'Owned independent source', quote: 'The owned study uses VARIPULSE.', url: 'https://academic.oup.com/owned-test-article', location: 'Owned Methods', acquiredAt: '2026-09-30T00:00:00.000Z', kind: 'publisher', role: 'article_device', articlePmid: paper.pmid, articleDoi: paper.doi, privateDebug: privateMarker };
  paper.privateResearch.product = { id: 'varipulse', status: 'confirmed', evidence: { label: source.label, quote: source.quote, url: source.url },
    verification: { reviewer: 'assistant_source_check', method: 'article_fulltext', checkedAt: '2026-10-01T00:00:00.000Z', studyId: null, note: 'Owned association only.', sources: [source], privateDebug: privateMarker } };
  return candidate;
}

test('curated Chinese copy and independently checked product evidence are private, attributed, and preserve the original bibliography', async () => {
  payload = withCuratedProduct();
  const response = await fetch(`${privateOrigin}/research/products/varipulse?q=${encodeURIComponent('合成中文')}`), html = await response.text();
  const visible = html.match(/<main id="ep-main">([\s\S]*?)<\/main>/)![1];
  for (const text of ['自有合成中文研究标题', '只介绍已保存题名中的问题', '助手整理', '英文原题', 'Owned generic catheter', 'Owned Methods', '尚无人类审核批准']) assert.ok(visible.includes(text));
  assert.equal((visible.match(/data-product-membership="confirmed"/g) || []).length, 1);assert.ok(!html.includes(privateMarker));
  const reader = await (await fetch(`${privateOrigin}/research/read/candidate-record`)).text();assert.ok(reader.includes('<h1 lang="zh-CN">自有合成中文研究标题</h1>'));assert.ok(reader.includes('Owned generic catheter'));
  for (const origin of [disabledOrigin, previewOrigin]) for (const path of ['/research/products/varipulse', '/research/read/candidate-record', '/research/read/candidate-record.data']) {
    const body = await (await fetch(origin + path)).text();assert.ok(!body.includes('自有合成中文研究标题'));assert.ok(!body.includes('Owned independent source'));assert.ok(!body.includes(privateMarker));
  }
});

test('curation cannot widen metadata scope and independent evidence cannot borrow another article or an incomplete study chain', async () => {
  for (const kind of ['abstract-copy', 'foreign-article', 'foreign-domain', 'future-time', 'missing-chain']) {
    const candidate = withCuratedProduct(), paper = candidate.papers[2], check = paper.privateResearch.product.verification;
    if (kind === 'abstract-copy') paper.privateResearch.display.basisScope = 'abstract';
    else if (kind === 'foreign-article') check.sources[0].articlePmid = '2';
    else if (kind === 'foreign-domain') check.sources[0].url = 'https://foreign.invalid/source';
    else if (kind === 'future-time') check.sources[0].acquiredAt = '2026-10-02T00:00:00.000Z';
    else { check.method = 'study_registration';check.studyId = 'NCT00000001'; }
    payload = candidate;const html = await (await fetch(`${privateOrigin}/research/products/varipulse`)).text();
    assert.ok(html.includes('文献暂时无法加载'));assert.ok(!html.includes('自有合成中文研究标题'));assert.ok(!html.includes(privateMarker));
  }
});

const privateFixture = {
  status: "private_auto_draft", reviewMethod: "assistant_source_comparison", privateDebug: privateMarker,
  groups: [{ id: "g1", label: "分析人群", quantity: 12, unit: "patients", subjects: "Synthetic participants", populationScope: "Synthetic inclusion population",
    evidence: [{ label: "Owned synthetic evidence", quote: "The synthetic study enrolled 12 participants.", privateRaw: privateMarker }] }],
  attribution: { copyright: "Owned synthetic material", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", changesNotice: "Synthetic adaptation.", raw: privateMarker },
};
function withPrivateDraft() {
  return { ...structuredClone(fixture), papers: [{ ...structuredClone(fixture.papers[0]), privateDraft: structuredClone(privateFixture) }] };
}

test("private draft fields stay absent when the separate private mode is off", async () => {
  payload = withPrivateDraft();
  for (const origin of [disabledOrigin, previewOrigin]) {
    const html = await (await fetch(`${origin}/research/read/fixture-paper`)).text();
    assert.ok(!html.includes(privateFixture.groups[0].subjects));
    assert.ok(!html.includes(privateFixture.groups[0].evidence[0].quote));
  }
});

test("local private reader renders scoped counts and optional evidence without raw/debug fields", async () => {
  payload = withPrivateDraft();
  const response = await fetch(`${privateOrigin}/research/read/fixture-paper`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /private.*no-store/);
  assert.ok(html.includes("私有自动整理草稿"));
  assert.match(html.replace(/<!--.*?-->/g, "").replace(/<[^>]*>/g, ''), /12 名患者/);
  assert.ok(html.includes(privateFixture.groups[0].subjects));
  assert.ok(html.includes(privateFixture.groups[0].populationScope));
  assert.ok(html.includes("查看原文依据与核查方式"));
  assert.ok(!html.includes(privateMarker));
  assert.ok(!html.includes("研究内容待核对"));
});

test("invalid count or unsafe attribution rejects a private card without serializing it", async () => {
  for (const kind of ["count", "license"]) {
    const invalid = withPrivateDraft();
    if (kind === "count") invalid.papers[0].privateDraft.groups[0].quantity = -1;
    else invalid.papers[0].privateDraft.attribution.licenseUrl = "javascript:alert('private')";
    payload = invalid;
    const html = await (await fetch(`${privateOrigin}/research/read/fixture-paper`)).text();
    assert.ok(html.includes("文献暂时无法加载"));
    assert.ok(!html.includes(privateFixture.groups[0].subjects));
    assert.ok(!html.includes(privateMarker));
  }
});

test("failed and unreviewed private records keep bibliography without presenting incomplete model results", async () => {
  for (const state of ["invalid_output", "unknown", "unreviewed", "index_only"]) {
    const candidate = withPrivateDraft() as any;
    candidate.papers[0].privateDraft.state = state;
    candidate.papers[0].privateDraft.groups = [];
    candidate.papers[0].privateDraft.reviewMethod = "not_evaluated";
    candidate.papers[0].privateDraft.issues = privateMarker;
    payload = candidate;
    const response = await fetch(`${privateOrigin}/research/read/fixture-paper`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes(fixture.papers[0].title));
    assert.ok(html.includes("当前保留书目信息") || html.includes("当前材料仅保留书目信息"));
    assert.ok(!html.includes(privateFixture.groups[0].subjects));
    assert.ok(!html.includes(privateMarker));
  }
});

test("one reader template renders separate records with different groups, units and unknown counts", async () => {
  const first = withPrivateDraft().papers[0];
  const second = structuredClone(first) as any;
  second.id = "second-owned-record"; second.title = "Another owned synthetic bibliography title";
  second.privateDraft.state = "degraded";
  second.privateDraft.groups = [{ ...structuredClone(privateFixture.groups[0]), id: "g2", label: "动物样本", quantity: 7, unit: "animals", subjects: "Owned animal cohort" },
    { ...structuredClone(privateFixture.groups[0]), id: "g3", label: "口径待核查", quantity: null, unit: null, subjects: "Owned separately scoped population", populationScope: null }];
  payload = { ...structuredClone(fixture), papers: [first, second] };
  const firstHtml = await (await fetch(`${privateOrigin}/research/read/fixture-paper`)).text();
  const secondHtml = await (await fetch(`${privateOrigin}/research/read/second-owned-record`)).text();
  assert.match(firstHtml.replace(/<!--.*?-->/g, "").replace(/<[^>]*>/g, ''), /12 名患者/);
  assert.match(secondHtml.replace(/<!--.*?-->/g, "").replace(/<[^>]*>/g, ''), /7 只动物/);
  assert.ok(secondHtml.includes("数量待核对"));
  assert.ok(secondHtml.includes("尚无人类审核批准"));
  const firstVisible = firstHtml.match(/<main id="ep-main">([\s\S]*?)<\/main>/)?.[1];
  assert.ok(firstVisible);
  assert.ok(!firstVisible.includes("Owned animal cohort"));
  assert.ok(!secondHtml.includes(privateMarker));
});

test("single-fetch reader data keeps the same private record and excludes internal fields", async () => {
  payload = withPrivateDraft();
  const response = await fetch(`${privateOrigin}/research/read/fixture-paper.data`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /private.*no-store/);
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
  assert.ok(body.includes(fixture.papers[0].id));
  assert.ok(body.includes(privateFixture.groups[0].subjects));
  assert.ok(!body.includes(privateMarker));
  assert.equal((await fetch(`${privateOrigin}/research/read/unknown-record.data`)).status, 404);
});

test("v4 sections display original pending values with separate review badges through the same reader", async () => {
  const candidate = withPrivateDraft() as any;
  candidate.papers[0].privateDraft.groups = [];
  candidate.papers[0].privateDraft.state = "degraded";
  candidate.papers[0].privateDraft.sections = [{ id: "overall", label: "总体", privateDebug: privateMarker, fields: [
    { key: "overall:sample", label: "样本计数", modelValue: "12 participants · owned test scope", review: "source_supported", note: "Test-only assistant comparison", evidence: [{ label: "Owned test evidence", quote: "The synthetic study enrolled 12 participants." }], privateDebug: privateMarker },
    { key: "overall:duration", label: "测量时长", modelValue: "17 minutes", review: "pending", note: "Synthetic ownership remains unresolved", evidence: [] },
    { key: "overall:window", label: "结局观察窗口", modelValue: "摘要未报告", review: "not_reported", note: "Test-only source comparison", evidence: [] },
  ] }];
  payload = candidate;
  const response = await fetch(`${privateOrigin}/research/read/fixture-paper?view=check`);
  const html = await response.text();
  assert.equal(response.status, 200);
  for (const text of ["摘要提取草稿", "17 minutes", "待核查", "模型原值", "结构与引用检查不等于内容正确", "原文支持 · AI 对照", "提供摘要未报告 · AI 对照"]) assert.ok(html.includes(text));
  assert.ok(!html.includes(privateMarker));
  assert.ok(!(await (await fetch(`${previewOrigin}/research/read/fixture-paper`)).text()).includes("17 minutes"));
  const before = structuredClone(candidate);
  candidate.papers[0].privateDraft.sections[0].fields[1].review = "human_approved";
  payload = candidate;
  const rejected = await (await fetch(`${privateOrigin}/research/read/fixture-paper`)).text();
  assert.ok(rejected.includes("文献暂时无法加载"));assert.ok(!rejected.includes("17 minutes"));
  payload = before;
});

test("failed model response and detailed errors never enter reader HTML or loader data", async () => {
  const candidate = withPrivateDraft() as any;
  candidate.papers[0].privateDraft.groups = [];
  candidate.papers[0].privateDraft.state = "invalid_output";
  candidate.papers[0].privateDraft.reviewMethod = "not_evaluated";
  candidate.papers[0].privateDraft.diagnostic = { message: "Owned failed-response notice", modelResponse: '{"ownedFailedModelValue":"17 minutes","unsafeText":"<script>alert(1)</script>"}', debug: privateMarker };
  payload = candidate;
  const html = await (await fetch(`${privateOrigin}/research/read/fixture-paper`)).text();
  assert.ok(html.includes("研究内容待核对"));
  assert.ok(!html.includes("查看未通过校验的模型原响应"));assert.ok(!html.includes("17 minutes"));
  assert.ok(!html.includes("<script>alert(1)</script>"));assert.ok(!html.includes(privateMarker));
  assert.ok(!(await (await fetch(`${previewOrigin}/research/read/fixture-paper`)).text()).includes("17 minutes"));
  const data = await (await fetch(`${privateOrigin}/research/read/fixture-paper.data`)).text();
  assert.ok(!data.includes("ownedFailedModelValue"));assert.ok(!data.includes("17 minutes"));
});

const sourceAbstractFixture = { scope: "abstract", fullTextProvided: false, sourceName: "Owned saved abstract", sourceUrl: "https://example.invalid/owned-abstract", acquiredAt: "2026-09-30T00:00:00.000Z",
  fragments: [{ id: "owned-fragment", label: null, text: "This owned abstract describes a synthetic mapping workflow.", raw: privateMarker }], privateDebug: privateMarker };

test("saved abstract remains readable when automatic extraction fails, with source and scope", async () => {
  const candidate = withPrivateDraft() as any;
  Object.assign(candidate.papers[0].privateDraft, { state: "invalid_output", groups: [], reviewMethod: "not_evaluated", sourceAbstract: sourceAbstractFixture,
    diagnostic: { message: privateMarker, modelResponse: privateMarker }, diagnosticUrl: "http://127.0.0.1:3201/api/research-preview/admin/diagnostics/fixture-paper" });
  payload = candidate;
  const response = await fetch(`${privateOrigin}/research/read/fixture-paper`), html = await response.text();
  for (const text of ["原始摘要", sourceAbstractFixture.fragments[0].text, "仅摘要，未提供全文", "Owned saved abstract"]) assert.ok(html.includes(text));
  assert.ok(!html.includes('管理员诊断（需登录）'));
  const check = await (await fetch(`${privateOrigin}/research/read/fixture-paper?view=check`)).text();
  assert.ok(check.includes('管理员诊断（需登录）'));
  assert.ok(!html.includes(privateMarker));assert.match(response.headers.get("cache-control") || "", /private.*no-store/);
  const data = await (await fetch(`${privateOrigin}/research/read/fixture-paper.data`)).text();assert.ok(data.includes(sourceAbstractFixture.fragments[0].text));assert.ok(!data.includes(privateMarker));
  assert.ok(!(await (await fetch(`${previewOrigin}/research/read/fixture-paper`)).text()).includes(sourceAbstractFixture.fragments[0].text));
});

test("source and checked partial draft are separate and cannot imply semantic or human approval", async () => {
  const candidate = withPrivateDraft() as any;
  Object.assign(candidate.papers[0].privateDraft, { state: "degraded", groups: [], reviewMethod: "not_evaluated", sourceAbstract: sourceAbstractFixture,
    readingChecks: { formatConverted: true, deferredCount: 2, semanticStatus: "not_evaluated", privateDebug: privateMarker },
    sections: [{ id: "owned-group", label: "Owned local group", fields: [{ key: "owned-result", label: "Owned measurement", modelValue: "23 minutes", review: "pending", note: "Owned checked field awaits content review", evidence: [] }] }] });
  payload = candidate;
  const html = await (await fetch(`${privateOrigin}/research/read/fixture-paper?view=check`)).text();
  assert.ok(html.indexOf("原始摘要") < html.indexOf("自动整理 · 不完整草稿"));assert.ok(html.includes("23 minutes"));assert.ok(html.includes("另有 2 项暂缓展示"));
  assert.ok(html.includes("尚无人类审核批准"));assert.ok(html.includes("待核查"));assert.ok(!html.includes(privateMarker));
});

function withOrganizedDraft() {
  const candidate = withPrivateDraft() as any;
  const cited = (value: string | number | null) => ({ value, absence: value === null ? 'not_reported' : null });
  const evidence = [{ label: 'Owned source', quote: sourceAbstractFixture.fragments[0].text, privateDebug: privateMarker }];
  const duration = (id: string, groupId: string, amount: number) => ({ id, groupId, kind: 'duration', metric: cited('owned duration'), resultValue: cited(amount), unit: cited('minutes'),
    statistic: cited('median'), numerator: cited(null), outcomeDenominator: cited(null), countUnit: cited(null), windows: [], evidence, privateDebug: privateMarker });
  Object.assign(candidate.papers[0].privateDraft, { state: 'degraded', groups: [], reviewMethod: 'not_evaluated', sourceAbstract: sourceAbstractFixture,
    readingView: { overallCounts: [], groups: ['g1', 'g2'].map(id => ({ id, label: 'Owned ' + id, subjects: null, counts: [], methods: [], contexts: [], evidence })),
      results: [duration('r2', 'g2', 29), duration('r1', 'g1', 11)], comparisons: [], privateDebug: privateMarker },
    sections: [{ id: 'g1', label: '核对用字段', fields: [{ key: 'g1:owned', label: '原字段', modelValue: 'OWNED CHECK FIELD', review: 'pending', note: 'Owned pending field', evidence: [] }] }] });
  return candidate;
}

test('reading is default, every result appears once, and check view retains the saved field list', async () => {
  payload = withOrganizedDraft();
  const html = await (await fetch(`${privateOrigin}/research/read/fixture-paper`)).text();
  assert.ok(html.includes('data-reading-view="reading"'));assert.match(html, /<a[^>]*aria-current="page"[^>]*>阅读版<\/a>/);
  assert.equal((html.match(/data-result-id="r1"/g) || []).length, 1);assert.equal((html.match(/data-result-id="r2"/g) || []).length, 1);
  assert.ok(html.includes('is-paired'));assert.ok(html.includes('此标签由模型保存，尚待核查摘要是否明确支持'));
  assert.ok(!html.includes(privateMarker));
  const visible = html.match(/<main id="ep-main">([\s\S]*?)<\/main>/)![1];
  assert.ok(!visible.includes('OWNED CHECK FIELD'));assert.ok(visible.indexOf('id="ep-source-abstract"') < visible.indexOf('id="ep-groups-heading"'));
  const check = await (await fetch(`${privateOrigin}/research/read/fixture-paper?view=check`)).text();
  assert.ok(check.includes('data-reading-view="check"'));assert.ok(check.includes('OWNED CHECK FIELD'));assert.match(check, /<a[^>]*aria-current="page"[^>]*>核对版<\/a>/);
});

test('reading source evidence and result owners fail closed, without exposing debug payload', async () => {
  for (const kind of ['evidence', 'owner', 'duplicate']) {
    const candidate = withOrganizedDraft();
    if (kind === 'evidence') candidate.papers[0].privateDraft.readingView.results[0].evidence[0].quote = 'Outside the saved abstract';
    else if (kind === 'owner') candidate.papers[0].privateDraft.readingView.results[0].groupId = 'foreign-owner';
    else candidate.papers[0].privateDraft.readingView.results[0].id = candidate.papers[0].privateDraft.readingView.results[1].id;
    payload = candidate;
    const html = await (await fetch(`${privateOrigin}/research/read/fixture-paper`)).text();
    assert.ok(html.includes('文献暂时无法加载'));assert.ok(!html.includes('data-result-id'));assert.ok(!html.includes(privateMarker));
  }
});

test('private read organization remains absent with private mode off for HTML and loader data', async () => {
  payload = withOrganizedDraft();
  for (const path of ['/research/read/fixture-paper', '/research/read/fixture-paper.data']) {
    const body = await (await fetch(previewOrigin + path)).text();assert.ok(!body.includes('owned duration'));assert.ok(!body.includes(privateMarker));
  }
});

test("missing displayable abstract retains metadata and original source links", async () => {
  const candidate = withPrivateDraft() as any;Object.assign(candidate.papers[0].privateDraft, { state: "index_only", groups: [], reviewMethod: "not_evaluated" });payload = candidate;
  const html = await (await fetch(`${privateOrigin}/research/read/fixture-paper`)).text();
  assert.ok(html.includes(fixture.papers[0].title));assert.ok(html.includes("出版社原文"));assert.ok(!html.includes("原始摘要"));assert.ok(!html.includes(sourceAbstractFixture.fragments[0].text));
});

test("full-text scope and external diagnostic URLs cannot enter the private abstract reader", async () => {
  for (const kind of ["scope", "diagnostic"]) {
    const candidate = withPrivateDraft() as any;candidate.papers[0].privateDraft.sourceAbstract = structuredClone(sourceAbstractFixture);
    if (kind === "scope") candidate.papers[0].privateDraft.sourceAbstract.fullTextProvided = true;
    else candidate.papers[0].privateDraft.diagnosticUrl = "https://external.invalid/api/research-preview/admin/diagnostics/fixture-paper";
    payload = candidate;const html = await (await fetch(`${privateOrigin}/research/read/fixture-paper`)).text();assert.ok(html.includes("文献暂时无法加载"));assert.ok(!html.includes(sourceAbstractFixture.fragments[0].text));
  }
});

test("private mode blocks foreign Host, Origin and forwarded requests for HTML, data and API", async () => {
  payload = withPrivateDraft();
  const before = previewRequests;
  for (const path of ["/research/read/fixture-paper", "/research/read/fixture-paper.data", "/api/research-preview/experience"]) {
    const deniedHeaders: Record<string, string>[] = [{ host: "external.invalid" }, { origin: "https://external.invalid" }, { "x-forwarded-for": "203.0.113.17" }, { "x-forwarded-host": "127.0.0.1" }, { forwarded: "for=127.0.0.1" }, { "x-forwarded-proto": "http" }];
    for (const headers of deniedHeaders) {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(privateOrigin + path, { headers }, res => {
          let body = "";
          res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode || 0, body }));
        });
        req.on("error", reject); req.end();
      });
      assert.equal(response.status, 403, `${path} ${Object.keys(headers).join(",")}`);
      assert.ok(!response.body.includes(privateFixture.groups[0].subjects));
    }
  }
  assert.equal(previewRequests, before);
});

test("private mode rejects non-loopback listeners, remote adapters and proxy trust", () => {
  assert.throws(() => assertPrivatePreviewConfiguration("0.0.0.0", new URL("http://127.0.0.1:3201"), false));
  assert.throws(() => assertPrivatePreviewConfiguration("127.0.0.1", new URL("https://external.invalid"), false));
  assert.throws(() => assertPrivatePreviewConfiguration("127.0.0.1", new URL("http://127.0.0.1:3201"), true));
});

function withPrivateNews() {
  const value = structuredClone(fixture) as any;
  value.news = { version: 'ep-private-news-v1', private: true, checkedAt: '2026-10-01T14:00:00.000Z', rawReceipt: privateMarker,
    sources: [
      { id: 'ep-private-pubmed-varipulse', name: 'PubMed', kind: 'research', basisUrl: 'https://pubmed.ncbi.nlm.nih.gov/download/',
        policyUrl: 'https://www.ncbi.nlm.nih.gov/home/about/policies/', checkedAt: '2026-10-01T14:00:00.000Z', status: 'ok', found: 1, created: 1 },
      { id: 'ep-private-jnj-varipulse', name: 'Johnson & Johnson 官方 RSS', kind: 'official', basisUrl: 'https://www.jnj.com/rss',
        policyUrl: 'https://www.jnj.com/terms-of-use', checkedAt: '2026-10-01T14:00:00.000Z', status: 'ok', found: 0, created: 0 },
    ], items: [{ id: 'owned-news-fixture', originalTitle: value.papers[0].title, titleZh: '自有合成资讯标题', leadZh: '题名介绍：仅介绍这个自有题名。',
      kind: 'paper', materialScope: 'title', publishedAt: '2026-09-20T00:00:00.000Z', discoveredAt: '2026-10-01T14:00:00.000Z', historical: true,
      source: { name: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov/1/', acquiredAt: '2026-10-01T14:00:00.000Z', internalError: privateMarker },
      product: { id: 'varipulse', status: 'candidate', quote: value.papers[0].title, url: 'https://pubmed.ncbi.nlm.nih.gov/1/', method: 'search_candidate' },
      researchUrl: '/research/read/fixture-paper', relatedResearch: null, curation: 'model_draft', modelResponse: privateMarker }],
  };
  return value;
}
test('private news is default-off in HTML and data and never leaks through ordinary preview mode', async () => {
  payload = withPrivateNews();
  for (const origin of [disabledOrigin, previewOrigin]) {
    for (const path of ['/research/news?period=history', '/research/news.data?period=history']) {
      const response = await fetch(origin + path), body = await response.text();
      assert.equal(response.status, 404); assert.ok(!body.includes('自有合成资讯标题')); assert.ok(!body.includes(privateMarker));
    }
  }
});
test('saved private news separates source and discovery dates, candidate association and draft copy, without diagnosis fields', async () => {
  payload = withPrivateNews();
  const response = await fetch(privateOrigin + '/research/news?period=history'), html = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control') || '', /private.*no-store/);
  assert.ok(html.includes('自有合成资讯标题')); assert.ok(html.includes('题名介绍：仅介绍这个自有题名。'));
  assert.ok(html.includes('2026-09-20')); assert.ok(html.includes('2026-10-01')); assert.ok(html.includes('历史补录'));
  assert.ok(html.includes('查看 VARIPULSE 关联候选')); assert.ok(html.includes('/research/read/fixture-paper'));
  assert.ok(!html.includes(privateMarker)); assert.ok(!html.includes('rawReceipt')); assert.ok(!html.includes('modelResponse'));
  const current = await (await fetch(privateOrigin + '/research/news')).text();
  assert.ok(current.includes('近期没有新增资讯')); assert.ok(!current.includes('class="ep-news-card"'));
});
test('a malformed news association or wrong study link only closes news and keeps the existing reader intact', async () => {
  for (const change of [
    (value: any) => { value.news.items[0].product.status = 'confirmed'; },
    (value: any) => { value.news.items[0].researchUrl = '/research/read/another-paper'; },
    (value: any) => { value.news.items[0].titleZh = 'VARIPULSE 假品牌资讯'; },
  ]) {
    const candidate = withPrivateNews(); change(candidate); payload = candidate;
    const html = await (await fetch(privateOrigin + '/research/news?period=history')).text();
    assert.ok(html.includes('资讯暂时无法加载')); assert.ok(!html.includes('自有合成资讯标题')); assert.ok(!html.includes(privateMarker));
    const reader = await (await fetch(privateOrigin + '/research/read/fixture-paper')).text();
    assert.ok(reader.includes(fixture.papers[0].title)); assert.ok(!reader.includes('文献暂时无法加载'));
  }
});
test('news HTML and data obey the same private Host, Origin and forwarding boundary', async () => {
  payload = withPrivateNews();
  for (const path of ['/research/news', '/research/news.data']) {
    for (const headers of [{ Host: 'untrusted.invalid' }, { Origin: 'https://untrusted.invalid' }, { 'X-Forwarded-For': '127.0.0.1' }]) {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(privateOrigin + path, { headers }, result => {
          let body = ''; result.setEncoding('utf8'); result.on('data', chunk => { body += chunk; });
          result.on('end', () => resolve({ status: result.statusCode || 0, body }));
        });
        request.on('error', reject); request.end();
      });
      assert.equal(response.status, 403); assert.ok(!response.body.includes('自有合成资讯标题'));
    }
  }
});
