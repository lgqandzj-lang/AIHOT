import type { ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import type { PrivateReadingDraft, PrivateReadingView, ReadingCount, ReadingEvidence, ReadingValue } from './contracts';
import { readingResultRows } from './private-reading-layout';

const display = (field: ReadingValue) => field.value !== null ? String(field.value)
  : field.absence === 'not_reported' ? '摘要未报告（模型标记）' : field.absence === 'not_applicable' ? '不适用（模型标记）' : '未知';

function Evidence({ sources, title = '展开原文依据' }: { sources: ReadingEvidence[]; title?: string }) {
  if (!sources.length) return null;
  return <details className="ep-reading-evidence"><summary>{title}</summary>{sources.map((source, index) => <div key={index}><p className="ep-evidence-caption">{source.label}</p><blockquote lang="en">{source.quote}</blockquote></div>)}</details>;
}

function SavedAbstract({ draft }: { draft: PrivateReadingDraft }) {
  const source = draft.sourceAbstract;
  if (!source) return null;
  return <section className="ep-reading-section ep-saved-abstract" id="ep-source-abstract" aria-labelledby="ep-abstract-heading">
    <h2 id="ep-abstract-heading">原始摘要</h2>
    <p className="ep-section-intro">仅摘要，未提供全文。<a href={source.sourceUrl} target="_blank" rel="noopener noreferrer">{source.sourceName}</a> · 保存于 {source.acquiredAt.slice(0, 10)}</p>
    {source.fragments.map(fragment => <div key={fragment.id}>{fragment.label && <h3>{fragment.label}</h3>}<p lang="en">{fragment.text}</p></div>)}
  </section>;
}

function Counts({ counts, label }: { counts: ReadingCount[]; label: string }) {
  return <div className="ep-reading-counts">{counts.map(count => <div key={count.key} data-count-key={count.key}>
    <p className="ep-count-value"><span>{label}</span><strong>{display(count.quantity)} <span>{count.unit.value ?? ''}</span></strong></p>
    {count.populationScope.value !== null && <p className="ep-count-scope" lang="en">{display(count.populationScope)}</p>}
    <Evidence sources={count.evidence} />
  </div>)}</div>;
}

function ResultRecord({ result, owner }: { result: PrivateReadingView['results'][number]; owner: string }) {
  const hasCounts = result.numerator.value !== null || result.outcomeDenominator.value !== null;
  const sameNumerator = result.numerator.value !== null && result.numerator.value === result.resultValue.value && result.countUnit.value === result.unit.value;
  const needsStatistic = result.statistic.value !== null || result.kind === 'duration' || result.unit.value === '%';
  return <article className="ep-reading-result" data-result-id={result.id} data-result-owner={result.groupId}>
    <p className="ep-result-owner" lang="en">{owner}</p>
    <p className="ep-result-value"><strong>{display(result.resultValue)}</strong> <span lang="en">{result.unit.value ?? ''}</span></p>
    {result.resultValue.value === null && <p className="ep-result-question">数值{display(result.resultValue)}，不能据此计算组间差异。</p>}
    {needsStatistic && <><p className="ep-result-statistic">统计标签：<span lang="en">{display(result.statistic)}</span></p>
      <p className="ep-result-question">{result.statistic.value !== null ? '此标签由模型保存，尚待核查摘要是否明确支持。' : '统计口径尚不明确，不能把数值默认为均值或中位数。'}</p></>}
    {hasCounts && !sameNumerator && <p className="ep-result-count">结局计数：{display(result.numerator)} <span lang="en">{result.countUnit.value ?? ''}</span></p>}
    {result.kind === 'outcome' && <p className="ep-result-count">本结果分母：{display(result.outcomeDenominator)}{result.outcomeDenominator.value !== null && <> <span lang="en">{result.countUnit.value ?? ''}</span></>}</p>}
    {result.windows.map(window => <div key={window.key}><p className="ep-result-count">观察窗口：<span lang="en">{window.value}</span></p><Evidence sources={window.evidence} title="展开观察窗口依据" /></div>)}
    <Evidence sources={result.evidence} />
  </article>;
}

function StructuredGroups({ view }: { view: PrivateReadingView }) {
  const rows = readingResultRows(view);
  return <section className="ep-reading-section" aria-labelledby="ep-groups-heading">
    <h2 id="ep-groups-heading">研究分组与已有结果</h2>
    {!!view.overallCounts.length && <div className="ep-overall-counts"><h3>总体样本</h3><Counts counts={view.overallCounts} label="总体计数" /></div>}
    {!!view.groups.length && <div className={`ep-reading-groups ${view.groups.length === 1 ? 'is-single' : ''}`}>
      {view.groups.map(group => <article className="ep-reading-group" key={group.id} data-group-id={group.id}>
        <h3 lang="en">{group.label}</h3>
        {group.subjects && <p className="ep-group-subjects" lang="en">{group.subjects}</p>}
        {!!group.counts.length && <Counts counts={group.counts} label="组别计数" />}
        {group.contexts.map(context => <div className="ep-group-context" key={context.key}><h4>流程阶段</h4><p lang="en">{context.value}</p><Evidence sources={context.evidence} /></div>)}
        {!!group.methods.length && <details className="ep-reading-methods"><summary>产品与方法</summary>{group.methods.map(method => <div key={method.key}><h4>{method.label}</h4><p lang="en">{method.value}</p><Evidence sources={method.evidence} /></div>)}</details>}
        {!group.counts.length && <p className="ep-result-question">本组样本计数暂无可展示字段。</p>}
      </article>)}
    </div>}
    {rows.map(row => {
      const ids = new Set(row.results.map(result => result.id));
      const comparisons = view.comparisons.filter(comparison => comparison.resultIds.every(id => ids.has(id)));
      return <section key={row.key} className={`ep-reading-metric ${row.paired ? 'is-paired' : ''}`} data-metric={row.metric}>
        <h3 lang="en">{row.metric}<span>{row.results[0].groupId === 'overall' ? '总体结果' : row.paired ? '同指标 · 按已保存组别排列' : '已有结果'}</span></h3>
        <div className="ep-reading-result-grid">{row.results.map(result => <ResultRecord key={result.id} result={result} owner={result.groupId === 'overall' ? '总体' : view.groups.find(group => group.id === result.groupId)!.label} />)}</div>
        {comparisons.map(comparison => <details key={comparison.key} className="ep-reading-comparison"><summary>展开模型保存的比较说明</summary><p lang="en">{comparison.description}</p><p className="ep-result-question">比较说明尚待内容核查。</p><Evidence sources={comparison.evidence} /></details>)}
      </section>;
    })}
    {!rows.length && <p className="ep-section-intro">暂无通过现有检查的结果字段；可继续阅读原始摘要。</p>}
  </section>;
}

function LegacyGroups({ draft }: { draft: PrivateReadingDraft }) {
  return <section className="ep-reading-section" aria-labelledby="ep-groups-heading"><h2 id="ep-groups-heading">研究分组与已有结果</h2>
    <div className={`ep-reading-groups ${draft.groups.length === 1 ? 'is-single' : ''}`}>{draft.groups.map(group => <article className="ep-reading-group" key={group.id} data-group-id={group.id}>
      <h3>{group.label}</h3>{group.quantity !== null ? <p className="ep-count-value"><span>组别计数</span><strong>{group.quantity} <span>{group.unit === 'patients' ? '名患者' : group.unit === 'animals' ? '只动物' : group.unit}</span></strong></p> : <p className="ep-result-question">数量待核对</p>}
      {group.populationScope && <p className="ep-count-scope" lang="en">{group.populationScope}</p>}
      <Evidence sources={group.evidence} title="查看原文依据与核查方式" />
    </article>)}</div><p className="ep-section-intro">当前已核查字段仅包含对象与样本口径；其他结果请阅读原始摘要。</p>
  </section>;
}

function ReadingContent({ draft }: { draft: PrivateReadingDraft }) {
  // Only the existing source-supported basic fields qualify as an overview. Pending v4 fields never become a prose summary.
  const subjects = [...new Set(draft.groups.map(group => group.subjects).filter((value): value is string => !!value))];
  const hasOverview = subjects.length > 0;
  const view = draft.readingView;
  const missingStatistics = view?.results.some(result => result.statistic.value === null && (result.kind === 'duration' || result.unit.value === '%'));
  const missingDenominators = view?.results.some(result => result.kind === 'outcome' && result.outcomeDenominator.value === null);
  return <div className="ep-private-reading ep-reading-version" data-reading-view="reading">
    {hasOverview ? <section className="ep-reading-section ep-reading-overview"><h2>研究对象</h2>{subjects.map(subject => <p key={subject} lang="en">{subject}</p>)}</section> : <SavedAbstract draft={draft} />}
    {view ? <StructuredGroups view={view} /> : draft.groups.length ? <LegacyGroups draft={draft} /> : !draft.sourceAbstract && <section className="ep-reading-section"><h2>研究内容待核对</h2><p className="ep-section-intro">当前材料仅保留书目信息，可通过原文入口继续阅读。</p></section>}
    {hasOverview && <SavedAbstract draft={draft} />}
    <section className="ep-reading-section ep-reading-questions" aria-labelledby="ep-questions-heading"><h2 id="ep-questions-heading">影响理解的待核事项</h2>
      <ul>{view ? <><li>已展示的分组、计数、结果与比较说明仍待内容核查。展开各项原文依据，可回读绑定的摘要。</li>
        {missingStatistics && <li>部分统计口径未明确保存；具体缺失已在对应结果旁标示。</li>}
        {missingDenominators && <li>部分结局未报告本结果分母；总体计数与组别计数不能替代它。</li>}
        {!!draft.readingChecks?.deferredCount && <li>另有 {draft.readingChecks.deferredCount} 项尚未通过现有展示检查，可在核对版或管理员诊断入口查看。</li>}
      </> : <li>本页仅展示已有 AI 对照支持的基础信息。尚未核查的结果未整理为研究结论。</li>}</ul>
    </section>
    <details className="ep-reading-evidence ep-reading-license"><summary>来源许可与整理说明</summary><p>{draft.attribution.copyright}</p><a href={draft.attribution.licenseUrl} target="_blank" rel="noopener noreferrer">{draft.attribution.license}</a><p lang="en">{draft.attribution.changesNotice}</p></details>
  </div>;
}

export function PrivatePaperViews({ draft, checkContent }: { draft: PrivateReadingDraft; checkContent: ReactNode }) {
  const location = useLocation();
  const [search] = useSearchParams();
  const check = search.get('view') === 'check';
  const viewHref = (view: string) => { const next = new URLSearchParams(search); next.set('view', view); return '?' + next.toString(); };
  return <div className="ep-private-paper-views">
    <div className="ep-private-notice"><strong>私有自动整理草稿</strong><p>仅依据已保存摘要；结构与引用检查不等于内容正确。{draft.reviewMethod === 'assistant_source_comparison' ? '已有基础字段经 AI 对照原文；' : '内容待核查；'}尚无人类审核批准。</p></div>
    <nav className="ep-reading-controls" aria-label="详情视图">
      <div className="ep-reading-view-switch"><Link to={viewHref('reading')} state={location.state} replace aria-current={!check ? 'page' : undefined}>阅读版</Link><Link to={viewHref('check')} state={location.state} replace aria-current={check ? 'page' : undefined}>核对版</Link></div>
      {draft.sourceAbstract && <Link to={viewHref('reading') + '#ep-source-abstract'} state={location.state} replace>原始摘要</Link>}
    </nav>
    {check ? <div data-reading-view="check">{checkContent}</div> : <ReadingContent draft={draft} />}
  </div>;
}
