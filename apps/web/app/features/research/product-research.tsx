import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpRightIcon, BookOpenIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import type { CohortStudy, ResearchPaper } from './contracts';

export const PRODUCT_PATH = '/research/products/varipulse';
const POSITION_KEY = 'ep-product-reading-position-v1';
const scopes = { metadata: '仅书目', abstract: '摘要', partial_fulltext: '部分全文', fulltext: '全文' };

export function safeProductReturn(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(PRODUCT_PATH)) return null;
  try { const url = new URL(value, 'http://localhost'); return url.origin === 'http://localhost' && url.pathname === PRODUCT_PATH ? url.pathname + url.search : null; } catch { return null; }
}

/** Versions of the same persisted record share one list entry. Detail IDs and existing bookmarks stay intact. */
export function productPapers(papers: ResearchPaper[]): ResearchPaper[] {
  const records = new Map<string, ResearchPaper>();
  for (const paper of papers) {
    const entry = paper.privateResearch;
    if (!entry || entry.product.id !== 'varipulse') continue;
    const existing = records.get(entry.recordId);
    if (!existing || existing.privateResearch!.readerVersion < entry.readerVersion) records.set(entry.recordId, paper);
  }
  return [...records.values()];
}

export function ProductEvidence({ paper }: { paper: ResearchPaper }) {
  const entry = paper.privateResearch;
  if (!entry) return null;
  const verification = entry.product.verification;
  return <details className="ep-product-evidence"><summary>原题与产品关联证据</summary>
    <p className="ep-product-evidence-label">英文原题</p><p lang="en">{paper.title}</p>
    <p className="ep-product-evidence-label">作者 · 期刊</p><p>{paper.authors.join(' · ') || '作者待核对'}</p><p>{paper.journal || '期刊待核对'}</p>
    {verification ? <><p className="ep-product-evidence-label">关联已确认 · 助手查证 · {verification.method === 'article_fulltext' ? '本篇正文点名产品' : '论文注册号与官方资料对应'}</p><p>{verification.note}</p>
      <p>此核对只确认产品关联；临床字段仍按原草稿状态展示，尚无人类审核批准。</p>
      {verification.sources.map((source, index) => <div className="ep-product-source-item" key={`${source.role}-${index}`}><p className="ep-product-evidence-label">{source.label} · {source.location}</p><blockquote lang="en">{source.quote}</blockquote>
        <a href={source.url} target="_blank" rel="noopener noreferrer">核对该来源<ArrowUpRightIcon size={14} /></a><time dateTime={source.acquiredAt}>取得：{source.acquiredAt.replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC')}</time></div>)}
      <p className="ep-product-evidence-label">关联核对时间：{verification.checkedAt.replace('T', ' ').replace('Z', ' UTC')}</p></>
      : <><p className="ep-product-evidence-label">{entry.product.evidence.label}</p><blockquote lang="en">{entry.product.evidence.quote}</blockquote><a href={entry.product.evidence.url} target="_blank" rel="noopener noreferrer">核对原始来源<ArrowUpRightIcon size={14} /></a></>}
    {entry.display && <p className="ep-product-copy-note">中文标题与导读：助手整理 · 依据{entry.display.basisScope === 'title' ? '已保存原题' : '已保存摘要'} · {entry.display.preparedAt.slice(0, 10)}。{entry.materialScope === 'metadata' && '仅作题名范围内的介绍。'}</p>}
    {entry.questions.length > 0 && <p className="ep-product-copy-note">研究问题入口沿用原题中的明确用词，不推断研究结果。</p>}
  </details>;
}

function CohortCounts({ study }: { study: CohortStudy }) {
  if (!study.counts.length) return <p className="ep-cohort-empty">这篇摘要没有写出本篇入组人数。</p>;
  return <ul>{study.counts.map(count => <li key={`${count.groupLabel}-${count.quantity}-${count.unit}`}>
    <strong>{`${count.quantity} ${count.unit}`}</strong><span>{count.groupLabel}</span><p>{count.populationScope}</p><blockquote lang="en">{count.locator}</blockquote>
  </li>)}</ul>;
}

export function CohortCountList({ studies }: { studies: CohortStudy[] }) {
  if (!studies.length) return null;
  const counted = studies.filter(study => study.counts.length > 0).length;
  return <section className="ep-cohort" aria-label="摘要写明的入组人数">
    <div className="ep-product-section-heading"><h2>摘要写明的入组人数</h2><p>{counted} 篇摘要写出了人数，其余摘要没有本篇入组整数。数字旁边是 PubMed 摘要原句。</p></div>
    <div className="ep-cohort-list">{studies.map(study => <article className="ep-cohort-study" key={study.pmid} data-cohort-pmid={study.pmid}>
      <div className="ep-cohort-meta"><span>{study.published}</span><span>{study.journal}</span><span>PMID {study.pmid}</span></div>
      <h3><Link to={`/research/read/cohort-${study.pmid}`}>{study.title.replace(/\.$/, '')}</Link></h3>
      <CohortCounts study={study} />
      <a href={study.pubmedUrl} target="_blank" rel="noopener noreferrer">在 PubMed 打开<ArrowUpRightIcon size={16} /></a>
    </article>)}</div>
  </section>;
}

export function CohortStudyReader({ study }: { study: CohortStudy }) {
  return <section className="ep-reader-heading ep-container">
    <div className="ep-reader-topline"><Link to={PRODUCT_PATH} className="ep-back-link"><ArrowLeftIcon size={17} />返回 VARIPULSE</Link></div>
    <h1 lang="en">{study.title.replace(/\.$/, '')}</h1>
    <p className="ep-paper-journal">{study.journal}</p>
    <p>{study.published} · PMID {study.pmid}</p>
    <CohortCounts study={study} />
    <div className="ep-paper-actions"><a className="ep-button ep-button-blue" href={study.pubmedUrl} target="_blank" rel="noopener noreferrer">PubMed<ArrowUpRightIcon size={18} /></a>{study.doi && <a className="ep-button ep-button-white" href={`https://doi.org/${encodeURIComponent(study.doi)}`} target="_blank" rel="noopener noreferrer">出版社原文<ArrowUpRightIcon size={18} /></a>}</div>
  </section>;
}

export function ProductResearchPage({ papers, cohortStudies = [], saveButton }: { papers: ResearchPaper[]; cohortStudies?: CohortStudy[]; saveButton: (paper: ResearchPaper) => ReactNode }) {
  const [search, setSearch] = useSearchParams();
  const pendingSearch = useRef(search);
  useEffect(() => { pendingSearch.current = search; }, [search]);
  const location = useLocation(), returnTo = location.pathname + location.search;
  const q = search.get('q') || '', question = search.get('question') || '', status = search.get('status') || '', type = search.get('type') || '', scope = search.get('scope') || '', order = search.get('order') || 'newest';
  const [query, setQuery] = useState(q);
  useEffect(() => setQuery(q), [q]);
  useEffect(() => {
    if (!location.state?.restoreProductPosition) return;
    let frame = 0;
    try {
      const saved = JSON.parse(sessionStorage.getItem(POSITION_KEY) || 'null');
      if (saved?.url === returnTo && Number.isFinite(saved.y) && saved.y >= 0) {
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => window.scrollTo(0, saved.y)); });
      }
    } catch { /* Reading works when session storage is unavailable. */ }
    return () => cancelAnimationFrame(frame);
  }, [location.key, location.state, returnTo]);
  const entries = useMemo(() => productPapers(papers), [papers]);
  const interpreted = entries.filter(paper => paper.chineseReading);
  const confirmed = entries.filter(paper => paper.privateResearch!.product.status === 'confirmed');
  const candidate = entries.filter(paper => paper.privateResearch!.product.status === 'candidate');
  const questions = [...new Map(entries.flatMap(paper => paper.privateResearch!.questions).map(item => [item.id, item])).values()];
  const types = [...new Set(entries.map(paper => paper.privateResearch!.studyType))];
  const materialScopes = [...new Set(entries.map(paper => paper.privateResearch!.materialScope))];
  const filtered = entries.filter(paper => {
    const entry = paper.privateResearch!, haystack = [paper.title, entry.display?.titleZh, entry.display?.leadZh, ...paper.authors, paper.doi, paper.pmid, ...entry.questions.map(item => item.label)].join(' ').toLowerCase();
    return (!q || haystack.includes(q.toLowerCase())) && (!question || entry.questions.some(item => item.id === question))
      && (!status || entry.product.status === status) && (!type || entry.studyType === type) && (!scope || entry.materialScope === scope);
  }).sort((a, b) => order === 'title' ? a.title.localeCompare(b.title, 'en')
    : (b.privateResearch!.publishedOn || (b.year ? `${b.year}-01-01` : '')).localeCompare(a.privateResearch!.publishedOn || (a.year ? `${a.year}-01-01` : '')) || a.title.localeCompare(b.title, 'en'));
  const change = (key: string, value: string) => { const next = new URLSearchParams(pendingSearch.current); if (value) next.set(key, value); else next.delete(key); pendingSearch.current = next; setSearch(next, { preventScrollReset: true }); };
  const reset = () => { setQuery(''); pendingSearch.current = new URLSearchParams(); setSearch(pendingSearch.current, { preventScrollReset: true }); };
  const remember = () => { try { sessionStorage.setItem(POSITION_KEY, JSON.stringify({ url: returnTo, y: window.scrollY })); } catch { /* Browser back still uses its normal restoration. */ } };
  const list = (membership: 'confirmed' | 'candidate') => {
    const records = filtered.filter(paper => paper.privateResearch!.product.status === membership);
    if (!records.length) return null;
    return <section className="ep-product-section" aria-label={membership === 'confirmed' ? '已有产品关联依据的资料' : '产品归属待确认的候选资料'}>
      <div className="ep-product-section-heading"><h3>{membership === 'confirmed' ? '已有产品关联依据' : '候选资料 · 归属待确认'}<span>{records.length} 篇</span></h3>
        <p>{membership === 'confirmed' ? '展开每篇资料的原题与产品关联证据，核对具体来源。' : '保留现有私有研究资料供核对。产品归属缺少可核对依据，具体来源可展开查看。'}</p></div>
      <div className="ep-product-list">{records.map(paper => {
        const entry = paper.privateResearch!, published = entry.publishedOn || (paper.year ? `${paper.year} 年` : '待核对');
        const acquired = [...paper.sources].sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt))[0]?.acquiredAt.slice(0, 10);
        const reader = `/research/read/${paper.id}`, state = { productReturn: returnTo };
        return <article className="ep-product-paper" key={entry.recordId} data-product-membership={membership}>
          <div className="ep-product-paper-date"><span>发表时间</span><time dateTime={entry.publishedOn || String(paper.year || '')}>{published}</time></div>
          <div className="ep-product-paper-main"><div className="ep-product-paper-meta"><span>{entry.studyType}</span><span>阅读材料：{paper.chineseReading ? '中文全文解读' : scopes[entry.materialScope]}</span></div>
            <h4><Link to={reader} state={state} onClick={remember}>{(paper.chineseReading?.titleZh || entry.display?.titleZh || paper.title).replace(/\.$/, '')}</Link></h4>
            {(paper.chineseReading || entry.display) && <p className="ep-product-paper-lead">{paper.chineseReading?.leadZh || entry.display?.leadZh}</p>}
            <p className="ep-product-paper-question">研究问题<span>{entry.questions.map(item => item.label).join(' · ') || '待分类'}</span></p>
            <div className="ep-product-paper-bottom"><span title={paper.journal || undefined}>{paper.sources[0]?.name} · {paper.journal || '期刊待核对'}</span><Link to={reader} state={state} onClick={remember}>阅读资料<ArrowUpRightIcon size={16} /></Link></div>
            <div className="ep-product-paper-source"><span>平台收录 {acquired || '时间待核对'}</span><ProductEvidence paper={paper} /></div>
          </div>{saveButton(paper)}
        </article>;
      })}</div>
    </section>;
  };
  return <section className="ep-product-page ep-container">
    <div className="ep-product-heading"><div className="ep-product-kicker">产品研究<span>{entries.length ? '私有资料' : '摘要计数'}</span></div><h1>VARIPULSE</h1><p className="ep-product-intro">脉冲电场消融平台 · 阅读已有文献，回到原文依据。</p>{entries.length > 0 && <p className="ep-product-scope">中文标题与导读为助手整理。产品关联确认与临床审核独立；临床草稿尚无人类审核批准。</p>}
      <div className="ep-product-counts"><span><b>{confirmed.length}</b> 篇已有产品关联依据</span><span><b>{candidate.length}</b> 篇候选资料</span><span>发表与收录时间分别显示</span></div></div>
    <CohortCountList studies={cohortStudies} />
    {!!interpreted.length && <section className="ep-product-interpreted" aria-label="中文研究解读"><h2>中文研究解读</h2>{interpreted.map(paper=><article key={paper.id}><div><span>已保存全文解读 · 私有模型草稿</span><h3><Link to={`/research/read/${paper.id}`} state={{productReturn:returnTo}} onClick={remember}>{paper.chineseReading!.titleZh}</Link></h3><p>{paper.chineseReading!.leadZh}</p></div><Link className="ep-quiet-link" to={`/research/read/${paper.id}`} state={{productReturn:returnTo}} onClick={remember}>阅读这篇研究<ArrowRightIcon size={17}/></Link></article>)}</section>}
    {questions.length > 0 && <div className="ep-product-questions"><h2>按研究问题阅读</h2><div role="group" aria-label="研究问题筛选"><button className={!question ? 'is-active' : ''} aria-pressed={!question} onClick={() => change('question', '')}>全部问题<span>{entries.length}</span></button>{questions.map(item => <button key={item.id} className={question === item.id ? 'is-active' : ''} aria-pressed={question === item.id} onClick={() => change('question', question === item.id ? '' : item.id)}>{item.label}<span>{entries.filter(paper => paper.privateResearch!.questions.some(question => question.id === item.id)).length}</span></button>)}</div></div>}
    {(entries.length > 0 || cohortStudies.length === 0) && <section className="ep-product-research" aria-labelledby="ep-product-research-heading"><div className="ep-product-research-heading"><h2 id="ep-product-research-heading">研究资料</h2><Link to="/research/saved" className="ep-quiet-link">查看我的收藏<ArrowRightIcon size={16} /></Link></div>
      <form className="ep-search" onSubmit={event => { event.preventDefault(); change('q', query.trim()); }}><MagnifyingGlassIcon size={22} /><input type="search" aria-label="搜索产品研究" placeholder="搜索标题、作者或 DOI…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" className="ep-icon-button" aria-label="清空产品研究搜索" onClick={() => { setQuery(''); change('q', ''); }}><XIcon size={18} /></button>}<button type="submit" className="ep-search-submit">搜索<ArrowRightIcon size={17} /></button></form>
      <div className="ep-product-filters"><label>产品归属<select aria-label="产品归属筛选" value={status} onChange={event => change('status', event.target.value)}><option value="">全部资料</option>{confirmed.length > 0 && <option value="confirmed">已有品牌依据</option>}{candidate.length > 0 && <option value="candidate">归属待确认</option>}</select></label>
        {types.length > 1 && <label>研究类型<select aria-label="研究类型筛选" value={type} onChange={event => change('type', event.target.value)}><option value="">全部类型</option>{types.map(value => <option key={value}>{value}</option>)}</select></label>}
        {materialScopes.length > 1 && <label>材料范围<select aria-label="材料范围筛选" value={scope} onChange={event => change('scope', event.target.value)}><option value="">全部材料</option>{materialScopes.map(value => <option key={value} value={value}>{scopes[value]}</option>)}</select></label>}</div>
      <div className="ep-results-heading ep-product-results"><span role="status" aria-live="polite">{filtered.length} 篇资料{question && ` · ${questions.find(item => item.id === question)?.label || '所选问题'}`}{q && ` · “${q}”`}</span>{(q || question || status || type || scope) && <button className="ep-quiet-link" onClick={reset}>清除筛选<XIcon size={15} /></button>}<label>排序<select aria-label="产品研究排序" value={order} onChange={event => change('order', event.target.value)}><option value="newest">发表时间由新到旧</option><option value="title">标题 A–Z</option></select></label></div>
      {filtered.length > 0 ? <>{list('confirmed')}{list('candidate')}</> : <div className="ep-empty"><BookOpenIcon size={32} weight="light" /><h3>{entries.length ? '没有找到相符的资料。' : '当前没有可读取的产品资料。'}</h3><p>{entries.length ? '试试更短的关键词，或清除筛选查看全部资料。' : '现有资料加载后，研究问题入口与文献列表会在这里显示。'}</p>{entries.length > 0 && <button className="ep-button ep-button-white" onClick={reset}>清除筛选，查看全部<ArrowRightIcon size={17} /></button>}</div>}
    </section>}
    {entries.length > 0 && <Link to="/research/work" className="ep-reading-work-link">内容整理进度<ArrowRightIcon size={15} /></Link>}
  </section>;
}
