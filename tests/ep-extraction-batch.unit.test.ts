import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import { checkBatchBudget,consumeBatchSlot,shouldStopBatch,withBatchLock,saveBatchLedger,privateBatchDirectory,
  estimatedBatchFee,extractionBatchCli } from '../scripts/ep-pr2b-batch.ts';
import type {BatchLedger,BatchSlot} from '../scripts/ep-pr2b-batch.ts';
const slots:BatchSlot[]=[{case:'A',upperBoundMicros:10000},{case:'B',upperBoundMicros:20000},{case:'C',upperBoundMicros:30000}];
const initial=():BatchLedger=>({batchId:'SYNTHETIC-existing-authorization',currency:'CNY',authorizedMicros:1_000_000,
  maxActualRequests:3,cumulativeConsumedRequests:0,reservedMicros:0,state:'ready',sends:[]});
async function inDirectory(action:(directory:string)=>Promise<void>){
  const root=path.resolve('.data'),directory=await mkdtemp(path.join(root,'synthetic-batch-'));
  try{await action(directory);}finally{
    const relative=path.relative(root,directory);assert.ok(relative.startsWith('synthetic-batch-')&&!relative.includes(path.sep));
    await rm(directory,{recursive:true,force:true});
  }
}
test('whole batch reserves three ceilings against the original single CNY 1 limit',()=>{
  assert.equal(checkBatchBudget(initial(),slots),60000);
  assert.throws(()=>checkBatchBudget(initial(),slots.map(v=>({...v,upperBoundMicros:400000}))),/Whole-batch/);
  for(const update of [{authorizedMicros:2_000_000},{maxActualRequests:4},{currency:'USD'},{reservedMicros:1_000_001},
    {cumulativeConsumedRequests:-1},{cumulativeConsumedRequests:0.5}])assert.throws(()=>checkBatchBudget({...initial(),...update},slots));
  assert.throws(()=>checkBatchBudget(initial(),[slots[1]!,slots[0]!,slots[2]!]));
});
test('a slot is consumed before transport and cannot repeat or overlap, including failure/timeout',()=>{
  const source=initial(),a=consumeBatchSlot(source,slots,'A');
  assert.equal(source.cumulativeConsumedRequests,0);assert.equal(a.cumulativeConsumedRequests,1);assert.equal(a.reservedMicros,60000);
  assert.equal(a.sends![0]!.state,'attempting');
  assert.throws(()=>consumeBatchSlot(a,slots,'A'));assert.throws(()=>consumeBatchSlot(a,slots,'B'));
  a.sends![0]!.state='unknown';assert.throws(()=>consumeBatchSlot(a,slots,'B'));
  a.sends![0]!.state='received';const b=consumeBatchSlot(a,slots,'B');
  b.sends![1]!.state='invalid_output';const c=consumeBatchSlot(b,slots,'C');
  c.sends![2]!.state='received';assert.equal(c.cumulativeConsumedRequests,3);
  assert.throws(()=>consumeBatchSlot(c,slots,'C'));assert.throws(()=>consumeBatchSlot({...c,cumulativeConsumedRequests:0},slots,'A'),/ledger mismatch/);
});
test('A original structure failure stops even if a normalized candidate would pass; unknown and authorization failure stop any slot',()=>{
  assert.equal(shouldStopBatch('A',false,'invalid_output'),true);
  assert.equal(shouldStopBatch('A',true,'invalid_output'),false,'content issues are recorded without changing the prompt');
  for(const name of ['A','B','C'] as const)for(const state of ['unknown','in_flight','rejected'])assert.equal(shouldStopBatch(name,true,state),true);
  assert.equal(shouldStopBatch('B',false,'invalid_output'),false,'only A has the requested structural stop gate');
  assert.throws(()=>consumeBatchSlot({...initial(),state:'stopped'},slots,'A'));
});
test('persistent consumption survives a process-style reload; saving never raises the authorized amount',async()=>inDirectory(async directory=>{
  const a=consumeBatchSlot(initial(),slots,'A');await saveBatchLedger(directory,a);
  const saved=JSON.parse(await readFile(path.join(directory,'batch-state.json'),'utf8'));
  assert.equal(saved.cumulativeConsumedRequests,1);assert.equal(saved.authorizedMicros,1_000_000);
  assert.throws(()=>consumeBatchSlot(saved,slots,'A'));
  saved.sends[0].state='received';const b=consumeBatchSlot(saved,slots,'B');await saveBatchLedger(directory,b);
  assert.equal(JSON.parse(await readFile(path.join(directory,'batch-state.json'),'utf8')).cumulativeConsumedRequests,2);
}));
test('exclusive lock blocks a second run and preserves a pre-existing crash lock',async()=>inDirectory(async directory=>{
  await withBatchLock(directory,async()=>{
    await assert.rejects(withBatchLock(directory,async()=>assert.fail('second concurrency must not run')),/EEXIST/);
  });
  await assert.rejects(access(path.join(directory,'execution.lock')));
  await writeFile(path.join(directory,'execution.lock'),'SYNTHETIC crash reservation');
  await assert.rejects(withBatchLock(directory,async()=>assert.fail('no automatic recovery')),/EEXIST/);
  assert.equal(await readFile(path.join(directory,'execution.lock'),'utf8'),'SYNTHETIC crash reservation');
}));
test('case fee reports are estimates from usage, keep actual deduction unknown, and handle cache hits',()=>{
  const fee=estimatedBatchFee({prompt_tokens:1000,completion_tokens:500,prompt_cache_hit_tokens:200})!;
  assert.equal(fee.peakEstimated,0.005608);assert.equal(fee.offPeakEstimated,0.002804);
  assert.equal(fee.actualDeduction,null);assert.equal(estimatedBatchFee(null),null);
  assert.equal(estimatedBatchFee({prompt_tokens:1,completion_tokens:1,prompt_cache_hit_tokens:2}),null);
});
test('CLI paths remain private and a closed model valve stops before importing providers or using fetch',async()=>inDirectory(async directory=>{
  const oldFetch=globalThis.fetch,oldDb=process.env.DATABASE_URL,oldValve=process.env.MODEL_CALLS_ENABLED;
  globalThis.fetch=async()=>assert.fail('No external or paid test connections');
  try{
    assert.equal(await privateBatchDirectory(process.cwd(),directory),directory);
    await assert.rejects(privateBatchDirectory(process.cwd(),process.cwd()),/private/);
    await writeFile(path.join(directory,'execution-plan.json'),JSON.stringify({database:'synthetic_batch_test'}));
    process.env.DATABASE_URL='postgres://127.0.0.1/synthetic_batch_test';process.env.MODEL_CALLS_ENABLED='false';
    await assert.rejects(extractionBatchCli(['--directory',directory,'--execute-once']),/valve is closed/);
  }finally{
    globalThis.fetch=oldFetch;
    if(oldDb===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldDb;
    if(oldValve===undefined)delete process.env.MODEL_CALLS_ENABLED;else process.env.MODEL_CALLS_ENABLED=oldValve;
  }
}));
