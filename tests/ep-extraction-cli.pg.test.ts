// Billing and data boundaries of the executable entry point; no external provider.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { extractionCliArguments, localExtractionDatabase, privateApprovalPath, rawExtractionDiagnosticRows } from '../scripts/ep-pr2b-extract-one.ts';
import { assertEpTestDatabase } from './fixtures/ep-test-safety.ts';
import { extractionMetadata, fixedCompactExtractionOutput } from './fixtures/ep-extraction.ts';
assertEpTestDatabase(process.env.DATABASE_URL);
process.env.MODEL_CALLS_ENABLED = 'false'; process.env.COLLECT_ENABLED = 'false'; process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
const { sql, closeDb } = await import('../packages/backend/src/db.ts');
const { researchDatabase } = await import('../packages/backend/src/research/postgres.ts');
const { importLiteratureMetadata } = await import('../packages/backend/src/research/metadata-import.ts');
const roots: string[] = []; const records: string[] = [];
after(async () => {
  try {
    for (const id of records) await sql.begin(async tx => {
      const receipts=await tx<{receipt_id:number|null}[]>`SELECT t.receipt_id FROM ep_research_extraction_trials t JOIN ep_research_abstract_bundles b ON b.id=t.bundle_id JOIN ep_research_materials m ON m.id=b.material_id WHERE m.record_id=${id}`;
      await tx`DELETE FROM ep_research_extraction_drafts WHERE bundle_id IN (SELECT b.id FROM ep_research_abstract_bundles b JOIN ep_research_materials m ON m.id=b.material_id WHERE m.record_id=${id})`;
      await tx`DELETE FROM ep_research_extraction_trials WHERE bundle_id IN (SELECT b.id FROM ep_research_abstract_bundles b JOIN ep_research_materials m ON m.id=b.material_id WHERE m.record_id=${id})`;
      for (const receipt of receipts) if(receipt.receipt_id!==null) await tx`DELETE FROM receipts WHERE id=${receipt.receipt_id}`;
      await tx`DELETE FROM ep_research_records WHERE id=${id}`;
    });
    // Only checked directories constructed from this test's generated IDs are removed.
    for (const directory of roots) {
      const relative = path.relative(path.resolve('.data/ep-pr2b'),directory);
      assert.match(relative,/^(live|cli-https)-[0-9a-f-]{36}$/); assert.ok(!path.isAbsolute(relative));
      await rm(directory, { recursive: true, force: true });
    }
  } finally { await closeDb(); }
});

test('CLI rejects accidental sends, multiple materials, production databases and public approval paths', () => {
  const id = randomUUID();
  assert.throws(() => extractionCliArguments(['prepare','--bundle',id,'--execute-once']));
  assert.throws(() => extractionCliArguments(['run','--bundle',id,'--approval','.data/approval.json']));
  assert.throws(() => extractionCliArguments(['prepare','--bundle',id,'--material',randomUUID()]));
  assert.throws(() => localExtractionDatabase('postgres://127.0.0.1:5432/production'));
  assert.throws(() => localExtractionDatabase('postgres://example.com/test_test'));
  assert.throws(() => localExtractionDatabase('postgres://127.0.0.1:5432/cli_test',true));
  assert.throws(() => privateApprovalPath(process.cwd(),'docs/approval.json'));
  assert.throws(() => privateApprovalPath(process.cwd(),'.data/../approval.json'));
});

test('schema-invalid JSON remains reviewable without fabricating citations or correcting model values', () => {
  const output={groups:[{groupId:'g1',sample:{quantity:5,unit:'animals',denominator:null},imagingMethods:[],
    radiationStrategy:{value:'Unsupported claim',citations:['malformed-reference']},publication_state:'published'}]};
  const fields=rawExtractionDiagnosticRows(output);
  const quantity=fields.find(item=>item.path==='sample.quantity')!;
  assert.equal(quantity.value,5); assert.equal(quantity.rawNode,5); assert.deepEqual(quantity.citations,[]);
  assert.deepEqual(fields.find(item=>item.path==='imagingMethods')!.value,[]);
  assert.deepEqual(fields.find(item=>item.path==='radiationStrategy')!.citations,['malformed-reference']);
  assert.ok(!fields.some(item=>item.path==='publication_state'));
  assert.deepEqual(rawExtractionDiagnosticRows({groups:'invalid'}),[]);
});

test('prepare forcibly closes an inherited model valve and persists exact provided input without any trial, receipt or fabricated output', async () => {
  const saved = await importLiteratureMetadata(researchDatabase(sql), extractionMetadata('control','10.9999/cli-' + randomUUID()));
  records.push(saved.recordId!);
  const before = await sql`SELECT (SELECT count(*)::int FROM receipts) AS receipts,(SELECT count(*)::int FROM ep_research_extraction_trials) AS trials,(SELECT count(*)::int FROM ep_research_extraction_drafts) AS drafts`;
  const result = spawnSync(process.execPath, ['scripts/ep-pr2b-extract-one.ts','prepare','--material',saved.materialId], {
    cwd: path.resolve(import.meta.dirname,'..'), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, MODEL_CALLS_ENABLED:'true', LLM_MODEL:'SYNTHETIC', LLM_API_KEY:'test-do-not-print', LLM_BASE_URL:'http://127.0.0.1:9/v1' },
  });
  assert.equal(result.status,0,result.stderr); assert.equal(result.error,undefined);
  assert.ok(!result.stdout.includes('test-do-not-print'));
  const summary = JSON.parse(result.stdout) as { directory:string; bundleId:string; modelCallsEnabled:boolean; actualRequests:number; realModelTrialExecuted:boolean; ready:boolean };
  assert.match(summary.bundleId,/^[0-9a-f-]{36}$/);
  assert.equal(summary.modelCallsEnabled,false); assert.equal(summary.actualRequests,0); assert.equal(summary.realModelTrialExecuted,false); assert.equal(summary.ready,false);
  const expectedDirectory = path.resolve('.data/ep-pr2b','live-' + summary.bundleId);
  assert.equal(summary.directory,expectedDirectory); roots.push(expectedDirectory);
  const provided = JSON.parse(await readFile(path.join(expectedDirectory,'provided-input.json'),'utf8'));
  assert.equal(provided.input.fragments.length,1); assert.ok(provided.input.fragments[0].text.includes('5 animals'));
  const report = await readFile(path.join(expectedDirectory,'preparation-status.md'),'utf8');
  assert.ok(report.includes('未调用，无输出')); assert.ok(!report.includes('fixed') && !report.includes('positioning tool'));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(expectedDirectory,'field-report.md'),'SYNTHETIC existing result must survive a later prepare','utf8');
  const again = spawnSync(process.execPath,['scripts/ep-pr2b-extract-one.ts','prepare','--bundle',summary.bundleId], {
    cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8',timeout:30_000,env:{...process.env,MODEL_CALLS_ENABLED:'true'},
  });
  assert.equal(again.status,0,again.stderr);
  assert.equal(await readFile(path.join(expectedDirectory,'field-report.md'),'utf8'),'SYNTHETIC existing result must survive a later prepare');
  assert.deepEqual(await sql`SELECT (SELECT count(*)::int FROM receipts) AS receipts,(SELECT count(*)::int FROM ep_research_extraction_trials) AS trials,(SELECT count(*)::int FROM ep_research_extraction_drafts) AS drafts`, before);
});

test('a purported run with invalid approval stays at zero requests and never reserves a trial', async () => {
  const saved = await importLiteratureMetadata(researchDatabase(sql), extractionMetadata('original','10.9999/cli-blocked-' + randomUUID()));
  records.push(saved.recordId!);
  const { buildAbstractMaterialBundle } = await import('../packages/backend/src/research/abstract-evidence.ts');
  const bundle = await buildAbstractMaterialBundle(researchDatabase(sql),saved.materialId);
  const directory = path.resolve('.data/ep-pr2b','live-' + bundle.id); roots.push(directory);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(directory,{recursive:true});
  const file = path.join(directory,'invalid-approval.json'); await writeFile(file,'{}','utf8');
  const result = spawnSync(process.execPath,['scripts/ep-pr2b-extract-one.ts','run','--bundle',bundle.id,'--approval',file,'--execute-once'], {
    cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8',timeout:30_000,
    env:{...process.env,MODEL_CALLS_ENABLED:'true',LLM_MODEL:'SYNTHETIC',LLM_API_KEY:'test-do-not-print',LLM_BASE_URL:'http://127.0.0.1:9/v1'},
  });
  assert.equal(result.status,2,result.stderr); assert.equal(result.error,undefined);
  const summary = JSON.parse(result.stdout); assert.equal(summary.actualRequests,0); assert.equal(summary.ready,false);
  assert.equal((await sql`SELECT count(*)::int AS n FROM ep_research_extraction_trials WHERE bundle_id=${bundle.id}`)[0]!.n,0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM ep_research_extraction_drafts WHERE bundle_id=${bundle.id}`)[0]!.n,0);
});

test('one loopback HTTPS response exports private fields and usage; rerunning cannot send or overwrite the result', async () => {
  const tlsDirectory=path.resolve('.data/ep-pr2b','cli-https-' + randomUUID()); roots.push(tlsDirectory);
  await mkdir(tlsDirectory,{recursive:true});
  const keyFile=path.join(tlsDirectory,'key.pem'); const certFile=path.join(tlsDirectory,'cert.pem');
  const openssl=process.env.EP_TEST_OPENSSL ?? (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  const certificate=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1',
    '-subj','/CN=EP-CLI-LOOPBACK-TEST','-addext','subjectAltName=IP:127.0.0.1','-keyout',keyFile,'-out',certFile],
    {encoding:'utf8',timeout:15_000});
  assert.equal(certificate.status,0,certificate.stderr); // Child-only CA trust, never disable TLS verification.
  const saved=await importLiteratureMetadata(researchDatabase(sql),extractionMetadata('control','10.9999/cli-https-' + randomUUID()));
  records.push(saved.recordId!);
  const {buildAbstractMaterialBundle}=await import('../packages/backend/src/research/abstract-evidence.ts');
  const bundle=await buildAbstractMaterialBundle(researchDatabase(sql),saved.materialId);
  const directory=path.resolve('.data/ep-pr2b','live-' + bundle.id); roots.push(directory);
  const response=fixedCompactExtractionOutput(bundle,'control'); let hits=0;
  const server=https.createServer({key:await readFile(keyFile),cert:await readFile(certFile)},(request,res) => {
    hits++;
    assert.equal(request.url,'/v1/chat/completions');
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:'SYNTHETIC-loopback-response',choices:[{message:{content:JSON.stringify(response)}}],
      usage:{prompt_tokens:11,completion_tokens:7,total_tokens:18}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl=`https://127.0.0.1:${address.port}/v1`;
  const previous={LLM_MODEL:process.env.LLM_MODEL,LLM_BASE_URL:process.env.LLM_BASE_URL,LLM_API_KEY:process.env.LLM_API_KEY,LLM_EXTRA_JSON:process.env.LLM_EXTRA_JSON};
  const modelEnvironment={LLM_MODEL:'SYNTHETIC-CLI',LLM_BASE_URL:baseUrl,LLM_API_KEY:'SYNTHETIC-not-a-key',LLM_EXTRA_JSON:''};
  Object.assign(process.env,modelEnvironment);
  try {
    const {prepareExtractionRequest}=await import('../packages/backend/src/research/abstract-extraction.ts');
    const prepared=await prepareExtractionRequest(researchDatabase(sql),bundle.id,'default');
    const now=new Date().toISOString(); const later=new Date(Date.now()+3_600_000).toISOString();
    const approval={authorizationKey:'SYNTHETIC-cli-' + randomUUID(),authorizedBy:'Authored local test only',approvedAt:now,expiresAt:later,
      bundleId:bundle.id,materialHash:bundle.materialHash,modelKey:'default',modelName:'SYNTHETIC-CLI',endpoint:baseUrl,
      requestHash:prepared.request.bodyHash,currency:'USD',authorizedMicros:1_000_000,
      materialProcessingBasis:'Authored synthetic fixture sent only to the loopback server',
      pricing:{basisUrl:'https://provider.example/synthetic-pricing',verifiedAt:now,validUntil:later,requestHash:prepared.request.bodyHash,
        inputTokenUpperBound:100_000,inputCountingBasis:'Synthetic test ceiling, not a provider token count',
        inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000,additionalFeeMicros:0,
        billingCoverage:'all_input_output_reasoning_and_additional_fees',outputCapCoversAllBillableOutput:true}};
    await mkdir(directory,{recursive:true}); const approvalFile=path.join(directory,'SYNTHETIC-approval.json');
    await writeFile(approvalFile,JSON.stringify(approval),'utf8');
    const invoke=(args:string[]) => new Promise<{status:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
      const child=spawn(process.execPath,['scripts/ep-pr2b-extract-one.ts',...args],{
        cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,...modelEnvironment,MODEL_CALLS_ENABLED:'true',NODE_EXTRA_CA_CERTS:certFile},
        stdio:['ignore','pipe','pipe'],windowsHide:true});
      let stdout=''; let stderr=''; const timer=setTimeout(()=>{child.kill();reject(new Error('Loopback CLI timed out'));},30_000);
      child.stdout.on('data',chunk=>{stdout+=String(chunk);}); child.stderr.on('data',chunk=>{stderr+=String(chunk);});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr});});
    });
    const runArgs=['run','--bundle',bundle.id,'--approval',approvalFile,'--execute-once'];
    const result=await invoke(runArgs); assert.equal(result.status,0,result.stderr); assert.equal(hits,1);
    assert.ok(!result.stdout.includes(modelEnvironment.LLM_API_KEY));
    const metrics=JSON.parse(result.stdout); assert.equal(metrics.networkAttemptsRecorded,1);
    assert.equal(metrics.usage.prompt_tokens,11); assert.equal(metrics.usage.completion_tokens,7);
    assert.equal(metrics.actualReceiptCost,null); assert.equal(metrics.semanticStatus,'not_evaluated'); assert.equal(metrics.requiresHumanReview,true);
    const report=await readFile(path.join(directory,'field-report.md'),'utf8');
    assert.ok(report.includes('待人工核对') && report.includes('SYNTH-MARKER') && report.includes('5 animals'));
    const again=await invoke(runArgs); assert.equal(again.status,2); assert.equal(hits,1);
    const prepareAgain=await invoke(['prepare','--bundle',bundle.id]); assert.equal(prepareAgain.status,0); assert.equal(hits,1);
    assert.equal(await readFile(path.join(directory,'field-report.md'),'utf8'),report);
    const [trial]=await sql<{execution_count:number;state:string}[]>`SELECT execution_count,state FROM ep_research_extraction_trials WHERE bundle_id=${bundle.id}`;
    assert.equal(trial!.execution_count,1); assert.equal(trial!.state,'received');
  } finally {
    for (const [name,value] of Object.entries(previous)) {if(value===undefined) delete process.env[name]; else process.env[name]=value;}
    await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));
  }
});
