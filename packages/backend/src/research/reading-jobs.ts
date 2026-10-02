import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const pmid = z.string().regex(/^[1-9]\d{0,9}$/);
const doi = z.string().max(1000).regex(/^10\.\d{4,9}\/\S+$/).refine(value => value === value.toLowerCase(), 'DOI must be canonical');
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const sourceTitle = z.string().min(1).max(3000).refine(value => value === value.trim() && !value.includes('\0'), 'Invalid source title');
const chineseTitle = z.string().min(1).max(180).refine(value => value === value.trim() && /[\u3400-\u9fff]/.test(value) && !value.includes('\0'), 'Invalid Chinese title');
const timestamp = z.iso.datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'Invalid job timestamp');
const reasonSchema = z.enum(['source_unavailable','license_unavailable','identity_conflict','materials_incomplete','execution_uncertain','preparation_failed']);
const statusSchema = z.enum(['pending','ready','blocked','in_flight','saved']);
const directory = z.string().max(500).regex(/^\.data\/ep-chinese-reading\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/)
  .refine(value => !value.split('/').some(part => part === 'work' || part === 'guard'), 'Internal work/guard directories are not reading jobs');
const jobSchema = z.object({
  pmid, doi, originalTitle: sourceTitle, titleZh: chineseTitle.nullable(), readerId: id, recordId: id,
  directory, status: statusSchema, updatedAt: timestamp.nullable(), reason: reasonSchema.nullable(),
}).strict();
const queueSchema = z.object({ version: z.literal('ep-reading-queue-v1'), jobs: z.array(jobSchema).max(100) }).strict()
  .superRefine((queue, context) => {
    for (const key of ['pmid','doi','readerId','recordId','directory'] as const) {
      const seen = new Set<string>();
      queue.jobs.forEach((job, index) => {
        if (seen.has(job[key])) context.addIssue({ code: 'custom', path: ['jobs',index,key], message: 'Duplicate reading job identity' });
        seen.add(job[key]);
      });
    }
  });

export type ReadingJob = z.infer<typeof jobSchema>;
export type ReadingQueue = z.infer<typeof queueSchema>;
export type ReadingJobReason = z.infer<typeof reasonSchema>;
export type ReadingJobStatus = z.infer<typeof statusSchema>;

const reasonCopy: Record<ReadingJobReason,string> = {
  source_unavailable: '暂时无法获取论文材料。',
  license_unavailable: '原文许可不支持本次中文整理。',
  identity_conflict: '论文身份不一致，暂未整理。',
  materials_incomplete: '可用材料不完整，暂未整理。',
  execution_uncertain: '整理结果待核对。',
  preparation_failed: '材料准备未完成，请稍后再试。',
};

/** A display queue, never an authorization or execution contract. */
export function parseReadingQueue(value: unknown): ReadingQueue {
  return queueSchema.parse(value);
}

// The existing reader DTO omits publicApprovalGranted; if supplied, true cannot be treated as a private draft.
const savedReadingSchema = z.object({
  pmid, doi, originalTitle: sourceTitle, titleZh: chineseTitle, readerId: id,
  status: z.literal('private_model_draft'), humanApprovalGranted: z.literal(false),
  publicApprovalGranted: z.literal(false).optional(), materialScope: z.literal('fulltext'), generatedAt: timestamp,
});

/** Fixed keys and fixed reason text prevent directories or internal diagnostics entering reader output. */
export function projectReadingJobs(queue: unknown, savedReadings: readonly unknown[] = []) {
  const parsed = parseReadingQueue(queue);
  const saved = savedReadings.flatMap(value => {
    const result = savedReadingSchema.safeParse(value);
    return result.success ? [result.data] : [];
  });
  return { private: true as const, jobs: parsed.jobs.map(job => {
    const reading = saved.find(reading => reading.pmid === job.pmid && reading.doi === job.doi && reading.originalTitle === job.originalTitle);
    return {
      pmid: job.pmid, doi: job.doi, originalTitle: job.originalTitle,
      titleZh: reading?.titleZh ?? job.titleZh, readerId: reading?.readerId ?? job.readerId,
      status: reading ? 'saved' as const : job.status,
      updatedAt: reading?.generatedAt ?? job.updatedAt,
      reason: reading ? null : job.reason ? reasonCopy[job.reason] : null,
    };
  }) };
}

/** Reads only the queue file; missing queues are empty and invalid queues are reported to the HTTP adapter. */
export async function readReadingJobs(root: string, savedReadings: readonly unknown[] = []) {
  let body: string;
  try { body = await readFile(path.join(path.resolve(root),'.data','ep-chinese-reading','queue.json'),'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return projectReadingJobs({version:'ep-reading-queue-v1',jobs:[]},savedReadings);
    throw error;
  }
  if (Buffer.byteLength(body) > 2_000_000) throw new Error('Reading queue exceeds 2 MB');
  return projectReadingJobs(JSON.parse(body.replace(/^\uFEFF/,'')),savedReadings);
}
