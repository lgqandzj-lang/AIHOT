import type { PrivateReadingJob, PrivateReadingJobs } from './contracts';

const READING_JOBS_URL = 'http://127.0.0.1:3202/api/research-preview/reading-jobs';
const statuses = new Set(['saved', 'ready', 'blocked', 'pending', 'in_flight']);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reading progress object');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid reading progress text');
  return value;
}

/** Only reader-facing state crosses the HTTP boundary; task internals never reach page data. */
export function readingJobsProjection(value: unknown): PrivateReadingJobs {
  const raw = object(value);
  if (raw.private !== true || !Array.isArray(raw.jobs) || raw.jobs.length > 100) throw new Error('Reading progress must be private');
  const jobs = raw.jobs.map(value => {
    const raw = object(value), pmid = text(raw.pmid, 12), status = raw.status;
    if (!/^[1-9]\d*$/.test(pmid) || !statuses.has(String(status))) throw new Error('Invalid reading progress identity or status');
    const doi = raw.doi === null ? null : text(raw.doi, 1000);
    if (doi && !/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error('Invalid reading progress DOI');
    const readerId = raw.readerId === null ? null : text(raw.readerId, 100);
    if (readerId && !/^[A-Za-z0-9_-]+$/.test(readerId)) throw new Error('Invalid reading progress reader');
    const updatedAt = raw.updatedAt === null ? null : text(raw.updatedAt, 50);
    if (updatedAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(updatedAt)
      || !Number.isFinite(Date.parse(updatedAt)))) throw new Error('Invalid reading progress timestamp');
    let reason = raw.reason === null ? null : text(raw.reason, 400);
    if (reason && /[{}]|[A-Za-z]:[\\/]|(?:^|\s)\/(?:Users|home|tmp|opt|etc)\/|\b(?:prompt|hash|token|schema|json|budget|approval|api[_-]?key|bearer)\b|[a-f0-9]{32,}|提示词|令牌|预算|审批|模型调用授权/i.test(reason)) reason = null;
    return { pmid, doi, originalTitle: text(raw.originalTitle, 3000), titleZh: raw.titleZh === null ? null : text(raw.titleZh, 180),
      readerId, status: status as PrivateReadingJob['status'], updatedAt, reason };
  });
  if (new Set(jobs.map(job => job.pmid)).size !== jobs.length) throw new Error('Duplicate reading progress identity');
  return { private: true, jobs };
}

/** Reading progress is an independent, fixed-loopback GET; loading a page starts no work. */
export async function loadReadingJobs(signal: AbortSignal): Promise<PrivateReadingJobs | null> {
  if (process.env.EP_RESEARCH_PREVIEW_ENABLED !== 'true' || process.env.EP_RESEARCH_PRIVATE_DRAFTS_ENABLED !== 'true') return null;
  const response = await fetch(READING_JOBS_URL, { method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    headers: { accept: 'application/json' }, redirect: 'error', cache: 'no-store' });
  if (!response.ok) throw new Error('Reading progress HTTP ' + response.status);
  return readingJobsProjection(await response.json());
}
