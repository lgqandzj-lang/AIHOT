// Identifier -> frozen official abstract -> existing extraction/receipt path -> private DB card.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256, stableJson } from '../packages/backend/src/lib/ids.ts';
import { normalizeDoi } from '../packages/backend/src/research/normalize.ts';
import { localExtractionDatabase, rawExtractionDiagnosticRows } from './ep-pr2b-extract-one.ts';
import { withBatchLock, saveBatchLedger, privateBatchDirectory } from './ep-pr2b-batch.ts';
export interface NewLiteratureLedger {
  batchId:string;currency:string;authorizedMicros:number;maxActualRequests:number;cumulativeConsumedRequests:number;
  reservedMicros:number;state:string;sends?:Array<{case:string;state:string;[key:string]:unknown}>;[key:string]:unknown;
}

type NewCase = { key:string; pmid:string; doi:string; family:string; materialId:string; recordId:string;
  bundleId:string; requestHash:string; upperBoundMicros:number; metadataHash:string; processingAllowed:boolean };
export function newPaperArguments(args:string[]) {
  const {values,positionals} = parseArgs({args,strict:true,allowPositionals:true,options:{directory:{type:'string'},'execute-once':{type:'boolean'}}});
  if (positionals.length!==2 || !['prepare','run'].includes(positionals[0]??'') || !values.directory
    || positionals[0]==='run' && !values['execute-once'] || positionals[0]==='prepare' && values['execute-once']) throw new Error('Use prepare|run DOI/PMID --directory private-batch; run also requires --execute-once');
  const input = positionals[1]!;
  const identifier = /^[1-9][0-9]{0,11}$/.test(input)?{pmid:input}:normalizeDoi(input)?{doi:normalizeDoi(input)!}:null;
  if (!identifier) throw new Error('One valid DOI or PMID is required');
  return {mode:positionals[0] as 'prepare'|'run',identifier,directory:values.directory};
}
export function checkNewLiteratureBudget(ledger:NewLiteratureLedger,cases:Array<{key:string;pmid:string;doi:string;upperBoundMicros:number}>) {
  const sends = ledger.sends??[];
  if (!ledger.batchId || ledger.currency!=='CNY' || ledger.authorizedMicros!==1_000_000 || ledger.maxActualRequests!==3
    || cases.length!==3 || new Set(cases.map(item=>item.key)).size!==3 || new Set(cases.map(item=>item.pmid)).size!==3
    || new Set(cases.map(item=>item.doi)).size!==3 || !Number.isSafeInteger(ledger.cumulativeConsumedRequests)
    || ledger.cumulativeConsumedRequests<0 || ledger.cumulativeConsumedRequests>3 || sends.length!==ledger.cumulativeConsumedRequests
    || sends.some((send,index)=>String(send.case)!==cases[index]?.key)
    || cases.some(item=>!Number.isSafeInteger(item.upperBoundMicros)||item.upperBoundMicros<=0)) throw new Error('Invalid fixed three-paper budget/identity ledger');
  const ceiling = cases.reduce((sum,item)=>sum+BigInt(item.upperBoundMicros),0n);
  if (ceiling>1_000_000n) throw new Error('The three-paper fee ceiling exceeds CNY 1');
  return Number(ceiling);
}
export function consumeNewLiteratureSlot(ledger:NewLiteratureLedger,cases:NewCase[],key:string):NewLiteratureLedger {
  const ceiling = checkNewLiteratureBudget(ledger,cases);
  if (!['ready','in_progress'].includes(ledger.state) || ledger.cumulativeConsumedRequests>=3
    || cases[ledger.cumulativeConsumedRequests]?.key!==key || (ledger.sends??[]).some(send=>['attempting','unknown','in_flight','rejected'].includes(send.state))) throw new Error('Cannot repeat, skip, overlap or restart a consumed paper request');
  return {...ledger,state:'in_progress',reservedMicros:ceiling,cumulativeConsumedRequests:ledger.cumulativeConsumedRequests+1,
    sends:[...(ledger.sends??[]),{case:key,state:'attempting'}]};
}
export const stopNewLiteratureAfter = (trialState:string) => ['unknown','in_flight','rejected'].includes(trialState);

/** An independent, one-paper grant cannot reuse or reset a previous batch's slots. */
export function consumeSingleLiteratureSlot(ledger:NewLiteratureLedger,key:string,upperBoundMicros:number):NewLiteratureLedger {
  if (!ledger.batchId || ledger.currency!=='CNY' || ledger.authorizedMicros!==1_000_000 || ledger.maxActualRequests!==1
    || ledger.cumulativeConsumedRequests!==0 || (ledger.sends??[]).length!==0 || ledger.state!=='ready' || ledger.reservedMicros!==0
    || !Number.isSafeInteger(upperBoundMicros) || upperBoundMicros<=0 || upperBoundMicros>ledger.authorizedMicros) throw new Error('Single-paper grant is consumed, invalid or over budget');
  return {...ledger,state:'in_progress',reservedMicros:upperBoundMicros,cumulativeConsumedRequests:1,sends:[{case:key,state:'attempting'}]};
}

async function savedSinglePaper(options:ReturnType<typeof newPaperArguments>,directory:string,policy:Record<string,any>) {
  const readJson=async(name:string)=>JSON.parse((await readFile(path.join(directory,name),'utf8')).replace(/^\uFEFF/,''));
  const put=async(name:string,value:unknown)=>writeFile(path.join(directory,name),JSON.stringify(value,null,2),{encoding:'utf8',flag:'wx'});
  if (policy.cases?.length!==1 || policy.maxActualRequests!==1 || policy.currency!=='CNY' || policy.authorizedMicros!==1_000_000
    || new URL(process.env.DATABASE_URL!).pathname.slice(1)!==policy.database) throw new Error('Invalid saved single-paper policy');
  const source=policy.cases[0];
  if (('pmid' in options.identifier?source.pmid!==options.identifier.pmid:source.doi!==options.identifier.doi) || !source.processingAllowed
    || !Number.isSafeInteger(source.outputTokenCap) || source.outputTokenCap<512 || source.outputTokenCap>8192) throw new Error('Identifier, permission or per-request cap is outside the saved policy');
  const {sql,closeDb}=await import('../packages/backend/src/db.ts');
  const {researchDatabase}=await import('../packages/backend/src/research/postgres.ts');
  const {prepareExtractionRequest,executeExtractionTrial,extractionFieldReport}=await import('../packages/backend/src/research/abstract-extraction.ts');
  const {trialPreflight,reserveExtractionTrial}=await import('../packages/backend/src/research/extraction-budget.ts');
  const {validateStructuredExtraction}=await import('../packages/backend/src/research/extraction-validation.ts');
  const {registerPrivateReading}=await import('../packages/backend/src/research/private-reading.ts');
  const {credential}=await import('../packages/backend/src/config.ts');
  const db=researchDatabase(sql);
  try {
    const metadata=await readJson(source.key+'-pubmed-metadata.json');
    const savedBundle=await readJson(source.key+'-material-bundle.json');
    const prepared=await prepareExtractionRequest(db,source.bundleId,'deepseek-flash',{outputTokenCap:source.outputTokenCap});
    const [material]=await sql`SELECT record_id::text,metadata FROM ep_research_materials WHERE id=${source.materialId}`;
    if (metadata.pmid!==source.pmid || metadata.doi!==source.doi || sha256(stableJson(metadata))!==source.metadataHash
      || !material || material.record_id!==source.recordId || stableJson(material.metadata)!==stableJson(metadata)
      || stableJson(prepared.bundle)!==stableJson(savedBundle) || prepared.bundle.materialId!==source.materialId
      || prepared.request.baseUrl!=='https://api.deepseek.com' || prepared.request.modelName!=='deepseek-flash'
      || prepared.request.body.max_tokens!==source.outputTokenCap || !credential('models','DEEPSEEK_API_KEY')
      || stableJson(prepared.request.body.thinking)!==stableJson({type:'disabled'})
      || stableJson(prepared.request.body.response_format)!==stableJson({type:'json_object'})) throw new Error('Saved material or official non-thinking request changed');
    if (options.mode==='prepare') {
      await put(source.key+'-final-request.json',prepared.request);
      await put(source.key+'-provided-input.json',{system:prepared.system,user:prepared.user,input:prepared.input});
      return {state:'prepared',bundleId:source.bundleId,requestHash:prepared.request.bodyHash,outputTokenCap:source.outputTokenCap,actualRequests:0};
    }
    return await withBatchLock(directory,async()=>{
      const plan=await readJson('execution-plan.json'),approval=await readJson(source.key+'-approval.json');
      let ledger:NewLiteratureLedger=await readJson('batch-state.json');
      if (ledger.batchId!==plan.batchId || ledger.planHash!==sha256(stableJson(plan)) || plan.sourcePolicyHash!==sha256(stableJson(policy))
        || plan.requestHash!==prepared.request.bodyHash || approval.authorizationKey!==ledger.batchId+':'+source.pmid) throw new Error('Single-paper authorization/request identity changed');
      for (const [relative,digest] of Object.entries(plan.frozenFiles)) {
        const file=path.resolve(process.cwd(),relative),within=path.relative(process.cwd(),file);
        if (within.startsWith('..') || path.isAbsolute(within) || sha256(await readFile(file))!==digest) throw new Error('Frozen source, prompt or execution code changed');
      }
      const executed=await sql`SELECT id FROM ep_research_extraction_trials WHERE authorization_key=${approval.authorizationKey} AND execution_count<>0`;
      if (executed.length) throw new Error('This independent single-paper request is already consumed');
      const check=trialPreflight(prepared.bundle,prepared.request,approval);
      if (!check.ready || check.upperBoundMicros!==plan.upperBoundMicros || approval.authorizedMicros!==ledger.authorizedMicros) throw new Error('Single-paper fee/permission preflight failed');
      ledger=consumeSingleLiteratureSlot(ledger,source.key,check.upperBoundMicros!);await saveBatchLedger(directory,ledger);
      const startedAt=new Date().toISOString(),started=performance.now();
      try {
        const trial=await reserveExtractionTrial(db,prepared.bundle,prepared.request,approval);
        const draft=await executeExtractionTrial(db,trial.id,{enableRealRequest:true,outputTokenCap:source.outputTokenCap,timeoutMs:120_000});
        const [receipt]=draft.receiptId===null?[]:await sql`SELECT * FROM receipts WHERE id=${draft.receiptId}`;
        const [trialRow]=await sql`SELECT id,state,execution_count,receipt_id,reserved_micros FROM ep_research_extraction_trials WHERE id=${trial.id}`;
        const [draftRow]=await sql`SELECT * FROM ep_research_extraction_drafts WHERE id=${draft.id}`;
        const envelope=receipt?.response,content=envelope?.choices?.[0]?.message?.content;
        const checked=validateStructuredExtraction(draftRow?.raw_output??null,prepared.input,{finishReason:envelope?.choices?.[0]?.finish_reason});
        await put(source.key+'-provider-receipt.json',receipt??null);await put(source.key+'-draft.json',draftRow);
        if(typeof content==='string')await writeFile(path.join(directory,source.key+'-raw-response.txt'),content,{encoding:'utf8',flag:'wx'});
        await put(source.key+'-raw-output.json',draftRow?.raw_output??null);await put(source.key+'-structure-report.json',checked);
        const report=await extractionFieldReport(db,draft.id);await put(source.key+'-field-report.json',report);
        const card=await registerPrivateReading(db,{materialId:source.materialId,draftId:draft.id,readerId:'draft-'+draft.id,family:source.family,
          processingAllowed:true,attribution:source.attribution,appendVersion:true});
        const usage=receipt?.usage??null,hit=usage?.prompt_cache_hit_tokens??usage?.prompt_tokens_details?.cached_tokens??0;
        const usageValid=usage && [usage.prompt_tokens,usage.completion_tokens,hit].every(v=>Number.isSafeInteger(v)&&v>=0) && hit<=usage.prompt_tokens;
        const peakEstimate=usageValid?((usage.prompt_tokens-hit)*approval.pricing.inputMicrosPerMillion+hit*40_000
          +usage.completion_tokens*approval.pricing.outputMicrosPerMillion)/1_000_000_000_000:null;
        const abnormal=!receipt || receipt.attempts!==1 || receipt.retry_policy!=='never' || stopNewLiteratureAfter(trialRow?.state)
          || envelope?.model!==prepared.request.modelName || !usageValid || usage.completion_tokens>source.outputTokenCap
          || usage.prompt_tokens>approval.pricing.inputTokenUpperBound || Number(peakEstimate)>ledger.authorizedMicros/1_000_000;
        const outcome={...card,key:source.key,pmid:source.pmid,trialId:trial.id,draftId:draft.id,receiptId:draft.receiptId,
          state:draft.state,trialState:trialRow?.state,formatStatus:checked.formatStatus,fieldCompletenessStatus:checked.fieldCompletenessStatus,
          requestHash:prepared.request.bodyHash,materialHash:prepared.bundle.materialHash,requestModel:prepared.request.modelName,responseModel:envelope?.model??null,
          actualNetworkAttempts:receipt?.attempts??0,usage,finishReason:envelope?.choices?.[0]?.finish_reason??null,outputTokenCap:source.outputTokenCap,
          fee:{currency:'CNY',upperBoundCNY:check.upperBoundMicros!/1_000_000,peakEstimated:peakEstimate,offPeakEstimated:peakEstimate===null?null:peakEstimate/2,
            actualDeduction:receipt?.cost_basis==='actual'?receipt.cost:null,actualDeductionCurrency:receipt?.cost_basis==='actual'?receipt.currency:null,
            actualDeductionStatus:receipt?.cost_basis==='actual'&&receipt.cost!=null?'provider_reported':'not_supplied_or_reconciled',basisUrl:approval.pricing.basisUrl},
          semanticReviewMethod:'not_evaluated',humanApprovalGranted:false,qualified:false,modelValuesChanged:false,
          startedAt,completedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),abnormal};
        await put(source.key+'-execution.json',outcome);
        ledger.sends=[{...outcome,case:source.key,state:trialRow?.state??'unknown'}];ledger.state=abnormal?'stopped':'completed';
        ledger.actualRequests=receipt?.attempts??0;await saveBatchLedger(directory,ledger);
        return outcome;
      } catch {
        ledger.state='stopped_system_error';ledger.sends![0].state='unknown';await saveBatchLedger(directory,ledger);
        throw new Error('One-paper execution stopped. Reconcile existing records; never resend.');
      }
    });
  }finally{process.env.MODEL_CALLS_ENABLED='false';await closeDb();}
}

export async function newPaperCli(args=process.argv.slice(2)) {
  const options = newPaperArguments(args);
  const directory = await privateBatchDirectory(process.cwd(),options.directory);
  localExtractionDatabase(process.env.DATABASE_URL);
  process.env.COLLECT_ENABLED='false';process.env.INDEXNOW_SUBMIT_ENABLED='false';
  for (const flag of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(flag)) process.env[flag]='false';
  if (options.mode==='prepare') process.env.MODEL_CALLS_ENABLED='false';
  else if (!/^(true|1)$/i.test(process.env.MODEL_CALLS_ENABLED??'')) throw new Error('One-run model valve is closed');
  const readJson = async(name:string)=>JSON.parse((await readFile(path.join(directory,name),'utf8')).replace(/^\uFEFF/,''));
  const put = async(name:string,data:unknown)=>writeFile(path.join(directory,name),JSON.stringify(data,null,2),{encoding:'utf8',flag:'wx'});
  const policy = await readJson('source-policy.json');
  if (policy.version==='saved-single-literature-v1') return savedSinglePaper(options,directory,policy);
  if (policy.version!=='new-literature-v1' || policy.cases.length!==3
    || new URL(process.env.DATABASE_URL!).pathname.slice(1)!==policy.database) throw new Error('Wrong three-paper source policy or local database');
  const source = policy.cases.find((item:{pmid:string;doi:string})=>'pmid' in options.identifier?item.pmid===options.identifier.pmid:item.doi===options.identifier.doi);
  if (!source) throw new Error('Identifier is outside the frozen three-paper scope');
  const {sql,closeDb} = await import('../packages/backend/src/db.ts');
  const {researchDatabase} = await import('../packages/backend/src/research/postgres.ts');
  const {importLiteratureMetadata} = await import('../packages/backend/src/research/metadata-import.ts');
  const {buildAbstractMaterialBundle} = await import('../packages/backend/src/research/abstract-evidence.ts');
  const {prepareExtractionRequest,executeExtractionTrial,extractionFieldReport} = await import('../packages/backend/src/research/abstract-extraction.ts');
  const {trialPreflight,reserveExtractionTrial} = await import('../packages/backend/src/research/extraction-budget.ts');
  const {validateCompactExtraction} = await import('../packages/backend/src/research/extraction-validation.ts');
  const {registerPrivateReading} = await import('../packages/backend/src/research/private-reading.ts');
  const db = researchDatabase(sql);
  try {
    const metadata = await readJson(source.key+'-pubmed-metadata.json');
    if (metadata.pmid!==source.pmid || metadata.doi!==source.doi || sha256(stableJson(metadata))!==source.metadataHash) throw new Error('Saved official metadata identity or contents changed');
    // Retrieval reuses the already acquired source snapshot, so run never refreshes the frozen material.
    const saved = await importLiteratureMetadata(db,metadata);
    if (!saved.recordId || ['identity_conflict','needs_metadata'].includes(saved.status)) throw new Error('Metadata identity conflict blocks extraction');
    if (options.mode==='prepare') {
      if (!source.processingAllowed) return {state:'index_only',recordId:saved.recordId,actualRequests:0};
      let previous:null|{recordId:string;materialId:string;bundleId:string;metadataHash:string;requestHash:string}=null;
      try {previous=await readJson(source.key+'-prepared.json');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if (previous) {
        const prepared=await prepareExtractionRequest(db,previous.bundleId,'deepseek-flash');
        if (previous.recordId!==saved.recordId || previous.materialId!==saved.materialId || previous.metadataHash!==source.metadataHash
          || previous.requestHash!==prepared.request.bodyHash) throw new Error('Previous preparation no longer matches the source/configuration');
        return {key:source.key,recordId:saved.recordId,materialId:saved.materialId,bundleId:previous.bundleId,state:'prepared_existing',
          actualRequests:0,readingUrl:'http://127.0.0.1:3200/research/read/'+saved.recordId};
      }
      const bundle = await buildAbstractMaterialBundle(db,saved.materialId,{fragmentIds:source.fragmentIds});
      const prepared = await prepareExtractionRequest(db,bundle.id,'deepseek-flash');
      await put(source.key+'-prepared.json',{key:source.key,recordId:saved.recordId,materialId:saved.materialId,bundleId:bundle.id,requestHash:prepared.request.bodyHash,metadataHash:source.metadataHash});
      await put(source.key+'-material-bundle.json',bundle);await put(source.key+'-final-request.json',prepared.request);
      await put(source.key+'-provided-input.json',{system:prepared.system,user:prepared.user,input:prepared.input});
      return {key:source.key,recordId:saved.recordId,materialId:saved.materialId,bundleId:bundle.id,scope:'abstract',actualRequests:0,readingUrl:'http://127.0.0.1:3200/research/read/'+saved.recordId};
    }
    return await withBatchLock(directory,async()=>{
      const plan = await readJson('execution-plan.json');
      let ledger:NewLiteratureLedger = await readJson('batch-state.json');
      const cases:NewCase[] = plan.cases;
      if (ledger.batchId!==plan.batchId || ledger.planHash!==sha256(stableJson(plan)) || plan.sourcePolicyHash!==sha256(stableJson(policy))) throw new Error('Frozen batch identity changed');
      checkNewLiteratureBudget(ledger,cases);
      const verifyFiles = async()=>{for (const [relative,digest] of Object.entries(plan.frozenFiles)) {
        const file = path.resolve(process.cwd(),relative),within = path.relative(process.cwd(),file);
        if (within.startsWith('..') || path.isAbsolute(within) || sha256(await readFile(file))!==digest) throw new Error('Frozen instruction, material or executable changed');
      }};
      await verifyFiles();
      const entry = cases.find(item=>item.key===source.key);
      if (!entry || entry.recordId!==saved.recordId || entry.materialId!==saved.materialId || !entry.processingAllowed) throw new Error('Frozen material/permission does not match');
      const executions = await sql`SELECT id,state,execution_count FROM ep_research_extraction_trials WHERE authorization_key LIKE ${ledger.batchId+':%'} AND execution_count<>0`;
      if (executions.length!==ledger.cumulativeConsumedRequests || executions.some(row=>stopNewLiteratureAfter(row.state))) throw new Error('Database execution count or unknown outcome blocks this batch');
      const prepared = await prepareExtractionRequest(db,entry.bundleId,'deepseek-flash');
      const approval = await readJson(entry.key+'-approval.json');
      if (prepared.request.bodyHash!==entry.requestHash || approval.authorizationKey!==ledger.batchId+':'+entry.pmid
        || prepared.request.baseUrl!=='https://api.deepseek.com' || prepared.request.modelName!=='deepseek-flash'
        || prepared.request.body.max_tokens!==4096 || stableJson(prepared.request.body.thinking)!==stableJson({type:'disabled'})
        || stableJson(prepared.request.body.response_format)!==stableJson({type:'json_object'})) throw new Error('Final non-thinking model/configuration changed');
      const check = trialPreflight(prepared.bundle,prepared.request,approval);
      if (!check.ready || check.upperBoundMicros!==entry.upperBoundMicros) throw new Error('Permission or fee preflight is no longer valid');
      ledger = consumeNewLiteratureSlot(ledger,cases,entry.key);await saveBatchLedger(directory,ledger);
      const send = ledger.sends!.at(-1)!;
      const startedAt = new Date().toISOString(),started = performance.now();
      try {
        const trial = await reserveExtractionTrial(db,prepared.bundle,prepared.request,approval);
        const draft = await executeExtractionTrial(db,trial.id,{enableRealRequest:true,timeoutMs:120_000});
        const [receipt] = draft.receiptId===null?[]:await sql`SELECT * FROM receipts WHERE id=${draft.receiptId}`;
        const [trialRow] = await sql`SELECT id,state,execution_count,receipt_id,reserved_micros FROM ep_research_extraction_trials WHERE id=${trial.id}`;
        const [draftRow] = await sql`SELECT * FROM ep_research_extraction_drafts WHERE id=${draft.id}`;
        const envelope = receipt?.response,content = envelope?.choices?.[0]?.message?.content;
        const checked = validateCompactExtraction(draftRow?.raw_output??null,prepared.input,{finishReason:envelope?.choices?.[0]?.finish_reason});
        await put(entry.key+'-provider-receipt.json',receipt??null);await put(entry.key+'-draft.json',draftRow);
        if (typeof content==='string') await writeFile(path.join(directory,entry.key+'-raw-response.txt'),content,{encoding:'utf8',flag:'wx'});
        await put(entry.key+'-raw-output.json',draftRow?.raw_output??null);await put(entry.key+'-structure-report.json',checked);
        await put(entry.key+'-raw-diagnostic.json',rawExtractionDiagnosticRows(draftRow?.raw_output??null));
        const report = await extractionFieldReport(db,draft.id);await put(entry.key+'-field-report.json',report);
        const card = await registerPrivateReading(db,{materialId:entry.materialId,draftId:draft.id,family:entry.family,
          processingAllowed:true,attribution:source.attribution});
        const usage = receipt?.usage??null;
        const costEstimated = usage && Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens)
          ? (usage.prompt_tokens*approval.pricing.inputMicrosPerMillion+usage.completion_tokens*approval.pricing.outputMicrosPerMillion)/1_000_000_000_000:null;
        const outcome = {key:entry.key,pmid:entry.pmid,doi:entry.doi,...card,trialId:trial.id,draftId:draft.id,receiptId:draft.receiptId,
          trialState:trialRow?.state,state:checked.formatStatus==='valid' && checked.truncation.status!=='truncated'?draft.state:'invalid_output',
          actualNetworkAttempts:receipt?.attempts??0,formatStatus:checked.formatStatus,citationStatus:report.citationStatus,
          semanticReviewMethod:'not_evaluated',humanApprovalGranted:false,qualified:false,requestModel:prepared.request.modelName,
          responseModel:envelope?.model??null,finishReason:envelope?.choices?.[0]?.finish_reason??null,usage,
          fee:{currency:'CNY',upperBoundCNY:entry.upperBoundMicros/1_000_000,costEstimatedAllInputMissPeak:costEstimated,
            costActual:receipt?.cost_basis==='actual'?receipt.cost:null,costActualCurrency:receipt?.cost_basis==='actual'?receipt.currency:null,
            costActualStatus:receipt?.cost_basis==='actual' && receipt.cost!=null?'provider_reported':'not_supplied_or_reconciled',
            priceVerifiedAt:approval.pricing.verifiedAt,basisUrl:approval.pricing.basisUrl},
          modelElapsedMs:envelope?._latencyMs??null,elapsedMs:Math.round(performance.now()-started),startedAt,completedAt:new Date().toISOString(),
          intervention:{humanContentEdits:0,assistantContentEdits:0,manualJsonCopies:0,frontendRecordEdits:0,assistantSemanticComparisons:0},
          requestHash:entry.requestHash,materialHash:prepared.bundle.materialHash,rawOutputRetained:true};
        await put(entry.key+'-execution.json',outcome);
        Object.assign(send,{...outcome,case:entry.key,state:trialRow?.state??'unknown'});
        if (stopNewLiteratureAfter(send.state) || envelope && envelope.model!==prepared.request.modelName
          || Number(receipt?.attempts??0)>1 || receipt && receipt.retry_policy!=='never') {
          ledger.state='stopped';ledger.stopReason='permission_budget_transport_unknown_or_model_identity_change';
        } else if (ledger.cumulativeConsumedRequests===3) ledger.state='completed';
        ledger.actualRequests=(ledger.sends??[]).reduce((sum,item)=>sum+Number(item.actualNetworkAttempts??0),0);
        await saveBatchLedger(directory,ledger);
        return {key:entry.key,pmid:entry.pmid,state:outcome.state,formatStatus:outcome.formatStatus,
          actualNetworkAttempts:outcome.actualNetworkAttempts,cumulativeConsumedRequests:ledger.cumulativeConsumedRequests,
          batchState:ledger.state,readingUrl:card.readingUrl,elapsedMs:outcome.elapsedMs,fee:outcome.fee};
      } catch {
        send.state='unknown';ledger.state='stopped_system_error';ledger.stopReason='Execution or persistence requires reconciliation; never resend';
        await saveBatchLedger(directory,ledger);throw new Error('Private execution stopped; inspect the persisted ledger and receipt. No automatic resend.');
      }
    });
  } finally {process.env.MODEL_CALLS_ENABLED='false';await closeDb();}
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) newPaperCli().then(value=>console.log(JSON.stringify(value))).catch(error=>{
  console.error('New-paper entry stopped: '+(error instanceof Error?error.name:'unknown error')+'. Inspect private records; no automatic resend.');process.exitCode=1;
});
