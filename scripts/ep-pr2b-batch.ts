// Private A/B/C execution through the existing trial/receipt path. No recovery.
import { open, readFile, rename, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sha256, stableJson } from '../packages/backend/src/lib/ids.ts';
import { localExtractionDatabase } from './ep-pr2b-extract-one.ts';

export type BatchCaseName = 'A'|'B'|'C';
export interface BatchSlot { case: BatchCaseName; upperBoundMicros: number }
export interface BatchSend { case: BatchCaseName; state: string; [key: string]: unknown }
export interface BatchLedger {
  batchId: string; currency: string; authorizedMicros: number; maxActualRequests: number;
  cumulativeConsumedRequests: number; reservedMicros: number; state: string; sends?: BatchSend[];
  [key: string]: unknown;
}
export function checkBatchBudget(ledger: BatchLedger, slots: BatchSlot[]) {
  if (!ledger.batchId || ledger.currency!=='CNY' || ledger.authorizedMicros!==1_000_000 || ledger.maxActualRequests!==3
    || !Number.isSafeInteger(ledger.cumulativeConsumedRequests) || ledger.cumulativeConsumedRequests<0 || ledger.cumulativeConsumedRequests>3
    || !Number.isSafeInteger(ledger.reservedMicros) || ledger.reservedMicros<0 || ledger.reservedMicros>ledger.authorizedMicros
    || slots.length!==3 || slots.map(v=>v.case).join(',')!=='A,B,C'
    || slots.some(v=>!Number.isSafeInteger(v.upperBoundMicros)||v.upperBoundMicros<=0)) throw new Error('Invalid fixed batch limits or case order');
  const sends=ledger.sends??[];
  if(sends.length!==ledger.cumulativeConsumedRequests || sends.some((send,index)=>send.case!==slots[index]?.case)) throw new Error('Cumulative execution ledger mismatch');
  const total=slots.reduce((sum,v)=>sum+BigInt(v.upperBoundMicros),0n);
  if(total>BigInt(ledger.authorizedMicros)) throw new Error('Whole-batch fee ceiling exceeds the original authorization');
  return Number(total);
}
/** Conservative consumption is persisted before the existing DB claim/network. */
export function consumeBatchSlot(ledger: BatchLedger, slots: BatchSlot[], name: BatchCaseName): BatchLedger {
  const ceiling=checkBatchBudget(ledger,slots);
  if(!['ready','in_progress'].includes(ledger.state) || ledger.cumulativeConsumedRequests>=3
    || slots[ledger.cumulativeConsumedRequests]?.case!==name
    || (ledger.sends??[]).some(v=>v.state==='attempting'||v.state==='unknown')) throw new Error('Batch cannot repeat, skip or overlap a request');
  return {...ledger,state:'in_progress',reservedMicros:ceiling,cumulativeConsumedRequests:ledger.cumulativeConsumedRequests+1,
    sends:[...(ledger.sends??[]),{case:name,state:'attempting'}]};
}
export function shouldStopBatch(name: BatchCaseName, originalFormatValid: boolean, trialState: string) {
  return ['unknown','in_flight','rejected'].includes(trialState) || (name==='A'&&!originalFormatValid);
}
/** A crash leaves the lock in place; this entry never clears another run's lock. */
export async function withBatchLock<T>(directory: string, action: ()=>Promise<T>): Promise<T> {
  const target=path.join(directory,'execution.lock');
  const lock=await open(target,'wx');
  try {await lock.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));await lock.sync();return await action();}
  finally {await lock.close();await unlink(target);}
}
export async function saveBatchLedger(directory: string, ledger: object) {
  const temporary=path.join(directory,'.batch-state-'+randomUUID()+'.tmp');
  const file=await open(temporary,'wx');
  try{await file.writeFile(JSON.stringify(ledger,null,2),'utf8');await file.sync();}finally{await file.close();}
  await rename(temporary,path.join(directory,'batch-state.json'));
}
export async function privateBatchDirectory(root: string, value: string) {
  const data=await realpath(path.resolve(root,'.data'));
  const directory=await realpath(path.resolve(root,value));
  const relative=path.relative(data,directory);
  if(!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Batch must be an existing private .data directory');
  return directory;
}
export function estimatedBatchFee(usage: Record<string,unknown>|null) {
  const input=usage?.prompt_tokens,output=usage?.completion_tokens;
  const details=usage?.prompt_tokens_details as Record<string,unknown>|undefined;
  const hit=usage?.prompt_cache_hit_tokens??details?.cached_tokens??0;
  if(![input,output,hit].every(v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0) || (hit as number)>(input as number)) return null;
  const miss=(input as number)-(hit as number);
  return {currency:'CNY',peakEstimated:(miss*2+(hit as number)*0.04+(output as number)*8)/1_000_000,
    offPeakEstimated:(miss+(hit as number)*0.02+(output as number)*4)/1_000_000,
    actualDeduction:null,actualDeductionStatus:'not_supplied_or_reconciled',basis:'Observed token usage times official snapshot rates; estimates are not a provider invoice.'};
}

export async function extractionBatchCli(args=process.argv.slice(2)) {
  const {values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{directory:{type:'string'},'execute-once':{type:'boolean'}}});
  if(positionals.length || !values.directory || !values['execute-once']) throw new Error('Supply --directory and --execute-once');
  const directory=await privateBatchDirectory(process.cwd(),values.directory);
  const readJson=async(name:string)=>JSON.parse(await readFile(path.join(directory,name),'utf8'));
  const plan=await readJson('execution-plan.json');
  localExtractionDatabase(process.env.DATABASE_URL);
  if(new URL(process.env.DATABASE_URL!).pathname.slice(1)!==plan.database || !/^(true|1)$/i.test(process.env.MODEL_CALLS_ENABLED??'')) throw new Error('Wrong private test DB or one-run model valve is closed');
  process.env.COLLECT_ENABLED='false';process.env.INDEXNOW_SUBMIT_ENABLED='false';
  for(const name of Object.keys(process.env))if(/^FEISHU_.*_ENABLED$/.test(name))process.env[name]='false';
  const {sql,closeDb}=await import('../packages/backend/src/db.ts');
  const {researchDatabase}=await import('../packages/backend/src/research/postgres.ts');
  const {prepareExtractionRequest,executeExtractionTrial}=await import('../packages/backend/src/research/abstract-extraction.ts');
  const {trialPreflight,reserveExtractionTrial}=await import('../packages/backend/src/research/extraction-budget.ts');
  const {validateCompactExtraction}=await import('../packages/backend/src/research/extraction-validation.ts');
  const {credential}=await import('../packages/backend/src/config.ts');
  const {EXTRACTION_OUTPUT_TOKENS}=await import('../packages/backend/src/research/extraction-schema.ts');
  const db=researchDatabase(sql);
  const writeJson=async(name:string,value:unknown)=>{
    const file=await open(path.join(directory,name),'wx');
    try{await file.writeFile(JSON.stringify(value,null,2),'utf8');await file.sync();}finally{await file.close();}
  };
  const verifyFrozenFiles=async()=>{
    for(const [relative,expected] of Object.entries(plan.frozenFiles)){
      const file=path.resolve(process.cwd(),relative),within=path.relative(process.cwd(),file);
      if(within.startsWith('..')||path.isAbsolute(within)||sha256(await readFile(file,'utf8'))!==expected) throw new Error('Frozen rule/input changed');
    }
  };
  try {
    return await withBatchLock(directory,async()=>{
      let ledger:BatchLedger=await readJson('batch-state.json');
      const slots:BatchSlot[]=plan.cases;
      if(ledger.batchId!==plan.batchId || ledger.planHash!==sha256(stableJson(plan)) || ledger.cumulativeConsumedRequests!==0 || ledger.state!=='ready') throw new Error('Batch already began or manifest identity changed; no restart/resend');
      checkBatchBudget(ledger,slots);await verifyFrozenFiles();
      if(!credential('models','DEEPSEEK_API_KEY')) throw new Error('The configured model credential is unavailable');
      const prepared=[];
      for(const entry of plan.cases){
        const value=await prepareExtractionRequest(db,entry.bundleId,'deepseek-flash');
        const approval=await readJson(entry.case+'-approval.json');
        if(approval.authorizationKey!==ledger.batchId+':'+entry.case || value.request.bodyHash!==entry.requestHash
          || value.request.baseUrl!=='https://api.deepseek.com' || value.request.modelName!=='deepseek-flash'
          || plan.outputCap!==EXTRACTION_OUTPUT_TOKENS || value.request.body.max_tokens!==plan.outputCap || stableJson(value.request.body.thinking)!==stableJson({type:'disabled'})
          || stableJson(value.request.body.response_format)!==stableJson({type:'json_object'})) throw new Error('Final material/model/slot configuration changed');
        const check=trialPreflight(value.bundle,value.request,approval);
        if(!check.ready || check.upperBoundMicros!==entry.upperBoundMicros) throw new Error('Case pricing/material authorization no longer matches');
        prepared.push({entry,value,approval});
      }
      if(new Set(prepared.map(v=>v.value.system)).size!==1) throw new Error('Cases do not share the frozen prompt');
      const prior=await sql`SELECT execution_count FROM ep_research_extraction_trials WHERE authorization_key LIKE ${ledger.batchId+':%'} AND execution_count<>0`;
      if(prior.length) throw new Error('Original batch DB execution was already consumed; ledger cannot reset it');
      const trials=[];
      for(const item of prepared)trials.push(await reserveExtractionTrial(db,item.value.bundle,item.value.request,item.approval));
      for(const [index,item]of prepared.entries()){
        await verifyFrozenFiles();
        ledger=consumeBatchSlot(ledger,slots,item.entry.case);
        await saveBatchLedger(directory,ledger);
        const send=ledger.sends![index]!;
        try {
          const draft=await executeExtractionTrial(db,trials[index]!.id,{enableRealRequest:true,timeoutMs:120_000});
          const [trial]=await sql`SELECT id,state,execution_count,receipt_id,reserved_micros FROM ep_research_extraction_trials WHERE id=${trials[index]!.id}`;
          const [row]=await sql`SELECT raw_output,format_status,citation_status,semantic_status,state,issues FROM ep_research_extraction_drafts WHERE id=${draft.id}`;
          const [receipt]=draft.receiptId===null?[]:await sql`SELECT id,status,attempts,retry_policy,usage,cost,currency,cost_basis,response,created_at::text FROM receipts WHERE id=${draft.receiptId}`;
          await writeJson(item.entry.case+'-provider-receipt.json',receipt??null);
          await writeJson(item.entry.case+'-raw-output.json',row?.raw_output??null);
          const checked=validateCompactExtraction(row?.raw_output??null,item.value.input,
            {finishReason:receipt?.response?.choices?.[0]?.finish_reason,outputTokens:receipt?.usage?.completion_tokens,maxTokens:plan.outputCap});
          const replay={originalFormatValid:checked.formatStatus==='valid',normalizedFormatValid:checked.formatStatus==='valid'};
          const structural={...checked,...replay,transformations:[],semanticStatus:'not_evaluated'};
          await writeJson(item.entry.case+'-structure-report.json',structural);
          const fee=estimatedBatchFee(receipt?.usage??null);
          const outcome={case:item.entry.case,trialId:trial!.id,draftId:draft.id,receiptId:draft.receiptId,
            actualCall:!!receipt?.attempts,actualNetworkAttempts:receipt?.attempts??0,trial,processingRecord:row,
            originalFormatValid:replay.originalFormatValid,normalizedFormatValid:replay.normalizedFormatValid,
            citationIdentityStatus:draft.citationStatus,semanticStatus:'not_evaluated',qualified:false,
            inputTokens:receipt?.usage?.prompt_tokens??null,outputTokens:receipt?.usage?.completion_tokens??null,
            usage:receipt?.usage??null,fee,receiptCost:receipt?.cost??null,
            finishReason:receipt?.response?.choices?.[0]?.finish_reason??null,providerRequestId:receipt?.response?.id??null,
            requestHash:item.value.request.bodyHash,materialHash:item.value.bundle.materialHash,completedAt:new Date().toISOString()};
          await writeJson(item.entry.case+'-execution.json',outcome);
          Object.assign(send,{state:trial!.state,...outcome});
          ledger.actualRequests=(ledger.sends??[]).reduce((n,v)=>n+Number(v.actualNetworkAttempts??0),0);
          if(shouldStopBatch(item.entry.case,replay.originalFormatValid,trial!.state)){
            ledger.state='stopped';ledger.stopReason=item.entry.case==='A'&&!replay.originalFormatValid?'A_original_structure_invalid':'permission_budget_or_unknown_outcome';
          }
          await saveBatchLedger(directory,ledger);
          console.log(JSON.stringify({case:item.entry.case,actualCall:outcome.actualCall,receiptId:draft.receiptId,
            originalFormatValid:replay.originalFormatValid,normalizedFormatValid:replay.normalizedFormatValid,
            semanticStatus:'not_evaluated',inputTokens:outcome.inputTokens,outputTokens:outcome.outputTokens,
            state:ledger.state,cumulativeConsumedRequests:ledger.cumulativeConsumedRequests}));
          if(ledger.state==='stopped')break;
        }catch(error){
          send.state='unknown';ledger.state='stopped_error';ledger.stopReason='Execution/export outcome requires reconciliation; never resend';
          await saveBatchLedger(directory,ledger);throw error;
        }
      }
      if(ledger.state==='in_progress'){ledger.state='completed';await saveBatchLedger(directory,ledger);}
      return {batchId:ledger.batchId,state:ledger.state,cumulativeConsumedRequests:ledger.cumulativeConsumedRequests,actualRequests:ledger.actualRequests??0};
    });
  }finally{process.env.MODEL_CALLS_ENABLED='false';await closeDb();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  extractionBatchCli().then(value=>console.log(JSON.stringify(value))).catch(error=>{
    console.error('Private batch stopped: '+(error instanceof Error?error.name:'unknown error')+'. Inspect private records; no automatic resend.');process.exitCode=1;
  });
}
