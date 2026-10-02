import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { ArrowUpRightIcon, XIcon } from '@phosphor-icons/react';
import type { ChineseResearchReading } from './contracts';
import './chinese-paper-reading.css';

export function ChinesePaperReading({reading,checkContent,hasPrivateDraft}:{reading:ChineseResearchReading;checkContent:ReactNode;hasPrivateDraft:boolean}) {
  const [search]=useSearchParams(),location=useLocation(),check=search.get('view')==='check';
  const [sourceId,setSourceId]=useState<string|null>(null),dialog=useRef<HTMLDialogElement>(null);
  const source=reading.sources.find(source=>source.id===sourceId);
  useEffect(()=>{if(source && dialog.current && !dialog.current.open)dialog.current.showModal();},[source]);
  const href=(view:string)=>{const next=new URLSearchParams(search);next.set('view',view);return '?'+next.toString();};
  const headings=[...reading.markdown.matchAll(/^##\s+(.+)$/gm)].map(match=>match[1]!);
  let headingIndex=0;
  const html=reading.html.replace(/<h2>/g,()=>`<h2 id="reading-section-${headingIndex++}">`);
  const abstract=reading.sources.filter(source=>source.scope==='abstract');
  const firstFulltext=reading.sources.find(source=>source.scope==='fulltext');
  const close=()=>{dialog.current?.close();setSourceId(null);};
  return <div className="ep-chinese-reading" data-reading-kind="chinese_model_prose">
    <div className="ep-chinese-reading-note"><strong>中文研究解读 · 私有模型草稿{reading.correctionNotes.length?' · 经 AI 对照修订':''}</strong><p>依据已保存摘要与新增全文，区分研究事实、作者解释和阅读分析。{reading.semanticStatus==='assistant_source_comparison'?'已由 AI 对照原文；':'内容核查中；'}尚无人类审核批准。</p>
      {!!reading.corrections.length && <details><summary>查看 {reading.corrections.length} 项修订记录</summary><ul>{reading.corrections.map((change,index)=><li key={index}><strong>{change.reason}</strong><p>原模型文字：{change.before}</p><p>AI 对照修订：{change.after}</p><p>依据：{change.sourceIds.map(id=><button type="button" key={id} onClick={()=>setSourceId(id)}>{id}</button>)}</p></li>)}</ul><p>原始模型输出保留，以上修订单独记录。</p></details>}</div>
    <nav className="ep-chinese-reading-tools" aria-label="阅读与查证入口"><span>全文依据 · {reading.generatedAt.slice(0,10)}</span><div>
      <button type="button" onClick={()=>setSourceId(abstract[0]?.id || null)}>原始摘要</button>
      {firstFulltext && <a href={firstFulltext.sourceUrl.split('#')[0]} target="_blank" rel="noopener noreferrer">PMC 全文<ArrowUpRightIcon size={14}/></a>}
      <Link to={href(check?'reading':'check')} state={location.state} replace>{check?'返回中文解读':'内部核对版'}</Link></div></nav>
    {check?<section className="ep-chinese-internal-check" data-reading-view="check"><h2>{hasPrivateDraft?'旧摘要提取核对记录':'英文原题与文献信息'}</h2><p>{hasPrivateDraft?'以下保留此前摘要提取的原值与核对状态。本次全文解读独立保存，未改写旧模型结果。':'本篇中文解读的原题与书目如下；正文中的 AB / FT 引用可查看已保存的原文依据。'}</p>{checkContent}</section>
      :<div className="ep-chinese-reading-layout"><aside className="ep-chinese-reading-outline"><span>本篇解读</span><nav aria-label="正文目录">{headings.map((heading,index)=><a key={heading} href={`#reading-section-${index}`}>{heading}</a>)}</nav><p>点击正文中的 AB / FT 引用，查看摘要或新增全文依据。</p></aside>
        <article className="ep-chinese-reading-prose" data-reading-view="reading" onClick={event=>{
          const target=event.target instanceof Element?event.target.closest('a'):null,href=target?.getAttribute('href');
          if(href?.startsWith('#reading-evidence-')){event.preventDefault();setSourceId(href.slice('#reading-evidence-'.length));}
        }} dangerouslySetInnerHTML={{__html:html}}/></div>}
    <details className="ep-chinese-reading-license"><summary>来源、许可与生成说明</summary><p>{reading.license.copyright} · <a href={reading.license.url} target="_blank" rel="noopener noreferrer">{reading.license.name}</a></p><p>原作者及英文原题保留在文献信息中。正文为模型基于材料生成的中文解读与分析，原始输出已保存；来源文本与分析文字分别标示。</p><p>摘要引用标为 AB，新增正文引用标为 FT。模型：{reading.model}。</p></details>
    <dialog ref={dialog} className="ep-reading-source-dialog" aria-labelledby="ep-reading-source-title" onCancel={()=>setSourceId(null)} onClose={()=>setSourceId(null)}>
      {source && <><div className="ep-reading-source-heading"><div><span>{source.id} · {source.scope==='abstract'?'已保存摘要':'新增全文依据'}</span><h2 id="ep-reading-source-title">{source.label}</h2></div><button type="button" onClick={close} aria-label="关闭原文依据"><XIcon size={20}/></button></div>
        <p className="ep-reading-source-intro">此处显示实际提供给模型的来源片段，供核对中文正文。</p><blockquote lang="en" data-evidence-source-id={source.id}>{source.text}</blockquote>
        <a className="ep-reading-source-link" href={source.sourceUrl} target="_blank" rel="noopener noreferrer">在原始来源中查证<ArrowUpRightIcon size={16}/></a><button className="ep-reading-source-close" type="button" onClick={close}>返回阅读</button></>}
    </dialog>
  </div>;
}
