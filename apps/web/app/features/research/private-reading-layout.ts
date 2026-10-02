import type { PrivateReadingView } from './contracts';

type Result = PrivateReadingView['results'][number];
export interface ReadingResultRow { key: string; metric: string; results: Result[]; paired: boolean }

/** Exact saved metric, units, statistic and windows with declared owners; never pair by values or array position. */
export function readingResultRows(view: PrivateReadingView): ReadingResultRow[] {
  const rows: ReadingResultRow[] = [], consumed = new Set<string>();
  const groupIds = view.groups.map(group => group.id);
  const identity = (result: Result) => result.metric.value !== null && result.unit.value !== null
    ? JSON.stringify([result.kind, result.metric.value, result.unit.value, result.statistic.value, result.windows.map(window => window.value).sort()]) : null;
  for (const result of view.results) {
    if (consumed.has(result.id)) continue;
    const key = identity(result);
    const candidates = groupIds.length > 1 && key !== null && groupIds.includes(result.groupId)
      ? view.results.filter(other => groupIds.includes(other.groupId) && identity(other) === key) : [];
    const paired = candidates.length > 1 && candidates.length === new Set(candidates.map(other => other.groupId)).size;
    const ordered = paired ? groupIds.flatMap(id => candidates.filter(result => result.groupId === id)) : [result];
    ordered.forEach(result => consumed.add(result.id));
    rows.push({ key: result.id, metric: typeof result.metric.value === 'string' ? result.metric.value : '指标待核查', results: ordered, paired });
  }
  return rows;
}
