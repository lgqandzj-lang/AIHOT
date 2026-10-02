import { Link, useSearchParams } from 'react-router';
import { ArrowRightIcon, ArrowUpRightIcon, BookOpenIcon } from '@phosphor-icons/react';
import type { PrivateNewsFeed, PrivateNewsItem } from './contracts';
import { PRODUCT_PATH } from './product-research';

export const NEWS_PATH = '/research/news';
const kinds = { paper: '论文动态', follow_up: '后续研究报告', official: '官方产品动态' };
const day = (value: string) => value.slice(0, 10);
export function NewsCard({ item }: { item: PrivateNewsItem }) {
  return <article className="ep-news-card" data-news-id={item.id}>
    <div className="ep-news-meta"><span>{kinds[item.kind]}</span><span>{item.source.name}</span>
      <span>{item.publishedAt ? <>发表 <time dateTime={item.publishedAt}>{day(item.publishedAt)}</time></> : '发表日期未提供'}</span>
      {item.historical && <span>历史补录</span>}</div>
    <h2>{item.titleZh || <span lang="en">{item.originalTitle}</span>}</h2>
    <p className="ep-news-lead">{item.leadZh || '原题已保存，中文资讯草稿尚未生成。'}</p>
    <div className="ep-news-actions">
      {item.researchUrl && <Link to={item.researchUrl} className="ep-text-link">研究详情<ArrowRightIcon size={17} /></Link>}
      <Link to={PRODUCT_PATH} className="ep-text-link">{item.product.status === 'confirmed' ? 'VARIPULSE 产品研究' : '查看 VARIPULSE 关联候选'}<ArrowRightIcon size={17} /></Link>
      <a href={item.source.url} target="_blank" rel="noopener noreferrer" className="ep-text-link">原文<ArrowUpRightIcon size={17} /></a>
    </div>
    <details className="ep-news-evidence"><summary>原题与资料范围</summary><p lang="en">{item.originalTitle}</p>
      <p>仅有题名与书目信息，不包含摘要或全文研究结果。{item.kind === 'official' && '这条资料来自厂商，题名中的说法归于厂商。'}</p>
      <p>{item.product.status === 'confirmed' ? '原题明确点名 VARIPULSE，只确认产品关联。' : '搜索发现的相关候选，原题尚不足以确认品牌归属。'}</p>
      <p>平台发现：<time dateTime={item.discoveredAt}>{day(item.discoveredAt)}</time> · 来源取得：<time dateTime={item.source.acquiredAt}>{day(item.source.acquiredAt)}</time></p>
      {item.relatedResearch && <Link to={'/research/read/' + item.relatedResearch.recordId}>查看该新闻明确引用的研究</Link>}
      <p>{item.curation === 'model_draft' ? '中文标题与一句说明为自动整理草稿，独立于论文提取结果保存，尚待核对。' : '中文整理尚未执行。'}</p>
    </details>
  </article>;
}

export function PrivateNewsPage({ feed }: { feed: PrivateNewsFeed }) {
  const [search, setSearch] = useSearchParams();
  const historical = search.get('period') === 'history';
  const items = feed.items.filter(item => historical ? item.historical : !item.historical);
  const change = (history: boolean) => { const next = new URLSearchParams(search); if (history) next.set('period', 'history'); else next.delete('period'); setSearch(next); };
  return <section className="ep-news-page ep-container">
    <div className="ep-page-heading"><div><span className="ep-demo-label">VARIPULSE 试点</span><h1>最新进展</h1>
      <p>阅读研究更新与官方产品动态，沿着来源进入产品研究和原始资料。</p></div>
      <Link to={PRODUCT_PATH} className="ep-quiet-link">VARIPULSE 产品研究<ArrowRightIcon size={17} /></Link></div>
    <p className="ep-news-scope">本轮只处理题名与书目信息；自动整理草稿尚待核对，不包含研究结果。官方动态中的说法归于厂商。</p>
    <div className="ep-news-tabs ep-topic-tabs" aria-label="资讯时间范围">
      <button className={historical ? '' : 'is-active'} aria-pressed={!historical} onClick={() => change(false)}>近期进展</button>
      <button className={historical ? 'is-active' : ''} aria-pressed={historical} onClick={() => change(true)}>历史补录</button>
    </div>
    <p className="ep-news-count" role="status">{items.length} 条{historical ? '历史资料' : '近期新增资料'}</p>
    {items.length ? <div className="ep-news-list">{items.map(item => <NewsCard key={item.id} item={item} />)}</div>
      : <div className="ep-empty"><BookOpenIcon size={38} weight="light" /><h3>{historical ? '没有历史补录资料。' : '近期没有新增资讯。'}</h3>
        <p>只展示已保存的来源记录，原始发表日期较早的资料单独收在历史补录中。</p>
        {!historical && feed.items.some(item => item.historical) && <button className="ep-button ep-button-white" onClick={() => change(true)}>查看历史资料<ArrowRightIcon size={18} /></button>}</div>}
    <details className="ep-news-source-list"><summary>本轮来源与读取范围</summary>
      {feed.sources.map(source => <div key={source.id}><h3>{source.name}</h3>
        <p>{source.kind === 'research' ? '官方 API · 题名、作者、期刊、日期和文献标识。' : '官方 RSS · 题名、日期和原文链接；未获取正文。'}</p>
        <p>{source.status === 'not_run' ? '尚未运行' : source.status === 'unavailable' ? '本轮暂时无法读取' : source.created ? `本轮新增 ${source.created} 条` : '本轮没有新增保存记录'}{source.checkedAt && ` · 检查日期 ${day(source.checkedAt)}`}</p>
        <a href={source.basisUrl} target="_blank" rel="noopener noreferrer">读取方式说明</a> · <a href={source.policyUrl} target="_blank" rel="noopener noreferrer">来源使用范围</a>
      </div>)}
    </details>
  </section>;
}

export function NewsExploreLink({ feed }: { feed: PrivateNewsFeed }) {
  return <section className="ep-news-explore ep-container"><div><span className="ep-demo-label">私有资讯 · VARIPULSE 试点</span>
    <h2>从资讯进入产品研究</h2><p>{feed.items.filter(item => !item.historical).length ? '已保存的研究更新与官方产品动态。' : '近期没有新增资讯；可查看已保存的历史资料。'}</p></div>
    <Link to={NEWS_PATH} className="ep-button ep-button-white">浏览研究资讯<ArrowRightIcon size={18} /></Link></section>;
}
