import { Link } from 'react-router';
import { ArrowRightIcon, ArrowUpRightIcon } from '@phosphor-icons/react';
import type { PrivateNewsFeed, PrivateNewsItem, ResearchPaper } from './contracts';
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

export function ResearchHome({ papers, news, newsUnavailable }: {
  papers: ResearchPaper[];
  news?: PrivateNewsFeed;
  newsUnavailable?: boolean;
}) {
  const feature = papers.find(paper => (paper as HomePaper).chineseReading) as HomePaper | undefined;
  const reading = feature?.chineseReading;
  const bibliography = papers[0];
  const recent = (news?.items || []).filter(item => !item.historical).sort(byPublishedDate).slice(0, 3);
  const history = (news?.items || []).filter(item => item.historical).sort(byPublishedDate).slice(0, 3);

  return <div className="ep-research-home ep-container">
    <section className="ep-home-hero" aria-labelledby="ep-home-title">
      <div className="ep-home-hero-main">
        <p className="ep-home-eyebrow">电生理研究 · 从进展走向依据</p>
        <h1 id="ep-home-title">看懂电生理新进展，找到产品研究依据。</h1>
        <p className="ep-home-intro">先读研究讲了什么，再沿着原文与产品关联证据继续核对。</p>
        <nav className="ep-home-actions" aria-label="开始阅读">
          <Link className="ep-home-action is-primary" to={NEWS_URL}>看最新进展<ArrowRightIcon size={18} /></Link>
          <Link className="ep-home-action is-secondary" to={PRODUCT_URL}>查产品研究<ArrowRightIcon size={18} /></Link>
        </nav>
      </div>
      <aside className="ep-home-pilot" aria-label="当前试点范围">
        <span>当前试点</span>
        <strong>VARIPULSE</strong>
        <p>围绕已保存的研究与来源资料，先核对产品关联，再阅读具体研究。候选资料会明确标出归属尚待确认。</p>
      </aside>
    </section>

    <section className="ep-home-feature" aria-labelledby="ep-home-feature-title">
      <div className="ep-home-section-top"><span>研究解读</span><p>一篇研究，一个可回到原文的阅读入口</p></div>
      {reading && feature ? <article className="ep-home-feature-body">
        <div className="ep-home-feature-label"><span>已保存中文解读</span><time dateTime={reading.generatedAt}>整理于 {date(reading.generatedAt)}</time></div>
        <div className="ep-home-feature-copy"><h2 id="ep-home-feature-title"><Link to={`/research/read/${feature.id}`}>{reading.titleZh}</Link></h2>
          <p>{reading.leadZh}</p><span className="ep-home-draft-note">私有模型草稿 · 阅读时请核对来源与原文</span>
          <Link className="ep-home-read-link" to={`/research/read/${feature.id}`}>阅读这篇研究<ArrowRightIcon size={18} /></Link></div>
      </article> : <div className="ep-home-feature-pending">
        <h2 id="ep-home-feature-title">中文研究解读待生成</h2>
        <p>当前没有已保存的完整中文解读。可以先查看已有书目信息，沿原始来源阅读。</p>
        {bibliography && <Link className="ep-home-read-link" to={`/research/read/${bibliography.id}`}>查看已收录研究<ArrowRightIcon size={18} /></Link>}
      </div>}
    </section>

    <section className="ep-home-news-section" aria-labelledby="ep-home-recent-title">
      <div className="ep-home-list-heading"><div><span>持续更新</span><h2 id="ep-home-recent-title">近期进展</h2></div><Link to={NEWS_URL}>查看全部进展<ArrowRightIcon size={17} /></Link></div>
      {newsUnavailable ? <p className="ep-home-empty" role="status">近期内容暂时无法读取，请稍后再看。</p>
        : recent.length ? <div className="ep-home-news-list">{recent.map(item => <NewsItem key={item.id} item={item} />)}</div>
        : <p className="ep-home-empty">近期暂无已保存的新进展。历史补录在下方单独展示。</p>}
    </section>

    <section className="ep-home-news-section ep-home-history" aria-labelledby="ep-home-history-title">
      <div className="ep-home-list-heading"><div><span>按原发表日期阅读</span><h2 id="ep-home-history-title">历史补录</h2></div><Link to={`${NEWS_URL}?period=history`}>查看全部历史资料<ArrowRightIcon size={17} /></Link></div>
      {newsUnavailable ? <p className="ep-home-empty" role="status">历史资料暂时无法读取。</p>
        : history.length ? <div className="ep-home-news-list">{history.map(item => <NewsItem key={item.id} item={item} />)}</div>
        : <p className="ep-home-empty">暂无已保存的历史补录资料。</p>}
    </section>

    <div className="ep-home-library-link">需要按标题、作者、DOI 或 PMID 查找？<Link to="/research/library">进入文献库<ArrowRightIcon size={16} /></Link></div>
  </div>;
}
