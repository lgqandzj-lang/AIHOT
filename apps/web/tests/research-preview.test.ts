// Real built web server; synthetic loopback API only. Run after the web build.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

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

async function startWeb(enabled: boolean): Promise<string> {
  const web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, WEB_HOST: "127.0.0.1", WEB_PORT: "0", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, EP_RESEARCH_PREVIEW_ENABLED: String(enabled), MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" },
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
