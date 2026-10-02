import { Link } from 'react-router';
import { ArrowRightIcon, ArrowUpRightIcon } from '@phosphor-icons/react';
import type { CohortStudy, PrivateNewsFeed, PrivateNewsItem, ResearchPaper } from './contracts';
import './research-home.css';

type HomePaper = ResearchPaper & {
  chineseReading?: { titleZh: string; leadZh: string; generatedAt: string };
};

const NEWS_URL = '/research/news';
const PRODUCT_URL = '/research/products/varipulse';
const kinds: Record<PrivateNewsItem['kind'], string> = {
  paper: '论文动态',
  follow_up: '后续研究报告',
  official: '官方产品动态',
};

function date(value: string | null): string | null {
  return value?.slice(0, 10) || null;
}

function byPublishedDate(a: PrivateNewsItem, b: PrivateNewsItem): number {
  return (b.publishedAt || b.discoveredAt).localeCompare(a.publishedAt || a.discoveredAt)
    || b.discoveredAt.localeCompare(a.discoveredAt);
}

function NewsItem({ item }: { item: PrivateNewsItem }) {
  const title = item.titleZh || item.originalTitle;
  const published = date(item.publishedAt);
  const discovered = date(item.discoveredAt);
  const reading = item.researchUrl;

  return <article className="ep-home-news-card" data-news-id={item.id}>
    <div className="ep-home-news-meta">
      <span>{kinds[item.kind]}</span>
      {published ? <time dateTime={item.publishedAt!}>发表 {published}</time> : <span>发表日期待核对</span>}
      <span>收录 {discovered}</span>
    </div>
    <h3>{reading ? <Link to={reading}>{title}</Link> : <a href={item.source.url} target="_blank" rel="noopener noreferrer">{title}</a>}</h3>
    {item.leadZh && <p className="ep-home-news-lead">{item.leadZh}</p>}
    <div className="ep-home-news-foot">
      <span>{item.source.name} · {item.curation === 'model_draft' ? '题名介绍草稿' : '仅题名与书目信息'}</span>
      {reading ? <Link to={reading}>阅读资料<ArrowRightIcon size={16} /></Link>
        : <a href={item.source.url} target="_blank" rel="noopener noreferrer">查看原文<ArrowUpRightIcon size={16} /></a>}
    </div>
  </article>;
}

function leadCount(study: CohortStudy): string {
  const count = study.counts.find(item => item.groupLabel === 'enrolled') || study.counts[0];
  return count ? `${count.quantity} ${count.unit}` : '摘要未写人数';
}

export function ResearchHome({ papers, cohortStudies = [], news, newsUnavailable }: {
  papers: ResearchPaper[];
  cohortStudies?: CohortStudy[];
  news?: PrivateNewsFeed;
  newsUnavailable?: boolean;
}) {
  const feature = papers.find(paper => (paper as HomePaper).chineseReading) as HomePaper | undefined;
  const reading = feature?.chineseReading;
  const recent = (news?.items || []).filter(item => !item.historical).sort(byPublishedDate).slice(0, 3);
  const history = (news?.items || []).filter(item => item.historical).sort(byPublishedDate).slice(0, 3);
  const showNews = !!news || newsUnavailable;

  return <div className="ep-research-home ep-container">
    <section className="ep-home-hero" aria-labelledby="ep-home-title">
      <div className="ep-home-hero-main">
        <p className="ep-home-eyebrow">电生理研究 · 从进展走向依据</p>
        <h1 id="ep-home-title">看懂电生理新进展，找到产品研究依据。</h1>
        <p className="ep-home-intro">题名点名 VARIPULSE 的研究列在下面。摘要写了人数的，打开就能看到原句。</p>
        <nav className="ep-home-actions" aria-label="开始阅读">
          <Link className="ep-home-action is-primary" to={PRODUCT_URL}>看入组人数<ArrowRightIcon size={18} /></Link>
          <Link className="ep-home-action is-secondary" to="/research/library">查文献库<ArrowRightIcon size={18} /></Link>
        </nav>
      </div>
      <aside className="ep-home-pilot" aria-label="当前试点范围">
        <span>当前试点</span>
        <strong>VARIPULSE</strong>
        <p>{cohortStudies.filter(study => study.counts.length > 0).length} 篇摘要写出了入组人数，共 {cohortStudies.length} 篇题名研究。</p>
      </aside>
    </section>

    {reading && feature && <section className="ep-home-feature" aria-labelledby="ep-home-feature-title">
      <div className="ep-home-section-top"><span>研究解读</span><p>一篇研究，一个可回到原文的阅读入口</p></div>
      <article className="ep-home-feature-body">
        <div className="ep-home-feature-label"><span>已保存中文解读</span><time dateTime={reading.generatedAt}>整理于 {date(reading.generatedAt)}</time></div>
        <div className="ep-home-feature-copy"><h2 id="ep-home-feature-title"><Link to={`/research/read/${feature.id}`}>{reading.titleZh}</Link></h2>
          <p>{reading.leadZh}</p><span className="ep-home-draft-note">私有模型草稿 · 阅读时请核对来源与原文</span>
          <Link className="ep-home-read-link" to={`/research/read/${feature.id}`}>阅读这篇研究<ArrowRightIcon size={18} /></Link></div>
      </article>
    </section>}

    {cohortStudies.length > 0 && <section className="ep-home-studies" aria-labelledby="ep-home-studies-title">
      <div className="ep-home-list-heading"><div><span>摘要原句</span><h2 id="ep-home-studies-title">VARIPULSE 研究</h2></div><Link to={PRODUCT_URL}>查看全部人数<ArrowRightIcon size={17} /></Link></div>
      <div className="ep-home-study-list">{cohortStudies.map(study => <article key={study.pmid}>
        <span>{leadCount(study)}</span>
        <div><h3><Link to={`/research/read/cohort-${study.pmid}`}>{study.title.replace(/\.$/, '')}</Link></h3><p>{study.published} · {study.journal}</p></div>
      </article>)}</div>
    </section>}

    {showNews && <section className="ep-home-news-section" aria-labelledby="ep-home-recent-title">
      <div className="ep-home-list-heading"><div><span>持续更新</span><h2 id="ep-home-recent-title">近期进展</h2></div><Link to={NEWS_URL}>查看全部进展<ArrowRightIcon size={17} /></Link></div>
      {newsUnavailable ? <p className="ep-home-empty" role="status">近期内容暂时无法读取，请稍后再看。</p>
        : recent.length ? <div className="ep-home-news-list">{recent.map(item => <NewsItem key={item.id} item={item} />)}</div>
        : <p className="ep-home-empty">近期暂无已保存的新进展。历史补录在下方单独展示。</p>}
    </section>}

    {showNews && <section className="ep-home-news-section ep-home-history" aria-labelledby="ep-home-history-title">
      <div className="ep-home-list-heading"><div><span>按原发表日期阅读</span><h2 id="ep-home-history-title">历史补录</h2></div><Link to={`${NEWS_URL}?period=history`}>查看全部历史资料<ArrowRightIcon size={17} /></Link></div>
      {newsUnavailable ? <p className="ep-home-empty" role="status">历史资料暂时无法读取。</p>
        : history.length ? <div className="ep-home-news-list">{history.map(item => <NewsItem key={item.id} item={item} />)}</div>
        : <p className="ep-home-empty">暂无已保存的历史补录资料。</p>}
    </section>}

    <div className="ep-home-library-link">需要按标题、作者、DOI 或 PMID 查找？<Link to="/research/library">进入文献库<ArrowRightIcon size={16} /></Link></div>
  </div>;
}
