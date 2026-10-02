import { apiGet } from "../../lib/api.server";
import type { ResearchExperience } from "./contracts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preview object");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid preview text");
  return value;
}
function list(value: unknown, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid preview list");
  return value;
}
function https(value: unknown): string {
  const url = new URL(text(value, 3000));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid source URL");
  return url.href;
}

/** Explicitly projects reader fields; unexpected private/debug properties never enter SSR data. */
function readerProjection(value: unknown): ResearchExperience {
  const raw = object(value);
  if (raw.preview !== true) throw new Error("Expected preview material");
  const papers = list(raw.papers).map(value => {
    const paper = object(value);
    const topic = text(paper.topic);
    if (!new Set(["pfa", "rf", "basic"]).has(topic)) throw new Error("Invalid preview topic");
    if (paper.year !== null && (typeof paper.year !== "number" || !Number.isInteger(paper.year))) throw new Error("Invalid publication year");
    const id = text(paper.id, 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid paper identifier");
    return {
      id, title: text(paper.title, 3000), journal: paper.journal === null ? null : text(paper.journal),
      year: paper.year as number | null, authors: list(paper.authors).map(value => text(value, 300)),
      doi: paper.doi === null ? null : text(paper.doi), pmid: paper.pmid === null ? null : text(paper.pmid, 50),
      topic: topic as "pfa" | "rf" | "basic",
      sources: list(paper.sources, 10).map(value => {
        const source = object(value);
        const acquiredAt = text(source.acquiredAt, 50);
        if (!Number.isFinite(Date.parse(acquiredAt))) throw new Error("Invalid source timestamp");
        return { name: text(source.name, 100), url: https(source.url), acquiredAt };
      }),
    };
  });
  if (new Set(papers.map(paper => paper.id)).size !== papers.length) throw new Error("Duplicate preview paper");
  let example: ResearchExperience["example"] = null;
  if (raw.example !== null) {
    const material = object(raw.example);
    if (material.synthetic !== true) throw new Error("Reader examples must be synthetic");
    const sources = list(material.sources, 50).map(value => {
      const source = object(value);
      return { id: text(source.id, 100), label: text(source.label, 300), text: text(source.text, 20000) };
    });
    const sourceMap = new Map(sources.map(source => [source.id, source]));
    if (sourceMap.size !== sources.length) throw new Error("Duplicate source fragment");
    const groups = list(material.groups, 20).map(value => {
      const group = object(value);
      const fields = list(group.fields, 50).map(value => {
        const field = object(value);
        const sourceIds = list(field.sourceIds, 10).map(value => text(value, 100));
        if (sourceIds.some(id => !sourceMap.has(id))) throw new Error("Missing source fragment");
        if (field.value !== null && sourceIds.length === 0) throw new Error("A reported field needs a source");
        const quote = field.sourceQuote === null || field.sourceQuote === undefined ? null : text(field.sourceQuote, 2000);
        if (quote && !sourceMap.get(sourceIds[0] || "")?.text.includes(quote)) throw new Error("Quote does not match the source");
        return { key: text(field.key, 100), label: text(field.label, 300), value: field.value === null ? null : text(field.value, 3000), sourceIds, sourceQuote: quote };
      });
      if (!fields.length || new Set(fields.map(field => field.key)).size !== fields.length) throw new Error("Invalid reading fields");
      return { id: text(group.id, 100), label: text(group.label, 300), fields };
    });
    if (!groups.length || new Set(groups.map(group => group.id)).size !== groups.length) throw new Error("Invalid reading groups");
    example = { synthetic: true, groups, sources };
  }
  return { preview: true, papers, example };
}

/** Preview data comes from an explicit, loopback-only HTTP adapter, never the private tables. */
export async function loadResearchExperience(signal: AbortSignal): Promise<ResearchExperience> {
  if (process.env.EP_RESEARCH_PREVIEW_ENABLED !== "true") {
    return { preview: false, papers: [], example: null };
  }
  const base = new URL(process.env.API_BASE_URL || "http://127.0.0.1:3001");
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(base.hostname)) {
    return { preview: true, papers: [], example: null, unavailable: true };
  }
  try {
    return readerProjection(await apiGet<unknown>("/api/research-preview/experience", { signal }));
  } catch (error) {
    if (signal.aborted) throw error;
    return { preview: true, papers: [], example: null, unavailable: true };
  }
}
