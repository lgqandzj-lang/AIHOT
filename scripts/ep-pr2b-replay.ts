// Offline saved-response entry point. Deliberately has no execution/model/DB imports.
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { replayExtractionResponse } from '../packages/backend/src/research/extraction-replay.ts';
import type { ReplayInput } from '../packages/backend/src/research/extraction-replay.ts';
import { stableJson } from '../packages/backend/src/lib/ids.ts';

const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const inside = (root:string,target:string) => {const relative=path.relative(root,target);return !!relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
export async function replayPrivatePath(root:string,value:string) {
  const workspace=await realpath(root); const directory=await realpath(path.resolve(root,'.data'));
  const target=await realpath(path.resolve(root,value));
  if(!inside(workspace,directory)||!inside(directory,target)||path.extname(target)!=='.json') throw new Error('Replay input must be a private JSON file within this workspace .data.');
  return target;
}
export interface ReplayPricing {
  currency:string; officialUrl:string; verifiedAt:string; model:string;
  peak:{cacheMissInputPerMillion:number;cacheHitInputPerMillion:number;outputPerMillion:number};
  offPeak?:{cacheMissInputPerMillion:number;cacheHitInputPerMillion:number;outputPerMillion:number};
}
/** Historical estimate, never a supplier invoice or refreshed price check. */
export function replayCostRecord(request:Record<string,unknown>,receipt:Record<string,unknown>,pricing:ReplayPricing,
  ledger?:{receipt?:{created_at?:string;request_model?:unknown;response_model?:unknown;cost?:number|null}}) {
  const body=request.body as Record<string,unknown>;
  const response=receipt.response as {model?:unknown;created?:unknown;usage?:Record<string,unknown>};
  const usage=receipt.usage as Record<string,unknown>|undefined ?? response.usage;
  const count=(key:string) => typeof usage?.[key]==='number'&&Number.isSafeInteger(usage[key])&&usage[key]>=0?usage[key] as number:null;
  const input=count('prompt_tokens'); const output=count('completion_tokens');
  const hit=count('prompt_cache_hit_tokens'); const miss=count('prompt_cache_miss_tokens');
  const estimate=(rates:ReplayPricing['peak']) => {
    if(input===null||output===null||Object.values(rates).some(value=>!Number.isFinite(value)||value<0)) return null;
    // No inferred cache discount. A verified complete hit/miss partition can use it.
    const cached=hit!==null&&miss!==null&&hit+miss===input?hit:0;
    return ((input-cached)*rates.cacheMissInputPerMillion+cached*rates.cacheHitInputPerMillion+output*rates.outputPerMillion)/1_000_000;
  };
  const actual=typeof receipt.cost==='number'&&Number.isFinite(receipt.cost)?receipt.cost:null;
  const calledAt=ledger?.receipt?.created_at??receipt.created_at;
  return {request_model:body.model??null,response_model:response.model??null,
    called_at:typeof calledAt==='string'?calledAt:typeof response.created==='number'?new Date(response.created*1000).toISOString():null,
    called_at_basis:typeof calledAt==='string'?'saved_database_receipt_created_at (reservation before send)':'provider_response_created; request start unavailable in saved export',
    provider_response_created:typeof response.created==='number'?new Date(response.created*1000).toISOString():null,
    pricing_basis_url:pricing.officialUrl,pricing_verified_at:pricing.verifiedAt,
    checked_at:new Date().toISOString(),currency:pricing.currency,
    cost_estimated:{peak:estimate(pricing.peak),off_peak:pricing.offPeak?estimate(pricing.offPeak):null,source:'saved reported usage and historical price snapshot'},
    cost_actual:actual,cost_actual_currency:actual===null?null:'not_recorded_in_receipt',
    cost_actual_note:actual===null?'Unknown supplier deduction; null is not zero.':'Original receipt value; currency requires invoice reconciliation.',
    price_snapshot_refreshed:false,new_paid_requests:0};
}
export async function extractionReplayCli(args=process.argv.slice(2)) {
  const {values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
    request:{type:'string'},receipt:{type:'string'},input:{type:'string'},failure:{type:'string'},pricing:{type:'string'},'receipt-meta':{type:'string'},'review-notes':{type:'string'},'out-dir':{type:'string'},
  }});
  if(positionals.length||!values.request||!values.receipt||!values.input||!values.failure||!values.pricing) throw new Error('Supply saved --request, --receipt, --input, --failure and --pricing private JSON files.');
  process.env.MODEL_CALLS_ENABLED='false'; process.env.COLLECT_ENABLED='false'; process.env.INDEXNOW_SUBMIT_ENABLED='false';
  for(const key of Object.keys(process.env)) if(/^FEISHU_.*_ENABLED$/.test(key)) process.env[key]='false';
  const originals:Record<string,{path:string;text:string;sha256:string}>={};
  for(const name of ['request','receipt','input','failure','pricing'] as const) {
    const filename=await replayPrivatePath(process.cwd(),values[name]!);
    const text=await readFile(filename,'utf8');
    if(Buffer.byteLength(text)>2_000_000) throw new Error('Saved replay input exceeds its local size limit.');
    originals[name]={path:filename,text,sha256:hash(text)};
  }
  let historicalReview:unknown=null;
  if(values['review-notes']) {
    const filename=await replayPrivatePath(process.cwd(),values['review-notes']);const text=await readFile(filename,'utf8');
    if(Buffer.byteLength(text)>2_000_000) throw new Error('Historical private comparison exceeds its local size limit.');
    originals.review={path:filename,text,sha256:hash(text)};
    const saved=JSON.parse(text);
    historicalReview={basis:'historical_assistant_source_comparison; not human confirmation and never model-supplied evidence',
      checkedAt:saved.checkedAt??null,humanConfirmationRequired:true,rows:saved.rows??[],omissions:saved.omissions??[]};
  }
  let ledger:Parameters<typeof replayCostRecord>[3];
  if(values['receipt-meta']) {
    const filename=await replayPrivatePath(process.cwd(),values['receipt-meta']);const text=await readFile(filename,'utf8');
    if(Buffer.byteLength(text)>100_000) throw new Error('Saved receipt metadata exceeds its local size limit.');
    originals.ledger={path:filename,text,sha256:hash(text)};ledger=JSON.parse(text);
  }
  const request=JSON.parse(originals.request.text); const receipt=JSON.parse(originals.receipt.text);
  const savedInput=JSON.parse(originals.input.text); const failure=JSON.parse(originals.failure.text);
  const body=request.body as {model?:unknown;messages?:unknown;response_format?:unknown;max_tokens?:unknown};
  if(request.bodyHash!==hash(stableJson(body))) throw new Error('Saved final request hash mismatch.');
  const expectedMessages=[{role:'system',content:savedInput.system},{role:'user',content:savedInput.user}];
  if(JSON.stringify(body.messages)!==JSON.stringify(expectedMessages)||JSON.stringify(JSON.parse(savedInput.user))!==JSON.stringify(savedInput.input)) throw new Error('Saved request and provided-input manifest differ.');
  const choice=receipt.response?.choices?.[0];
  if(typeof choice?.message?.content!=='string') throw new Error('Saved receipt has no textual model response.');
  const raw=JSON.parse(choice.message.content);
  const legacyResponse=typeof savedInput.system==='string'&&savedInput.system.includes('schemaVersion "ep-abstract-extract-v1"');
  const replay=replayExtractionResponse(raw,savedInput.input as ReplayInput,{legacyResponse});
  const pricing=JSON.parse(originals.pricing.text) as ReplayPricing;
  if(pricing.model!==body.model) throw new Error('Saved price snapshot is for another request model.');
  if(ledger?.receipt&&(ledger.receipt.request_model!==body.model||ledger.receipt.response_model!==receipt.response.model||ledger.receipt.cost!==receipt.cost)) throw new Error('Saved ledger metadata differs from the original receipt.');
  const cost=replayCostRecord(request,receipt,pricing,ledger);
  const directory=path.resolve(values['out-dir']??`.data/ep-pr2b/replay-${randomUUID()}`);
  const privateRoot=await realpath(path.resolve('.data'));
  const parent=await realpath(path.dirname(directory));
  if(!inside(privateRoot,directory)||!inside(privateRoot,parent)||!/^replay-[a-z0-9-]+$/i.test(path.basename(directory))) throw new Error('A fresh replay-* output directory inside .data is required.');
  await mkdir(directory); // EEXIST deliberately prevents any overwrite of a prior replay or original output.
  const metadata={checkedAt:new Date().toISOString(),newModelCalls:0,requestModel:body.model,responseModel:receipt.response.model??null,
    responseFormat:body.response_format,finalOutputCap:body.max_tokens,finishReason:choice.finish_reason??null,
    truncationAssessment:choice.finish_reason==='length'?'provider_reports_length_limit':choice.finish_reason==='stop'?'provider_reports_stop; completeness still requires source review':'unknown',
    originalFailure:{formatStatus:failure.formatStatus,issues:failure.issues},originalFormatErrors:replay.originalFormatErrors,
    originalFileHashes:Object.fromEntries(Object.entries(originals).map(([name,file])=>[name,{path:file.path,sha256:file.sha256}]))};
  const put=(name:string,value:unknown) => writeFile(path.join(directory,name),JSON.stringify(value,null,2),{encoding:'utf8',flag:'wx'});
  await put('replay.json',{metadata,...replay}); await put('normalized-candidate.json',replay.candidate);
  await put('transformations.json',replay.transformations); await put('cost-record.json',cost);
  if(historicalReview) await put('historical-source-comparison.json',historicalReview);
  const escape=(value:unknown)=>String(typeof value==='string'?value:JSON.stringify(value)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>');
  const lines=replay.after.map(row=>`| ${escape(row.path)} | ${escape(row.expected)} | ${escape(replay.before.find(item=>item.path===row.path)?.actualShape)} → ${escape(row.actualShape)} | ${escape(row.formatErrors)} | ${escape(row.citationStatus+': '+row.citationErrors.join(', '))} | ${escape(row.contentIssues)}；语义未核查，不能形成已审核字段 |`);
  const prior=historicalReview as {rows:Array<{path:unknown;support:unknown;reason:unknown;sourceComparisonIsModelCitation?:boolean}>;omissions:Array<{field:unknown;modelOutput:unknown}>}|null;
  const reviewText=prior?`\n## 历史助手原文对照（未作为模型引用或人工批准）\n\n| 字段 | 历史支持观察 | 缺失/限制 |\n|---|---|---|\n${prior.rows.map(row=>`| ${escape(row.path)} | ${escape(row.support)} | ${escape(row.reason)}；原文补链属于模型引用：${row.sourceComparisonIsModelCitation===true?'是':'否'} |`).join('\n')}\n\n## 内容遗漏（单独记录；未填入规范化草稿）\n\n${prior.omissions.map(row=>`- ${escape(row.field)}：${escape(row.modelOutput)}`).join('\n')}\n\n完整旧对照及原文依据保存在 historical-source-comparison.json；需人类复核。旧版建议不适用于新版契约时，仅作为历史记录保留。\n`:'';
  await writeFile(path.join(directory,'comparison.md'),`# 私有原始响应离线回放\n\n新请求 0；原始请求、响应与失败记录只读。规范化草稿状态：${replay.state}。本次不验证新提示词的真实模型效果。\n\n输出格式：${escape(body.response_format)}；最终输出上限：${escape(body.max_tokens)}；finish_reason：${escape(choice.finish_reason)}。长度与完整性判断依据终止原因及 JSON/字段检查，不能从 token 数单独判断。\n\n| 字段 | 期望结构 | 原结构 → 规范化结构 | 格式错误 | 引用错误 | 内容/资格限制 |\n|---|---|---|---|---|---|\n${lines.join('\n')}\n${reviewText}`,{encoding:'utf8',flag:'wx'});
  for(const file of Object.values(originals)) if(hash(await readFile(file.path,'utf8'))!==file.sha256) throw new Error('Original changed during read-only replay.');
  console.log(JSON.stringify({directory,newModelCalls:0,originalFormatValid:replay.originalFormatValid,normalizedFormatValid:replay.normalizedFormatValid,
    state:replay.state,transformations:replay.transformations.length,fields:replay.after.length,
    missingCitations:replay.after.filter(row=>row.citationStatus==='missing').length,
    contentIssueCodes:[...new Set(replay.contentIssues.map(item=>item.code))],qualified:false,realModelEffectValidated:false,
    originalFilesUnchanged:true,cost},null,2));
  return 0; // Successful replay of a rejected output is not successful extraction.
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {process.exitCode=await extractionReplayCli();}
  catch {console.error('Offline replay stopped; no request or automatic retry. Inspect only the local saved inputs.');process.exitCode=2;}
}
