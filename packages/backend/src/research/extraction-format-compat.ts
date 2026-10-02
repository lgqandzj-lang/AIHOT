// Explicit offline compatibility for two v4 collection wrappers. Live validation stays strict.
import { z } from 'zod';
import { structuredWireExtractionSchema, extractionRuleIssues } from './extraction-schema.ts';
import { validateStructuredExtraction, extractionTruncation } from './extraction-validation.ts';
import type { ExtractionCompletion } from './extraction-validation.ts';
import { validateReplayInput } from './extraction-replay.ts';
import type { ReplayInput, FormatTransformation } from './extraction-replay.ts';
import { sha256, stableJson } from '../lib/ids.ts';

export const STRUCTURED_FORMAT_COMPAT_VERSION = 'v4-collection-wrapper-v1';
const object = (node: unknown): Record<string, unknown> | null => node && typeof node === 'object' && !Array.isArray(node) ? node as Record<string, unknown> : null;
const wrapper = z.object({ value: z.array(z.unknown()).min(1).max(20), citations: z.array(z.uuid()).min(1).max(20) }).strict();
const groupShape = structuredWireExtractionSchema.shape.groups.element.shape;
const equal = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** No empty arrays, inferred absence, first-item selection, generic coercion or citation synthesis. */
export function normalizeStructuredCollections(raw: unknown, completion: ExtractionCompletion = {}) {
  const candidate = structuredClone(raw), transformations: FormatTransformation[] = [];
  const groups = object(candidate)?.groups;
  if (extractionTruncation(completion).status === 'truncated' || !Array.isArray(groups)) return { candidate, transformations };
  groups.forEach((node, index) => {
    const group = object(node); if (!group) return;
    for (const key of ['productRoles', 'imagingMethods'] as const) {
      const before = group[key], parsed = wrapper.safeParse(before); if (!parsed.success) continue;
      const { value, citations } = parsed.data;
      if (new Set(citations).size !== citations.length) continue;
      let after: unknown, rule: string;
      if (key === 'productRoles') {
        // A single product-role claim makes the list-level citation owner unambiguous.
        if (value.length !== 1) continue;
        after = value.map(item => ({ value: structuredClone(item), citations: structuredClone(citations) }));
        rule = 'single_product_list_citations_to_sole_cited_entry';
      } else {
        // Remove only a redundant outer wrapper whose ordered references match EVERY entry.
        if (!value.every(item => object(item) && equal(object(item)!.citations, citations))) continue;
        after = structuredClone(value); rule = 'remove_redundant_imaging_list_wrapper';
      }
      if (!groupShape[key].safeParse(after).success) continue;
      group[key] = after;
      transformations.push({ path: `groups[${index}].${key}`, rule, before: structuredClone(before), after: structuredClone(after), evidenceAdded: false });
    }
  });
  return { candidate, transformations };
}

export function replayStructuredCollections(raw: unknown, input: ReplayInput, completion: ExtractionCompletion = {}) {
  validateReplayInput(input);
  const original = validateStructuredExtraction(raw, input, completion);
  const normalized = normalizeStructuredCollections(raw, completion);
  const converted = validateStructuredExtraction(normalized.candidate, input, completion);
  return { version: STRUCTURED_FORMAT_COMPAT_VERSION, originalRawHash: sha256(stableJson(raw)),
    candidateHash: sha256(stableJson(normalized.candidate)), ...normalized, original, converted,
    modelOriginalPassed: original.formatStatus === 'valid' && original.citationStatus === 'valid' && !original.contentIssues.length,
    conversionIsModelSuccess: false, semanticApprovalGranted: false, humanApprovalGranted: false, publicApprovalGranted: false };
}

export interface CheckedReadingPart { groupId: string; path: string; label: string; modelValue: string; citations: string[] }
export interface DeferredReadingPart { path: string; reason: string }

/** Independent field checks plus local dependency checks; bad devices/images never invalidate a group identity. */
export function checkedStructuredReadingParts(raw: unknown, input: ReplayInput, completion: ExtractionCompletion = {}) {
  validateReplayInput(input);
  const parts: CheckedReadingPart[] = [], deferred: DeferredReadingPart[] = [];
  const root = object(raw), provided = new Set(input.providedFragmentIds);
  if (!root || extractionTruncation(completion).status === 'truncated') return { parts, deferred: [{ path: '$', reason: '响应缺失或被截断' }] };
  const citationsValid = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.every(citationsValid);
    const item = object(node); if (!item) return true;
    if ('citations' in item && (!Array.isArray(item.citations) || item.citations.some(id => typeof id !== 'string' || !provided.has(id)) || new Set(item.citations).size !== item.citations.length)) return false;
    return Object.entries(item).every(([key, value]) => key === 'citations' || citationsValid(value));
  };
  const check = (schema: z.ZodType, node: unknown, path: string) => {
    if (!schema.safeParse(node).success || !citationsValid(node)) { deferred.push({ path, reason: '字段结构或引用未通过检查' }); return false; }
    return true;
  };
  const ids = (node: unknown): string[] => {
    if (Array.isArray(node)) return [...new Set(node.flatMap(ids))];
    const item = object(node); return item ? [...new Set(Object.entries(item).flatMap(([key, value]) => key === 'citations' ? value as string[] : ids(value)))] : [];
  };
  const value = (node: unknown) => object(node)?.value;
  const display = (node: unknown) => value(node) === null ? object(node)?.status === 'not_reported' ? '摘要未报告（模型标记）' : object(node)?.status === 'not_applicable' ? '不适用（模型标记）' : '未知' : typeof value(node) === 'object' ? JSON.stringify(value(node)) : String(value(node));
  const add = (groupId: string, path: string, label: string, modelValue: string, fields: unknown[]) => parts.push({ groupId, path, label, modelValue, citations: ids(fields) });
  const groups = Array.isArray(root.groups) ? root.groups : [];
  const validGroups = new Map<string, Record<string, unknown>>();
  const idCounts = new Map<string, number>();
  for (const node of groups) { const id = object(node)?.groupId; if (typeof id === 'string') idCounts.set(id, (idCounts.get(id) ?? 0) + 1); }
  const counts = (groupId: string, path: string, node: unknown, schema: z.ZodType) => {
    if (!check(schema, node, path)) return;
    if (!Array.isArray(node)) { add(groupId, path, '样本计数', display(node), [node]); return; }
    node.forEach((count, index) => {
      const item = object(count)!;
      if (value(item.quantity) !== null && (value(item.unit) === null || value(item.denominator) === null)) { deferred.push({ path: `${path}[${index}]`, reason: '数量缺少本计数的单位或人群口径' }); return; }
      add(groupId, `${path}[${index}]`, '样本计数', `${display(item.quantity)} ${display(item.unit)} · ${display(item.denominator)}`, [item.quantity, item.unit, item.denominator]);
    });
  };
  counts('overall', 'overallSample', root.overallSample, structuredWireExtractionSchema.shape.overallSample);
  groups.forEach((node, index) => {
    const group = object(node), path = `groups[${index}]`;
    if (!group || !check(groupShape.groupId, group.groupId, path + '.groupId') || idCounts.get(String(group.groupId)) !== 1
      || !check(groupShape.groupLabel, group.groupLabel, path + '.groupLabel') || groups.length > 1 && value(group.groupLabel) === null) {
      deferred.push({ path, reason: '组别身份或组别引用不完整；相关结果暂缓' }); return;
    }
    const groupId = String(group.groupId); validGroups.set(groupId, group);
    add(groupId, path + '.groupLabel', '研究组别', display(group.groupLabel), [group.groupLabel]);
    if (check(groupShape.researchSubjects, group.researchSubjects, path + '.researchSubjects')) add(groupId, path + '.researchSubjects', '研究对象', display(group.researchSubjects), [group.researchSubjects]);
    counts(groupId, path + '.sample', group.sample, groupShape.sample);
    for (const key of ['productRoles', 'imagingMethods', 'radiationStrategy'] as const) {
      if (!check(groupShape[key], group[key], path + '.' + key)) continue;
      if (key === 'productRoles' && Array.isArray(group[key]) && extractionRuleIssues({ groups: [group] }).some(issue => issue.code === 'technology_is_not_product')) { deferred.push({ path: path + '.' + key, reason: '技术类别不能作为具体产品' }); continue; }
      const list = Array.isArray(group[key]) ? group[key] as unknown[] : [group[key]];
      add(groupId, path + '.' + key, key === 'productRoles' ? '产品与用途' : key === 'imagingMethods' ? '影像或建图方法' : '射线策略',
        list.map(item=>key==='productRoles'&&object(value(item))?`${object(value(item))!.product} · ${object(value(item))!.role}`:display(item)).join('；'), list);
    }
  });
  const owner = (population: unknown): string | null => {
    const item = object(value(population)); return item?.scope === 'overall' ? 'overall' : item?.scope === 'group' && typeof item.groupId === 'string' && validGroups.has(item.groupId) ? item.groupId : null;
  };
  const rootShape = structuredWireExtractionSchema.shape;
  const collectionElement = (schema: typeof rootShape.results) => schema.options[0].element;
  const resultNodes = Array.isArray(root.results) ? root.results : [], resultCounts = new Map<string, number>();
  for (const node of resultNodes) { const id = object(node)?.resultId; if (typeof id === 'string') resultCounts.set(id, (resultCounts.get(id) ?? 0) + 1); }
  const validResults = new Map<string, Record<string, unknown>>();
  resultNodes.forEach((node, index) => {
    const path = `results[${index}]`, item = object(node);
    if (!check(collectionElement(rootShape.results), node, path) || !item) return;
    const groupId = owner(item.population);
    const issues = extractionRuleIssues({ groups: [...validGroups.values()], results: [item] }).filter(issue => issue.path.startsWith('results'));
    if (!groupId || resultCounts.get(String(item.resultId)) !== 1 || issues.length) { deferred.push({ path, reason: '结果身份、人口归属或关联依赖未通过；结果暂缓' }); return; }
    validResults.set(String(item.resultId), item);
    add(groupId, path, item.kind === 'duration' ? '测量时长' : '结局', `${display(item.metric)} · ${display(item.resultValue)} ${display(item.unit)} · 统计标签：${display(item.statistic)}`, [item.population, item.metric, item.resultValue, item.unit, item.statistic]);
    if (value(item.numerator) !== null || value(item.outcomeDenominator) !== null) add(groupId, path + '.counts', '结局计数与本结果分母', `计数 ${display(item.numerator)} · 分母 ${display(item.outcomeDenominator)} · ${display(item.countUnit)}`, [item.numerator, item.outcomeDenominator, item.countUnit]);
  });
  if (!Array.isArray(root.results)) { if (check(rootShape.results, root.results, 'results')) add('overall', 'results', '结果', display(root.results), [root.results]); }
  if (Array.isArray(root.proceduralContexts)) root.proceduralContexts.forEach((node, index) => {
    const path = `proceduralContexts[${index}]`, item = object(node);
    if (!check(rootShape.proceduralContexts.options[0].element, node, path) || !item) return;
    const groupId = owner(item.population);
    if (!groupId) { deferred.push({ path, reason: '流程阶段缺少有效的组别关联' }); return; }
    add(groupId, path, '流程阶段（非随访）', display(item.stage), [item.population, item.stage]);
  });
  if (Array.isArray(root.observationTimes)) root.observationTimes.forEach((node, index) => {
    const path = `observationTimes[${index}]`, item = object(node);
    if (!check(rootShape.observationTimes.options[0].element, node, path) || !item) return;
    const result = validResults.get(String(item.resultId)), time = object(value(item.time));
    if (!result || result.kind !== 'outcome' || !time || Number(time.start) > Number(time.end) || value(result.metric) === null) { deferred.push({ path, reason: '观察窗口的结局依赖不完整或时间用途不符' }); return; }
    add(owner(result.population)!, path, '结局观察窗口', `${time.start}–${time.end} ${time.unit} · ${display(time.anchor)}`, [item.time]);
  }); else if (check(rootShape.observationTimes, root.observationTimes, 'observationTimes')) add('overall', 'observationTimes', '结局观察窗口', display(root.observationTimes), [root.observationTimes]);
  if (Array.isArray(root.comparisons)) root.comparisons.forEach((node, index) => {
    const path = `comparisons[${index}]`, item = object(node);
    if (!check(rootShape.comparisons.options[0].element, node, path) || !item) return;
    const references = value(item.resultIds);
    if (!Array.isArray(references) || new Set(references).size !== references.length || references.some(id => !validResults.has(String(id)))) { deferred.push({ path, reason: '比较依赖的结果尚未通过检查' }); return; }
    add('comparison', path, '明确比较（模型整理）', display(item.description), [item.resultIds, item.description]);
  });
  return { parts, deferred, semanticStatus: 'not_evaluated' as const, humanApprovalGranted: false, publicApprovalGranted: false };
}
