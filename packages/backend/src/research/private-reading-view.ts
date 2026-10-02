import { checkedStructuredReadingParts } from './extraction-format-compat.ts';
import type { ReplayInput } from './extraction-replay.ts';
import type { ExtractionCompletion } from './extraction-validation.ts';

export interface ReadingValue { value: string | number | null; absence: 'unknown' | 'not_reported' | 'not_applicable' | null }
export interface ReadingEvidence { label: string; quote: string }
export interface ReadingCount { key: string; quantity: ReadingValue; unit: ReadingValue; populationScope: ReadingValue; evidence: ReadingEvidence[] }
export interface PrivateReadingView {
  overallCounts: ReadingCount[];
  groups: { id: string; label: string; subjects: string | null; counts: ReadingCount[];
    methods: { key: string; label: string; value: string; evidence: ReadingEvidence[] }[];
    contexts: { key: string; value: string; evidence: ReadingEvidence[] }[]; evidence: ReadingEvidence[] }[];
  results: { id: string; groupId: string; kind: 'duration' | 'outcome'; metric: ReadingValue; resultValue: ReadingValue;
    unit: ReadingValue; statistic: ReadingValue; numerator: ReadingValue; outcomeDenominator: ReadingValue; countUnit: ReadingValue;
    windows: { key: string; value: string; evidence: ReadingEvidence[] }[]; evidence: ReadingEvidence[] }[];
  comparisons: { key: string; resultIds: string[]; description: string; evidence: ReadingEvidence[] }[];
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const field = (value: unknown): ReadingValue => {
  const item = object(value);
  return { value: typeof item.value === 'string' || typeof item.value === 'number' ? item.value : null,
    absence: item.value === null && ['unknown', 'not_reported', 'not_applicable'].includes(String(item.status)) ? item.status as ReadingValue['absence'] : null };
};

/** Read-only organization of the same saved candidate. The frozen checker still gates every displayed path. */
export function structuredPrivateReadingView(raw: unknown, input: ReplayInput, completion: ExtractionCompletion = {}): PrivateReadingView {
  const checked = checkedStructuredReadingParts(raw, input, completion);
  const parts = new Map(checked.parts.map(part => [part.groupId + ':' + part.path, part]));
  const part = (owner: string, path: string) => parts.get(owner + ':' + path);
  const evidence = (owner: string, path: string): ReadingEvidence[] => (part(owner, path)?.citations ?? []).map(id => {
    const fragment = input.fragments.find(fragment => fragment.citation.fragmentId === id)!;
    return { label: fragment.sectionLabel ?? '已提供摘要', quote: fragment.text };
  });
  const counts = (owner: string, path: string, nodes: unknown): ReadingCount[] => list(nodes).flatMap((node, index) => {
    const key = `${path}[${index}]`, count = object(node);
    return part(owner, key) ? [{ key: owner + ':' + key, quantity: field(count.quantity), unit: field(count.unit),
      populationScope: field(count.denominator), evidence: evidence(owner, key) }] : [];
  });
  const root = object(raw);
  const groups: PrivateReadingView['groups'] = list(root.groups).flatMap((node, index) => {
    const group = object(node), id = String(group.groupId), path = `groups[${index}]`, label = part(id, path + '.groupLabel');
    if (!label) return [];
    const subjects = part(id, path + '.researchSubjects') ? field(group.researchSubjects).value : null;
    const methods = ['productRoles', 'imagingMethods', 'radiationStrategy'].flatMap(key => {
      const item = part(id, path + '.' + key);
      const value = group[key];
      return item && (Array.isArray(value) || field(value).value !== null) ? [{ key: id + ':' + path + '.' + key,
        label: item.label, value: item.modelValue, evidence: evidence(id, path + '.' + key) }] : [];
    });
    return [{ id, label: label.modelValue, subjects: typeof subjects === 'string' ? subjects : null,
      counts: counts(id, path + '.sample', group.sample), methods, contexts: [], evidence: evidence(id, path + '.groupLabel') }];
  });
  list(root.proceduralContexts).forEach((node, index) => {
    const path = `proceduralContexts[${index}]`;
    const checkedPart = checked.parts.find(item => item.path === path);
    const group = groups.find(group => group.id === checkedPart?.groupId);
    if (group && checkedPart) group.contexts.push({ key: group.id + ':' + path, value: checkedPart.modelValue, evidence: evidence(group.id, path) });
  });
  const results: PrivateReadingView['results'] = list(root.results).flatMap((node, index) => {
    const path = `results[${index}]`, item = object(node), checkedPart = checked.parts.find(part => part.path === path);
    if (!checkedPart) return [];
    return [{ id: String(item.resultId), groupId: checkedPart.groupId, kind: item.kind as 'duration' | 'outcome',
      metric: field(item.metric), resultValue: field(item.resultValue), unit: field(item.unit), statistic: field(item.statistic),
      numerator: field(item.numerator), outcomeDenominator: field(item.outcomeDenominator), countUnit: field(item.countUnit),
      windows: [], evidence: [...new Map([...evidence(checkedPart.groupId, path), ...evidence(checkedPart.groupId, path + '.counts')]
        .map(entry => [entry.label + '\n' + entry.quote, entry])).values()] }];
  });
  list(root.observationTimes).forEach((node, index) => {
    const item = object(node), path = `observationTimes[${index}]`, result = results.find(result => result.id === item.resultId);
    const checkedPart = result && part(result.groupId, path);
    if (result && checkedPart) result.windows.push({ key: result.groupId + ':' + path, value: checkedPart.modelValue, evidence: evidence(result.groupId, path) });
  });
  const comparisons: PrivateReadingView['comparisons'] = list(root.comparisons).flatMap((node, index) => {
    const item = object(node), path = `comparisons[${index}]`, checkedPart = part('comparison', path);
    return checkedPart ? [{ key: 'comparison:' + path, resultIds: list(object(item.resultIds).value).map(String),
      description: checkedPart.modelValue, evidence: evidence('comparison', path) }] : [];
  });
  return { overallCounts: counts('overall', 'overallSample', root.overallSample), groups, results, comparisons };
}
