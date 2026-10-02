import { Link, useRevalidator } from 'react-router';
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpRightIcon, BookOpenIcon, ArrowClockwiseIcon } from '@phosphor-icons/react';
import type { PrivateReadingJob, PrivateReadingJobs, ResearchPaper } from './contracts';
import './reading-jobs.css';

export const WORK_PATH = '/research/work';
const states: { key: PrivateReadingJob['status']; label: string; note: string }[] = [
  { key: 'pending', label: '待整理', note: '本篇尚未开始整理。' },
  { key: 'ready', label: '材料已就绪', note: '阅读材料已保存，等待整理。' },
  { key: 'in_flight', label: '整理中', note: '整理任务正在运行。' },
  { key: 'blocked', label: '需补材料', note: '还缺可用的阅读材料。' },
  { key: 'saved', label: '可阅读', note: '中文解读已保存。' },
];

export function ReadingJobsPage({ feed, papers, unavailable }: { feed?: PrivateReadingJobs; papers: ResearchPaper[]; unavailable?: boolean }) {
  const revalidator = useRevalidator(), refreshing = revalidator.state === 'loading';
  const jobs = feed?.jobs || [];
  return <section className="ep-reading-jobs ep-container">
    <div className="ep-reading-jobs-heading"><div><Link to="/research/products/varipulse" className="ep-back-link"><ArrowLeftIcon size={16} />返回产品研究</Link>
      <h1>内容整理进度</h1><p>查看已收录研究的材料准备和中文解读状态。</p></div>
      <button type="button" className="ep-button ep-button-white" onClick={() => revalidator.revalidate()} disabled={refreshing}><ArrowClockwiseIcon size={16} />{refreshing ? '正在刷新' : '刷新进度'}</button></div>
    <p className="ep-reading-jobs-note">本页只读。打开或刷新页面只查看状态，不启动整理任务。</p>
    {unavailable ? <div className="ep-empty" role="status"><BookOpenIcon size={32} weight="light" /><h2>进度暂时无法加载</h2><p>稍后刷新进度，也可返回产品研究阅读已保存的内容。</p></div>
      : !feed ? <div className="ep-empty" role="status"><h2>暂无可读取的进度</h2><p>已保存的整理记录会显示在这里。</p></div>
      : <><dl className="ep-reading-jobs-counts" aria-label="各阶段数量">{states.map(state => <div key={state.key}><dt>{state.label}</dt><dd>{jobs.filter(job => job.status === state.key).length}</dd></div>)}</dl>
        {jobs.length ? <div className="ep-reading-jobs-list">{jobs.map(job => {
          const state = states.find(state => state.key === job.status)!;
          const paper = papers.filter(paper => paper.chineseReading && paper.pmid === job.pmid && paper.doi === job.doi && paper.title === job.originalTitle)
            .sort((left, right) => (right.privateResearch?.readerVersion ?? 0) - (left.privateResearch?.readerVersion ?? 0))[0];
          const readable = job.status === 'saved' && !!paper;
          return <article className="ep-reading-job" key={job.pmid}>
            <div className="ep-reading-job-meta"><span className={`ep-reading-job-status is-${job.status}`}>{state.label}</span>{job.updatedAt && <time dateTime={job.updatedAt}>更新于 {job.updatedAt.slice(0, 10)}</time>}</div>
            <h2 lang={job.titleZh ? 'zh-CN' : 'en'}>{job.titleZh || job.originalTitle}</h2>
            <p className="ep-reading-job-reason">{job.reason || state.note}{job.status === 'saved' && !readable && '阅读入口暂不可用，可先查看原文。'}</p>
            <div className="ep-reading-job-actions">{readable && <Link to={`/research/read/${paper!.id}`} className="ep-quiet-link">阅读中文解读<ArrowRightIcon size={16} /></Link>}
              <a href={`https://pubmed.ncbi.nlm.nih.gov/${job.pmid}/`} target="_blank" rel="noopener noreferrer">PubMed 原文<ArrowUpRightIcon size={15} /></a>
              {job.doi && <a href={`https://doi.org/${encodeURIComponent(job.doi)}`} target="_blank" rel="noopener noreferrer">出版社原文<ArrowUpRightIcon size={15} /></a>}</div>
            {job.titleZh && <details className="ep-reading-job-original"><summary>英文原题</summary><p lang="en">{job.originalTitle}</p></details>}
          </article>;
        })}</div> : <div className="ep-empty"><BookOpenIcon size={32} weight="light" /><h2>暂无整理记录</h2><p>已收录研究进入整理流程后，真实状态会显示在这里。</p></div>}</>}
  </section>;
}
