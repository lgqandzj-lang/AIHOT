import { useEffect, useMemo, useRef, useState } from "react";
import { data, Link, useLoaderData, useLocation, useSearchParams } from "react-router";
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpRightIcon, BookOpenIcon, BookmarkSimpleIcon, CheckIcon, CopyIcon, FileTextIcon, MagnifyingGlassIcon, QuotesIcon, RowsIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";
import type { Route } from "./+types/research";
import type { ShouldRevalidateFunctionArgs } from 'react-router';
import { loadResearchExperience } from "../features/research/experience.server";
import { loadReadingJobs } from '../features/research/reading-jobs.server';
import { ReadingJobsPage, WORK_PATH } from '../features/research/reading-jobs';
import type { ReadingExample, ReadingField, ResearchPaper } from "../features/research/contracts";
import { PrivatePaperViews } from "../features/research/private-paper-reading";
import { ChinesePaperReading } from '../features/research/chinese-paper-reading';
import { ResearchHome } from '../features/research/research-home';
import { PRODUCT_PATH, ProductEvidence, ProductResearchPage, safeProductReturn } from "../features/research/product-research";
import { NEWS_PATH, PrivateNewsPage } from "../features/research/private-news";
import "@fontsource-variable/manrope";
import "../features/research/fonts/font.css";
import "../features/research/research.css";

const SAVED_KEY = "ep-research-saved-v1";
const TOPICS = [{ key: "all", label: "全部文献" }, { key: "pfa", label: "脉冲电场" }, { key: "rf", label: "射频消融" }, { key: "basic", label: "机制与基础" }];

export async function loader({ request }: Route.LoaderArgs) {
  const experience = await loadResearchExperience(request.signal);
  const page = new URL(request.url).pathname.replace(/\.data$/, "").slice("/research".length).replace(/^\/+|\/+$/g, "");
  const work = page === 'work' && experience.preview && experience.privateProduct === 'varipulse';
  if (work) {
    try { experience.readingJobs = await loadReadingJobs(request.signal) || undefined; }
    catch (error) { if (request.signal.aborted) throw error; experience.readingJobsUnavailable = true; }
  }
  const readerId = page.startsWith("read/") ? page.slice(5) : null;
  const found = work || ["", "library", "saved"].includes(page) || page === 'news' && !!(experience.news || experience.newsUnavailable) || page === 'products/varipulse' && experience.privateProduct === 'varipulse' || readerId === "example" && !!experience.example || experience.papers.some(paper => paper.id === readerId);
  return data(experience, { status: found ? 200 : 404, headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) { return loaderHeaders; }
export function shouldRevalidate({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (currentUrl.pathname === PRODUCT_PATH && nextUrl.pathname === PRODUCT_PATH) return false;
  return defaultShouldRevalidate;
}
export function links() { return [{ rel: "icon", type: "image/svg+xml", href: "/research-symbol.svg" }]; }

export function meta({ location, loaderData: routeData }: Route.MetaArgs) {
  const id = location.pathname.split("/read/")[1];
  const paper = routeData?.papers.find((entry) => entry.id === id);
  const title = paper?.chineseReading?.titleZh || paper?.privateResearch?.display?.titleZh || paper?.title || (location.pathname === WORK_PATH && routeData?.privateProduct ? '内容整理进度 · 电生理研究' : location.pathname === NEWS_PATH && routeData?.news ? '最新进展 · 电生理研究' : location.pathname === PRODUCT_PATH && routeData?.privateProduct ? 'VARIPULSE 产品研究 · 电生理研究' : id === "example" ? "研究要点与原文 · 电生理研究" : location.pathname.endsWith("saved") ? "我的收藏 · 电生理研究" : location.pathname.endsWith("library") ? "文献库 · 电生理研究" : "电生理研究 · 看懂进展，找到依据");
  return [{ title }, { name: "description", content: "看懂电生理新进展，找到产品研究依据。当前以 VARIPULSE 为试点。" }, { name: "robots", content: "noindex" }];
}

function safeExternal(value: string | null): string | undefined {
  try { const url = new URL(value || ""); return url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}

function useSaved(notify: (message: string) => void) {
  const [saved, setSaved] = useState<string[]>([]);
  useEffect(() => {
    const read = () => {
      try { const value: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"); if (Array.isArray(value)) setSaved(value.filter((id): id is string => typeof id === "string").slice(0, 500)); } catch { /* A blocked browser store leaves a readable page. */ }
    };
    read();
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, []);
  function toggle(id: string) {
    const next = saved.includes(id) ? saved.filter((item) => item !== id) : [...saved, id];
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(next)); setSaved(next); notify(next.includes(id) ? "已加入收藏" : "已移出收藏"); }
    catch { notify("浏览器未能保存收藏，请检查本地存储设置。"); }
  }
  return { saved, toggle };
}

function Mark() {
  return <span className="ep-mark" aria-hidden="true"><i /><i /><i /><i /><i /></span>;
}

function ResearchHeader({ savedCount, privateProduct, privateNews }: { savedCount: number; privateProduct?: boolean; privateNews?: boolean }) {
  const { pathname } = useLocation();
  const items = [{ to: "/research", label: "首页" }, ...(privateNews ? [{ to: NEWS_PATH, label: '最新进展' }] : []), ...(privateProduct ? [{ to: PRODUCT_PATH, label: '产品研究' }] : []), { to: "/research/saved", label: "收藏" }];
  return <header className={`ep-header ${privateProduct ? 'has-product' : ''}`}>
    <Link to="/research" className="ep-wordmark" aria-label="电生理研究，返回首页"><Mark /><span><b>EP</b><span>电生理研究</span></span></Link>
    <nav aria-label="主要导航">{items.map(({ to, label }) => <Link key={to} to={to} className={pathname === to ? "is-active" : ""} aria-current={pathname === to ? "page" : undefined}>{label}{to.endsWith("saved") && savedCount > 0 && <span className="ep-nav-count">{savedCount}</span>}</Link>)}</nav>
    <Link to="/research/library?focus=search" className="ep-icon-button ep-header-search" aria-label="查找文献"><MagnifyingGlassIcon size={21} /></Link>
  </header>;
}

function SaveButton({ paper, saved, toggle, full = false }: { paper: ResearchPaper; saved: string[]; toggle: (id: string) => void; full?: boolean }) {
  const active = saved.includes(paper.id);
  return <button className={full ? "ep-button ep-button-white" : "ep-icon-button ep-save"} aria-label={`${active ? "移出收藏" : "收藏文献"}：${paper.title}`} aria-pressed={active} onClick={() => toggle(paper.id)} title={active ? "移出收藏" : "收藏文献"}>
    <BookmarkSimpleIcon size={19} weight={active ? "fill" : "regular"} />{full && (active ? "已收藏" : "收藏文献")}
  </button>;
}

function groupQuantity(group: NonNullable<ResearchPaper["privateDraft"]>["groups"][number]) {
  if (group.quantity === null) return "数量待核对";
  const unit = group.unit === "patients" ? "名患者" : group.unit === "animals" ? "只动物" : group.unit;
  return `${group.quantity} ${unit || "数量单位待核对"}`;
}

function PaperList({ papers, saved, toggle, grid = false }: { papers: ResearchPaper[]; saved: string[]; toggle: (id: string) => void; grid?: boolean }) {
  return <div className={`ep-paper-list ${grid ? "is-grid" : ""}`}>{papers.map((paper) => <article className="ep-paper" key={paper.id}>
    <div className="ep-paper-year">{paper.year ?? "年份待核对"}</div>
    <div className="ep-paper-main">
      <div className="ep-paper-meta"><span className="ep-topic-dot" />{TOPICS.find((topic) => topic.key === paper.topic)?.label}<span className="ep-meta-divider" /><span className="ep-paper-journal-short" title={paper.journal || undefined}>{paper.journal || "期刊待核对"}</span>{paper.privateDraft && <span className="ep-demo-label">私有自动整理草稿</span>}</div>
      <h3><Link to={`/research/read/${paper.id}`} className="ep-paper-title">{paper.title.replace(/\.$/, "")}</Link></h3>
      {!!paper.privateDraft?.groups.length && <p className="ep-draft-counts">{paper.privateDraft.groups.map(group => `${group.label} · ${groupQuantity(group)}`).join("；")}</p>}
      <div className="ep-paper-bottom"><div className="ep-paper-byline"><span>{paper.authors.slice(0, 2).join(" · ")}{paper.authors.length > 2 ? " 等" : ""}</span>{paper.pmid && <span className="ep-paper-pmid">PMID {paper.pmid}</span>}</div><Link to={`/research/read/${paper.id}`} className="ep-text-link">阅读文献<ArrowUpRightIcon size={17} /></Link></div>
    </div>
    <SaveButton paper={paper} saved={saved} toggle={toggle} />
  </article>)}</div>;
}

function EmptyState({ title, children, reset }: { title: string; children: React.ReactNode; reset?: () => void }) {
  return <div className="ep-empty"><BookOpenIcon size={38} weight="light" /><h3>{title}</h3><p>{children}</p>{reset ? <button className="ep-button ep-button-white" onClick={reset}>查看全部文献<ArrowRightIcon size={18} /></button> : <Link className="ep-button ep-button-white" to="/research/library">去文献库看看<ArrowRightIcon size={18} /></Link>}</div>;
}

function Library({ papers, saved, toggle, savedOnly, home = false, example = false }: { papers: ResearchPaper[]; saved: string[]; toggle: (id: string) => void; savedOnly: boolean; home?: boolean; example?: boolean }) {
  const [search, setSearch] = useSearchParams();
  const q = search.get("q") || "";
  const topic = search.get("topic") || "all";
  const [grid, setGrid] = useState(false);
  const [order, setOrder] = useState("newest");
  const [query, setQuery] = useState(q);
  useEffect(() => { setQuery(q); }, [q]);
  const filtered = useMemo(() => papers.filter((paper) => (!savedOnly || saved.includes(paper.id)) && (topic === "all" || paper.topic === topic) && `${paper.title} ${paper.journal} ${paper.authors.join(" ")} ${paper.doi} ${paper.pmid}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => order === "title" ? a.title.localeCompare(b.title) : (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title)), [papers, savedOnly, saved, topic, query, order]);
  const setTopic = (key: string) => { const next = new URLSearchParams(search); if (key === "all") next.delete("topic"); else next.set("topic", key); setSearch(next, { preventScrollReset: true }); };
  const reset = () => { setQuery(""); const next = new URLSearchParams(search); next.delete("q"); next.delete("topic"); setSearch(next, { preventScrollReset: true }); };
  return <section className="ep-library-page ep-container">
    <div className="ep-page-heading"><div><h1>{savedOnly ? "我的收藏" : home ? "研究文献" : "文献库"}</h1><p>{savedOnly ? "收藏仅保存在当前浏览器，方便下次继续阅读。" : "按主题筛选，或查找标题、作者、DOI 与 PMID。"}</p></div>{home && example && <Link to="/research/read/example" className="ep-quiet-link ep-reading-demo-link"><BookOpenIcon size={17} />证据阅读示例<ArrowUpRightIcon size={16} /></Link>}</div>
    <form className="ep-search" onSubmit={(event) => { event.preventDefault(); const next = new URLSearchParams(search); if (query.trim()) next.set("q", query.trim()); else next.delete("q"); setSearch(next, { preventScrollReset: true }); }}>
      <MagnifyingGlassIcon size={23} /><input type="search" aria-label="搜索文献" placeholder="搜索标题、作者或 DOI…" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus={search.get("focus") === "search"} />{query && <button type="button" aria-label="清空搜索" className="ep-icon-button" onClick={() => { setQuery(""); const next = new URLSearchParams(search); next.delete("q"); setSearch(next, { preventScrollReset: true }); }}><XIcon size={18} /></button>}<button type="submit" className="ep-search-submit">搜索<ArrowRightIcon size={18} /></button>
    </form>
    <div className="ep-library-controls"><div className="ep-topic-tabs" aria-label="研究方向">{TOPICS.map((item) => <button key={item.key} aria-pressed={topic === item.key} className={topic === item.key ? "is-active" : ""} onClick={() => setTopic(item.key)}>{item.label}</button>)}</div></div>
    <div className="ep-results-heading"><span role="status" aria-live="polite">{filtered.length} 篇{savedOnly ? "收藏" : "文献"}{query.trim() && ` · “${query.trim()}”`}</span><label>排序<select value={order} onChange={(event) => setOrder(event.target.value)} aria-label="文献排序"><option value="newest">年份由新到旧</option><option value="title">标题 A–Z</option></select></label><div className="ep-view-toggle"><button className={grid ? "" : "is-active"} onClick={() => setGrid(false)} aria-label="列表视图" aria-pressed={!grid}><RowsIcon size={19} /></button><button className={grid ? "is-active" : ""} onClick={() => setGrid(true)} aria-label="网格视图" aria-pressed={grid}><SquaresFourIcon size={19} /></button></div></div>
    {filtered.length ? <PaperList papers={filtered} saved={saved} toggle={toggle} grid={grid} /> : <EmptyState title={savedOnly && saved.length === 0 ? "把感兴趣的文献留在这里。" : query || topic !== "all" ? "没有找到相符的文献。" : "还没有已发布的研究。"} reset={savedOnly && saved.length === 0 ? undefined : reset}>{savedOnly && saved.length === 0 ? "在文献旁点击收藏，下次就能继续阅读。" : query || topic !== "all" ? "试试更短的关键词，或回到全部文献。" : "完成核对并发布后，文献会出现在这里。"}</EmptyState>}
  </section>;
}

function EvidenceContent({ field, source }: { field: ReadingField | undefined; source: ReadingExample["sources"][number] | undefined }) {
  const quote = field?.sourceQuote;
  const position = source && quote ? source.text.indexOf(quote) : -1;
  return <div className="ep-evidence-focus" aria-live="polite" aria-atomic="true"><p className="ep-small-label">当前要点 / {field?.label}</p><h2>{field?.value ?? "未报告"}</h2>{source ? <><div className="ep-evidence-source-label"><span className="ep-topic-dot" />{source.label}</div><blockquote lang="en">{position >= 0 && quote ? <>{source.text.slice(0, position)}<mark>{quote}</mark>{source.text.slice(position + quote.length)}</> : source.text}</blockquote><div className="ep-evidence-confirmation"><CheckIcon size={16} />已定位到对应片段<span>仍需人工判断原文是否支持该要点</span></div></> : <div className="ep-no-evidence"><FileTextIcon size={30} weight="light" /><p>当前材料中没有这一信息的原文依据。</p><span>不根据其他字段补推。</span></div>}</div>;
}

function ReaderExample({ example }: { example: ReadingExample }) {
  const [groupId, setGroupId] = useState(example.groups[0]?.id || "");
  const group = example.groups.find((entry) => entry.id === groupId)!;
  const [selected, setSelected] = useState("radiationStrategy");
  const field = group.fields.find((entry) => entry.key === selected) || group.fields[0];
  const source = example.sources.find((entry) => entry.id === field?.sourceIds[0]);
  const evidenceDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const query = matchMedia("(max-width: 800px)");
    const closeOnDesktop = () => { if (!query.matches) evidenceDialog.current?.close(); };
    query.addEventListener("change", closeOnDesktop);
    return () => query.removeEventListener("change", closeOnDesktop);
  }, []);
  const selectField = (key: string) => { setSelected(key); if (matchMedia("(max-width: 800px)").matches) evidenceDialog.current?.showModal(); };
  return <>
    <section className="ep-reader-heading ep-example-heading ep-container"><div className="ep-reader-topline"><Link to="/research" className="ep-back-link"><ArrowLeftIcon size={17} />返回探索</Link><div className="ep-reader-kicker"><span className="ep-demo-label">阅读示例 · 合成材料</span></div></div><h1>研究要点与原文</h1><p>点击要点查看出处。合成阅读示例，不代表真实临床研究。</p></section>
    <section className="ep-reader-workspace ep-container" aria-label="研究要点与原文对照">
      <div className="ep-reading-main"><div className="ep-reader-section-head"><span><BookOpenIcon size={20} />研究要点</span><span>按组别阅读</span></div><div className="ep-group-switch" aria-label="研究组别">{example.groups.map((entry) => <button key={entry.id} aria-pressed={entry.id === groupId} className={entry.id === groupId ? "is-active" : ""} onClick={() => { setGroupId(entry.id); setSelected("radiationStrategy"); }}><span>{entry.label}</span>{entry.fields.find((entry) => entry.key === "sample")?.value}</button>)}</div><div className="ep-reading-fields">{group.fields.map((entry) => <button key={entry.key} className={`ep-reading-field ${entry.key === field?.key ? "is-active" : ""} ${entry.value === null ? "is-unknown" : ""}`} aria-pressed={entry.key === field?.key} onClick={() => selectField(entry.key)}><span className="ep-field-name">{entry.label}</span><strong>{entry.value ?? "未报告"}</strong><span className="ep-field-source">{entry.sourceIds.length ? <><QuotesIcon size={14} />查看出处<ArrowUpRightIcon size={15} /></> : "未见明确报告"}</span></button>)}</div><button className="ep-mobile-evidence-button" onClick={() => evidenceDialog.current?.showModal()}><QuotesIcon size={18} />{field?.value ? `查看“${field.label}”的原文` : "查看未报告说明"}<ArrowUpRightIcon size={17} /></button><p className="ep-reading-note">各组信息分别呈现；原文没有报告的信息保留为未知。</p></div>
      <aside className="ep-evidence-pane" aria-labelledby="source-heading"><div className="ep-reader-section-head"><span id="source-heading"><QuotesIcon size={20} />原文依据</span><span>摘要片段</span></div><EvidenceContent field={field} source={source} /><details className="ep-source-details"><summary>阅读全部示例片段</summary>{example.sources.filter((entry) => group.fields.some((field) => field.sourceIds.includes(entry.id))).map((entry) => <div key={entry.id}><span>{entry.label}</span><p lang="en">{entry.text}</p></div>)}</details></aside>
      <dialog ref={evidenceDialog} className="ep-evidence-dialog" aria-labelledby="ep-dialog-title"><div className="ep-dialog-heading"><h2 id="ep-dialog-title"><QuotesIcon size={20} />原文依据</h2><button aria-label="关闭原文，返回要点" onClick={() => evidenceDialog.current?.close()} autoFocus><XIcon size={22} /></button></div><EvidenceContent field={field} source={source} /><p className="ep-dialog-caption">合成阅读示例 · 非真实临床文献</p></dialog>
    </section>
    <section className="ep-reader-end ep-container"><Link to="/research/library" className="ep-quiet-link">回到文献库<ArrowRightIcon size={18} /></Link></section>
  </>;
}

function PrivatePaperContent({ draft }: { draft: NonNullable<ResearchPaper["privateDraft"]> }) {
  const pending = draft.state === "invalid_output" ? "提取草稿暂不可展示，当前保留书目信息。"
    : draft.state === "unknown" ? "提取结果尚不明确，当前保留书目信息。"
    : draft.state === "index_only" ? "当前材料仅保留书目信息。" : "摘要草稿尚待核查，当前保留书目信息。";
  return <div className="ep-private-reading">
    {draft.sourceAbstract && <section className="ep-saved-abstract"><h2>原始摘要</h2>
      <p className="ep-reading-note">材料范围：仅摘要，未提供全文。<a href={draft.sourceAbstract.sourceUrl} target="_blank" rel="noopener noreferrer">{draft.sourceAbstract.sourceName}</a> · 保存于 {draft.sourceAbstract.acquiredAt.slice(0, 10)}</p>
      {draft.sourceAbstract.fragments.map(fragment => <div key={fragment.id}>{fragment.label && <h3>{fragment.label}</h3>}<p lang="en">{fragment.text}</p></div>)}
    </section>}
    <h2>{draft.readingChecks ? "自动整理 · 不完整草稿" : draft.sections?.length ? "摘要提取草稿" : draft.groups.length ? "研究对象与样本口径" : "研究内容待核对"}</h2>
    <p className="ep-reading-note">{draft.readingChecks ? `保留已通过现有展示检查的字段清单。${draft.readingChecks.deferredCount ? `另有 ${draft.readingChecks.deferredCount} 项暂缓展示。` : ""}` : draft.sections?.length ? "待核查字段保留模型原值。" : draft.groups.length ? "数量对应下列人群或样本口径。" : pending}</p>
    {draft.groups.map(group => <article className="ep-private-group" key={group.id}><h3>{group.label}<span>{groupQuantity(group)}</span></h3>
      {group.subjects && <p lang="en">{group.subjects}</p>}
      {group.populationScope && group.populationScope !== group.subjects && <p className="ep-population-scope"><span>样本口径</span><span lang="en">{group.populationScope}</span></p>}
      <details className="ep-source-details"><summary>查看原文依据与核查方式</summary><p>字段依据来自已有 AI 对照记录。</p>
        {group.evidence.map((source, index) => <div key={index}><span>{source.label}</span><blockquote lang="en">{source.quote}</blockquote></div>)}
      </details></article>)}
    {draft.sections?.length ? <>
      {draft.sections.map(section => <article className="ep-private-group" key={section.id}><h3>{section.label}</h3>
        {section.fields.map(field => <div className="ep-population-scope" key={field.key}><span>{field.label}</span><div><strong lang="en">{field.modelValue}</strong>
          <p>{field.review === "pending" ? "待核查" : field.review === "not_reported" ? "提供摘要未报告 · AI 对照" : "原文支持 · AI 对照"} · {field.note}</p>
          {!!field.evidence.length && <details className="ep-source-details"><summary>查看绑定摘要与核查依据</summary>{field.evidence.map((source, index) => <div key={index}><span>{source.label}</span><blockquote lang="en">{source.quote}</blockquote></div>)}</details>}
        </div></div>)}
      </article>)}</> : <p className="ep-reading-note">本页仅展示基础信息。</p>}
    <details className="ep-source-details"><summary>来源许可与整理说明</summary>
      <p>{draft.attribution.copyright}</p><a href={draft.attribution.licenseUrl} target="_blank" rel="noopener noreferrer">{draft.attribution.license}</a><p lang="en">{draft.attribution.changesNotice}</p>
    </details>{draft.diagnosticUrl && <a className="ep-quiet-link" href={draft.diagnosticUrl} target="_blank" rel="noopener noreferrer">管理员诊断（需登录）<ArrowUpRightIcon size={18} /></a>}</div>;
}

function PaperBibliography({ paper }: { paper: ResearchPaper }) {
  return <><dl><div><dt>DOI</dt><dd>{paper.doi || "未提供"}</dd></div><div><dt>PMID</dt><dd>{paper.pmid || "未提供"}</dd></div><div><dt>发表年份</dt><dd>{paper.year ?? "待核对"}</dd></div></dl><h3>书目信息来源</h3>{paper.sources.map(source => <a key={source.name} href={safeExternal(source.url)} target="_blank" rel="noopener noreferrer"><span>{source.name}<small>获取于 {source.acquiredAt.slice(0, 10)}</small></span><ArrowUpRightIcon size={18} /></a>)}</>;
}

function PaperReader({ paper, saved, toggle, notify }: { paper: ResearchPaper; saved: string[]; toggle: (id: string) => void; notify: (message: string) => void }) {
  const location = useLocation();
  const returnTo = safeProductReturn(location.state?.productReturn) || safeProductReturn(new URLSearchParams(location.search).get('returnTo'));
  const reading = paper.chineseReading;
  const titleZh = reading?.titleZh || paper.privateResearch?.display?.titleZh;
  const citation = `${paper.authors.join(", ")}. ${paper.title} ${paper.journal || ""}. ${paper.year || ""}.${paper.doi ? ` doi: ${paper.doi}` : ""}`;
  return <>
    <section className={`ep-reader-heading ep-paper-heading ep-container ${paper.privateDraft || reading ? 'is-private' : ''}`}><div className="ep-reader-topline"><Link to={returnTo || '/research'} state={returnTo ? { restoreProductPosition: true } : undefined} preventScrollReset={!!returnTo} className="ep-back-link"><ArrowLeftIcon size={17} />{returnTo ? '返回 VARIPULSE 研究' : '返回首页'}</Link><div className="ep-reader-kicker"><span className="ep-demo-label">{reading ? '中文研究解读' : paper.privateDraft ? "研究详情" : "书目信息"}</span><span>{paper.year ?? "年份待核对"} · {TOPICS.find(topic => topic.key === paper.topic)?.label}</span></div></div><h1 lang={titleZh ? 'zh-CN' : 'en'}>{(titleZh || paper.title).replace(/\.$/, "")}</h1>{reading ? <p className="ep-reader-curated-lead">{reading.leadZh}</p> : paper.privateResearch?.display && <><p className="ep-reader-curated-lead">{paper.privateResearch.display.leadZh}</p><p className="ep-product-copy-note">中文标题与导读 · 助手整理 · 依据{paper.privateResearch.display.basisScope === 'title' ? '原题' : '摘要'}</p><p className="ep-reader-original-title" lang="en">{paper.title}</p></>}{paper.privateResearch?.product.status === 'candidate' && <p className="ep-reader-candidate">候选资料 · 产品归属尚待补证。</p>}<p className="ep-paper-authors">{paper.authors.join(" · ") || "作者待核对"}</p><div className="ep-paper-journal">{paper.journal || "期刊待核对"}</div>
      {(paper.privateDraft || reading) && <details className="ep-bibliography ep-bibliography-inline"><summary>英文原题与文献信息{paper.doi && <span>DOI · {paper.doi}</span>}</summary>{reading && <p lang="en">{paper.title}</p>}<div className="ep-bibliography-mobile-details"><h3>作者</h3><p>{paper.authors.join(" · ") || "作者待核对"}</p><h3>期刊</h3><p>{paper.journal || "期刊待核对"}</p></div><PaperBibliography paper={paper} /></details>}
      <div className="ep-paper-actions"><SaveButton paper={paper} saved={saved} toggle={toggle} full /><button className="ep-button ep-button-white" onClick={async () => { try { await navigator.clipboard.writeText(citation); notify("引用信息已复制"); } catch { notify("复制未成功，请从下方书目信息手动复制。"); } }}><CopyIcon size={18} />复制引用</button>{paper.doi && <a className="ep-button ep-button-blue" href={`https://doi.org/${encodeURIComponent(paper.doi)}`} target="_blank" rel="noopener noreferrer">出版社原文<ArrowUpRightIcon size={18} /></a>}</div>{paper.privateResearch?.display && <ProductEvidence paper={paper} />}</section>
    <section className={`ep-paper-reading ep-container ${paper.privateDraft || reading ? 'is-private' : ''}`}>{reading ? <ChinesePaperReading reading={reading} hasPrivateDraft={!!paper.privateDraft} checkContent={paper.privateDraft ? <PrivatePaperContent draft={paper.privateDraft} /> : <><p lang="en">{paper.title}</p><PaperBibliography paper={paper} /></>} /> : paper.privateDraft ? <PrivatePaperViews draft={paper.privateDraft} checkContent={<PrivatePaperContent draft={paper.privateDraft} />} /> : <div className="ep-paper-pending"><h2>研究内容待核对</h2><p>当前提供书目信息，研究对象、组别、方法与结论尚未核对。可通过出版社或 PubMed 阅读原文。</p>{paper.pmid && <a href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(paper.pmid)}/`} className="ep-quiet-link" target="_blank" rel="noopener noreferrer">在 PubMed 中打开<ArrowUpRightIcon size={18} /></a>}</div>}{!paper.privateDraft && !reading && <aside className="ep-bibliography"><h2>文献出处</h2><PaperBibliography paper={paper} /></aside>}</section>
  </>;
}

export default function Research() {
  const experience = useLoaderData<typeof loader>();
  const { pathname } = useLocation();
  const [toast, setToast] = useState("");
  const { saved, toggle } = useSaved(setToast);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 3200); return () => clearTimeout(timer); }, [toast]);
  const readerId = pathname.split("/read/")[1];
  const paper = experience.papers.find((entry) => entry.id === readerId);
  const home = pathname === "/research" || pathname === "/research/";
  return <div className="ep-app"><a className="ep-skip-link" href="#ep-main">跳到正文</a><ResearchHeader savedCount={saved.length} privateProduct={!!experience.privateProduct} privateNews={!!experience.news} /><main id="ep-main">
    {experience.unavailable && pathname !== WORK_PATH && <div className="ep-load-error ep-container" role="status">文献暂时无法加载。<button onClick={() => location.reload()}>重新加载</button></div>}
    {pathname === NEWS_PATH && experience.newsUnavailable && <div className="ep-load-error ep-container" role="status">资讯暂时无法加载。<button onClick={() => location.reload()}>重新加载</button></div>}
    {pathname === WORK_PATH && experience.privateProduct ? <ReadingJobsPage feed={experience.readingJobs} papers={experience.papers} unavailable={experience.readingJobsUnavailable} /> : pathname === NEWS_PATH && experience.news ? <PrivateNewsPage feed={experience.news} /> : pathname === PRODUCT_PATH && experience.privateProduct ? <ProductResearchPage papers={experience.papers} saveButton={paper => <SaveButton paper={paper} saved={saved} toggle={toggle} />} /> : home ? <ResearchHome papers={experience.papers} news={experience.news} newsUnavailable={experience.newsUnavailable} /> : readerId === "example" && experience.example ? <ReaderExample example={experience.example} /> : paper ? <PaperReader paper={paper} saved={saved} toggle={toggle} notify={setToast} /> : pathname.endsWith("/library") || pathname.endsWith("/saved") ? <Library papers={experience.papers} saved={saved} toggle={toggle} savedOnly={pathname.endsWith("/saved")} /> : <div className="ep-container ep-not-found"><EmptyState title="这篇文献暂时不可阅读。">文献可能尚未发布，返回文献库继续探索。</EmptyState></div>}
  </main><footer className="ep-footer ep-container"><Link to="/research" className="ep-footer-brand"><Mark /><span>电生理研究</span></Link><p>发现研究。读懂方法。回到证据。</p>{experience.preview && <span className="ep-preview-label">{experience.papers.some(paper => paper.privateDraft) ? "仅本机预览" : "本地预览 · 真实书目信息与合成阅读示例"}</span>}</footer>{toast && <div className="ep-toast" role="status"><CheckIcon size={18} />{toast}<button aria-label="关闭提示" onClick={() => setToast("")}><XIcon size={16} /></button></div>}</div>;
}
