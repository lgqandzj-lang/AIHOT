// Human-attested count rows are the only gold standard. Model output cannot enter this file.

export const GOLD_SET_VERSION = 'ep-gold-set-v1';
export const GOLD_PAPER_TARGET = 20;
const MACHINE_ATTESTOR = /\b(agent|model|assistant|codex|cursor|gpt|chatgpt|claude|deepseek|llm)\b/i;
const PMID = /^[1-9][0-9]{0,11}$/;
const DOI = /^10\.[0-9]{4,9}\/\S+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface GoldCount {
  materialScope: 'abstract' | 'cc-by-4.0-fulltext';
  groupLabel: string;
  quantity: number;
  unit: string;
  populationScope: string;
  locator: string;
  attestor: string;
  attestedOn: string;
}
export interface GoldRecord {
  pmid: string;
  doi: string | null;
  title: string;
  journal: string;
  published: string;
  pubmedUrl: string;
  eligibility: 'study' | 'excluded';
  exclusion: string | null;
  counts: GoldCount[];
}
export interface GoldSetFile {
  version: typeof GOLD_SET_VERSION;
  productId: 'varipulse';
  query: string;
  retrievedOn: string;
  pubmedCount: number;
  records: GoldRecord[];
}
export interface ObservedCount {
  quantity: number;
  unit: string;
  populationScope: string;
}

export function parseGoldSet(value: unknown): GoldSetFile {
  const root = object(value, 'gold');
  if (root.version !== GOLD_SET_VERSION) fail('gold.version', 'unsupported gold set');
  if (root.productId !== 'varipulse') fail('gold.productId', 'this set is for VARIPULSE');
  text(root.query, 'gold.query', 200);
  day(root.retrievedOn, 'gold.retrievedOn');
  if (!Number.isSafeInteger(root.pubmedCount) || Number(root.pubmedCount) < 0) fail('gold.pubmedCount', 'expected a count');
  const records = list(root.records, 'gold.records', 100);
  if (records.length === 0) fail('gold.records', 'expected at least one record');
  const seen = new Set<string>();
  const parsed = records.map((item, index) => parseRecord(item, index, seen));
  if (parsed.filter(record => record.eligibility === 'study').length > Number(root.pubmedCount)) {
    fail('gold.pubmedCount', 'eligible studies cannot exceed the reported PubMed count');
  }
  return {
    version: GOLD_SET_VERSION,
    productId: 'varipulse',
    query: root.query as string,
    retrievedOn: root.retrievedOn as string,
    pubmedCount: root.pubmedCount as number,
    records: parsed,
  };
}

export function goldPhaseStatus(gold: GoldSetFile) {
  const studies = gold.records.filter(record => record.eligibility === 'study');
  const attestedPapers = studies.filter(record => record.counts.length > 0).length;
  const attestedRows = studies.reduce((sum, record) => sum + record.counts.length, 0);
  return {
    eligibleStudies: studies.length,
    attestedPapers,
    attestedRows,
    targetPapers: GOLD_PAPER_TARGET,
    complete: attestedPapers >= GOLD_PAPER_TARGET,
  };
}

export function observedCounts(output: unknown): ObservedCount[] {
  const root = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  const counts: ObservedCount[] = [];
  collectSamples(root.overallSample, counts);
  if (Array.isArray(root.groups)) {
    for (const group of root.groups) {
      if (group && typeof group === 'object') collectSamples((group as Record<string, unknown>).sample, counts);
    }
  }
  return counts;
}

export function scoreGoldCounts(gold: GoldSetFile, observed: ObservedCount[]) {
  const rows = gold.records.filter(record => record.eligibility === 'study').flatMap(record => record.counts);
  const seen = new Set<number>();
  let hits = 0;
  for (const row of rows) {
    const index = observed.findIndex((item, itemIndex) => !seen.has(itemIndex) && sameCount(row, item));
    if (index >= 0) { seen.add(index); hits += 1; }
  }
  return { attestedRows: rows.length, hits, recall: rows.length === 0 ? null : hits / rows.length };
}

function parseRecord(value: unknown, index: number, seen: Set<string>): GoldRecord {
  const path = `records[${index}]`;
  const record = object(value, path);
  const allowed = ['pmid', 'doi', 'title', 'journal', 'published', 'pubmedUrl', 'eligibility', 'exclusion', 'counts'];
  for (const key of Object.keys(record)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field');
  text(record.pmid, `${path}.pmid`, 12);
  if (!PMID.test(record.pmid as string)) fail(`${path}.pmid`, 'invalid PMID');
  if (seen.has(record.pmid as string)) fail(`${path}.pmid`, 'duplicate PMID');
  seen.add(record.pmid as string);
  const doi = record.doi === null ? null : text(record.doi, `${path}.doi`, 200);
  if (typeof doi === 'string' && (doi !== doi.toLowerCase() || !DOI.test(doi))) fail(`${path}.doi`, 'DOI must be lowercase and canonical');
  text(record.title, `${path}.title`, 2000);
  text(record.journal, `${path}.journal`, 400);
  text(record.published, `${path}.published`, 40);
  const expectedUrl = `https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/`;
  if (record.pubmedUrl !== expectedUrl) fail(`${path}.pubmedUrl`, 'URL must be the PubMed record for this PMID');
  if (record.eligibility !== 'study' && record.eligibility !== 'excluded') fail(`${path}.eligibility`, 'unsupported value');
  const counts = list(record.counts, `${path}.counts`, 20).map((item, countIndex) => parseCount(item, `${path}.counts[${countIndex}]`));
  if (record.eligibility === 'excluded') {
    text(record.exclusion, `${path}.exclusion`, 300);
    if (counts.length > 0) fail(`${path}.counts`, 'an excluded record cannot carry gold counts');
  } else if (record.exclusion !== null) fail(`${path}.exclusion`, 'a study has no exclusion reason');
  return {
    pmid: record.pmid as string,
    doi,
    title: record.title as string,
    journal: record.journal as string,
    published: record.published as string,
    pubmedUrl: expectedUrl,
    eligibility: record.eligibility,
    exclusion: record.eligibility === 'excluded' ? record.exclusion as string : null,
    counts,
  };
}

function parseCount(value: unknown, path: string): GoldCount {
  const count = object(value, path);
  const allowed = ['materialScope', 'groupLabel', 'quantity', 'unit', 'populationScope', 'locator', 'attestor', 'attestedOn'];
  for (const key of Object.keys(count)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field');
  if (count.materialScope !== 'abstract' && count.materialScope !== 'cc-by-4.0-fulltext') fail(`${path}.materialScope`, 'material must be an abstract or CC BY 4.0 full text');
  text(count.groupLabel, `${path}.groupLabel`, 200);
  if (!Number.isSafeInteger(count.quantity) || Number(count.quantity) < 0 || Number(count.quantity) > 1_000_000_000) fail(`${path}.quantity`, 'expected a nonnegative integer');
  text(count.unit, `${path}.unit`, 200);
  text(count.populationScope, `${path}.populationScope`, 500);
  text(count.locator, `${path}.locator`, 500);
  if ((count.locator as string).trim().length < 12) fail(`${path}.locator`, 'locator must point at the source phrase');
  text(count.attestor, `${path}.attestor`, 80);
  if (MACHINE_ATTESTOR.test(count.attestor as string)) fail(`${path}.attestor`, 'a model or agent cannot attest gold');
  day(count.attestedOn, `${path}.attestedOn`);
  return {
    materialScope: count.materialScope,
    groupLabel: (count.groupLabel as string).trim(),
    quantity: count.quantity as number,
    unit: (count.unit as string).trim(),
    populationScope: (count.populationScope as string).trim(),
    locator: (count.locator as string).trim(),
    attestor: (count.attestor as string).trim(),
    attestedOn: count.attestedOn as string,
  };
}

function collectSamples(value: unknown, into: ObservedCount[]) {
  if (!Array.isArray(value)) return;
  for (const sample of value) {
    if (!sample || typeof sample !== 'object') continue;
    const row = sample as Record<string, unknown>;
    const quantity = known(row.quantity);
    const unit = known(row.unit);
    const populationScope = known(row.denominator);
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || typeof unit !== 'string' || typeof populationScope !== 'string') continue;
    into.push({ quantity, unit, populationScope });
  }
}

function known(field: unknown): unknown {
  if (!field || typeof field !== 'object' || !('value' in field)) return null;
  const value = (field as { value: unknown }).value;
  return value === null || value === undefined ? null : value;
}

function sameCount(row: GoldCount, observed: ObservedCount): boolean {
  return row.quantity === observed.quantity
    && normalize(row.unit) === normalize(observed.unit)
    && normalize(row.populationScope) === normalize(observed.populationScope);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  return value as Record<string, unknown>;
}
function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `expected an array of at most ${max} items`);
  return value;
}
function text(value: unknown, path: string, max: number): string | null {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) fail(path, 'expected text');
  return value;
}
function day(value: unknown, path: string): void {
  if (typeof value !== 'string' || !DAY.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) fail(path, 'expected YYYY-MM-DD');
}
function fail(path: string, reason: string): never {
  throw new Error(`${path}: ${reason}`);
}
