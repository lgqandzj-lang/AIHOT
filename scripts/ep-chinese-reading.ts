// A repeatable single-paper prose job. prepare/status are free; run consumes one explicit authorization.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { config, credential } from '../packages/backend/src/config.ts';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { researchDatabase } from '../packages/backend/src/research/postgres.ts';
import { buildAbstractMaterialBundle, readAbstractMaterialBundle, type AbstractMaterialBundle } from '../packages/backend/src/research/abstract-evidence.ts';
import { fetchPubmedMetadata } from '../packages/backend/src/research/metadata.ts';
import { importLiteratureMetadata } from '../packages/backend/src/research/metadata-import.ts';
import { resolvePmcIdentity, genericFulltextSnapshot } from '../packages/backend/src/research/reading-materials.ts';
import { prepareChatJsonRequest, chatJson, markReceiptsCompleted } from '../packages/backend/src/providers/llm.ts';
import { sha256, stableJson } from '../packages/backend/src/lib/ids.ts';
import { fetchTrialPrice } from '../packages/backend/src/research/private-news-trial.ts';
import { reserveExtractionTrial, claimExtractionTrial, finishExtractionTrial, trialPreflight, liveApprovalSchema } from '../packages/backend/src/research/extraction-budget.ts';
import { chineseReadingResponse, chineseReadingSystem, chineseReadingSystemV2, CHINESE_READING_PROMPT_VERSION, CHINESE_READING_PROMPT_VERSION_V2, CHINESE_READING_OUTPUT_CAP,
  fulltextSnapshot, readingInput, checkReadingProse, proseHtml, saveChineseReading, type SavedChineseReading, type FulltextSnapshot } from '../packages/backend/src/research/chinese-reading.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: { directory: { type: 'string' }, pmcid: { type: 'string' }, approval: { type: 'string' }, 'execute-once': { type: 'boolean' } } });
const mode = positionals[0], pmid = positionals[1];
if (!['prepare','run','status'].includes(mode || '') || positionals.length !== 2 || !/^[1-9]\d{0,9}$/.test(pmid || '') || !values.directory) throw new Error('Use prepare|run|status <PMID> --directory <private-directory>');
if (values.pmcid && (mode !== 'prepare' || !/^PMC[1-9]\d+$/.test(values.pmcid))) throw new Error('A source PMCID can only be supplied during preparation');
const root = process.cwd(), directory = path.resolve(root, values.directory), relative = path.relative(path.resolve(root,'.data'), directory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Reading artifacts must stay inside this backend .data directory');
const databaseUrl = new URL(process.env.DATABASE_URL || '');
if (process.env.NODE_ENV === 'production' || databaseUrl.hostname !== '127.0.0.1' || databaseUrl.pathname !== '/epvoice_content_20261002') throw new Error('Use the explicitly separate local content database; never the seven-day news database');
config.modelCallsEnabled = false; config.feishuContentPushEnabled = false; config.indexNowSubmitEnabled = false;
const db = researchDatabase(sql);
const save = (name: string, value: unknown) => writeFile(path.join(directory,name), typeof value === 'string' ? value : JSON.stringify(value,null,2)+'\n', 'utf8');
const read = async <T>(name: string) => JSON.parse(await readFile(path.join(directory,name),'utf8')) as T;
const optional = async <T>(name: string) => { try { return await read<T>(name); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
const state = (status: string, details: Record<string,unknown> = {}) => save('job-status.json',{pmid,status,updatedAt:new Date().toISOString(),...details});
type Catalogue = { id: string; title: string; doi: string | null; private_data: { privateReading?: { readerId: string; draftId: string; materialId: string }; chineseReading?: SavedChineseReading } };
type MaterialManifest = { pmid: string; recordId: string; bundleId: string; pmcid: string | null; promptVersion: string };
const findCatalogue = async () => (await sql<Catalogue[]>`SELECT r.id::text,r.title,r.doi,r.private_data FROM ep_research_records r JOIN ep_research_external_ids x ON x.record_id=r.id WHERE x.kind='pmid' AND x.value=${pmid}`)[0];
try {
  await mkdir(directory, { recursive: true });
  let catalog = await findCatalogue();
  if (mode === 'status') {
    console.log(JSON.stringify({ pmid, saved: !!catalog?.private_data.chineseReading, job: await optional('job-status.json'), modelRequests: 0 }));
  } else {
    const frozen = await optional<{pmid:string;recordId:string;bundleId:string;readerId:string;promptVersion?:string}>('preflight.json');
    let manifest = await optional<MaterialManifest>('material-manifest.json');
    if (frozen && frozen.pmid !== pmid || manifest && manifest.pmid !== pmid) throw new Error('Directory belongs to another PMID');
    let bundle: AbstractMaterialBundle;
    if (frozen || manifest) {
      const bound = frozen || manifest!;
      if (!catalog || catalog.id !== bound.recordId) throw new Error('Frozen bibliography no longer matches');
      bundle = await readAbstractMaterialBundle(db,bound.bundleId);
    } else {
      if (mode !== 'prepare') throw new Error('Prepare the paper before requesting execution');
      await state('preparing_materials');
      let materialId = catalog?.private_data.privateReading?.materialId;
      if (!materialId && catalog) {
        const [material] = await sql<{id:string}[]>`SELECT id::text FROM ep_research_materials WHERE record_id=${catalog.id}::uuid AND provider='pubmed' AND provider_id=${pmid} AND metadata->>'abstract' IS NOT NULL ORDER BY acquired_at,id LIMIT 1`;
        materialId = material?.id;
      }
      if (!materialId) {
        const metadata = await fetchPubmedMetadata(pmid);
        if (!metadata.abstract?.trim()) throw new Error('No saved or available PubMed abstract');
        const imported = await importLiteratureMetadata(db,metadata);
        if (!['created','unchanged'].includes(imported.status) || !imported.recordId) throw new Error('Metadata requires identity review: '+imported.status);
        materialId = imported.materialId; catalog = await findCatalogue();
      }
      if (!catalog?.doi) throw new Error('A verified PMID/DOI bibliography is required');
      bundle = await buildAbstractMaterialBundle(db,materialId!);
      manifest = {pmid:pmid!,recordId:catalog.id,bundleId:bundle.id,pmcid:null,promptVersion:CHINESE_READING_PROMPT_VERSION_V2};
      await save('material-manifest.json',manifest);
    }
    if (!catalog?.doi || bundle.state !== 'ready') throw new Error('Verified bibliography and nonempty abstract are required');
    const [boundMaterial] = await sql<{record_id:string;doi:string|null;pmid:string|null}[]>`
      SELECT record_id::text,metadata->>'doi' AS doi,metadata->>'pmid' AS pmid FROM ep_research_materials WHERE id=${bundle.materialId}::uuid`;
    if (bundle.source.provider !== 'pubmed' || bundle.source.providerId !== pmid || boundMaterial?.record_id !== catalog.id
      || boundMaterial.pmid !== pmid || boundMaterial.doi?.toLowerCase() !== catalog.doi.toLowerCase()) throw new Error('Abstract material belongs to a different paper');
    const readerId = catalog.private_data.chineseReading?.readerId || catalog.private_data.privateReading?.readerId || catalog.id;
    if (frozen && frozen.readerId !== readerId) throw new Error('Frozen reader identity differs from the saved bibliography');
    if (!frozen && !manifest?.pmcid) {
      if (mode !== 'prepare' || !manifest) throw new Error('Prepare verified full-text identity first');
      // An independently identified source can be supplied when the official converter is unavailable.
      // The article itself still must match all three identifiers and its own license region.
      const identity = values.pmcid ? {pmid:pmid!,doi:catalog.doi,pmcid:values.pmcid} : await resolvePmcIdentity(pmid!,catalog.doi);
      manifest = {...manifest,pmcid:identity.pmcid}; await save('material-manifest.json',manifest);
    }
    const promptVersion = frozen?.promptVersion || manifest?.promptVersion || CHINESE_READING_PROMPT_VERSION;
    if (![CHINESE_READING_PROMPT_VERSION,CHINESE_READING_PROMPT_VERSION_V2].includes(promptVersion)) throw new Error('Unknown frozen prompt version');
    const system = promptVersion === CHINESE_READING_PROMPT_VERSION ? chineseReadingSystem : chineseReadingSystemV2;
    let fulltext: FulltextSnapshot;
    try { fulltext = await read<FulltextSnapshot>('fulltext.json'); }
    catch (error) {
      if (mode !== 'prepare' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!manifest?.pmcid) throw new Error('A verified PMC identity is required');
      const response = await fetch(`https://pmc.ncbi.nlm.nih.gov/articles/${manifest.pmcid}/`, { signal: AbortSignal.timeout(25000), redirect: 'error' });
      if (!response.ok) throw new Error('PMC full text HTTP '+response.status);
      const html = await response.text();
      if (Buffer.byteLength(html) > 2000000) throw new Error('PMC full text is unexpectedly large');
      await save('pmc-fulltext.html', html);
      fulltext = genericFulltextSnapshot(html, { pmid:pmid!, doi: catalog.doi, pmcid:manifest.pmcid }, new Date().toISOString());
      await save('fulltext.json', fulltext);
    }
    if (fulltext.bodyHash !== sha256(await readFile(path.join(directory,'pmc-fulltext.html'),'utf8'))
      || fulltext.pmid !== pmid || fulltext.doi !== catalog.doi) throw new Error('Frozen full text changed');
    const recheckFulltext = async () => {
      const html = await readFile(path.join(directory,'pmc-fulltext.html'),'utf8');
      const identity = {pmid:pmid!,doi:catalog!.doi!,pmcid:new URL(fulltext.sourceUrl).pathname.split('/')[2]!};
      const extracted = promptVersion === CHINESE_READING_PROMPT_VERSION ? fulltextSnapshot(html,identity,fulltext.acquiredAt) : genericFulltextSnapshot(html,identity,fulltext.acquiredAt);
      if (stableJson(extracted) !== stableJson(fulltext)) throw new Error('Frozen source fragments differ from the source HTML');
    };
    await recheckFulltext();
    const input = readingInput(bundle, fulltext, catalog.title);
    const opts = { model: 'deepseek-flash', purpose: 'ep_chinese_reading', subject: catalog.id, promptVersion,
      system, user: JSON.stringify(input), schema: chineseReadingResponse, temperature: 0.2, maxTokens: CHINESE_READING_OUTPUT_CAP,
      retryPolicy: 'never' as const, timeoutMs: 120000 };
    const request = prepareChatJsonRequest(opts);
    if (request.baseUrl !== 'https://api.deepseek.com' || request.modelName !== 'deepseek-flash') throw new Error('Existing approved model configuration changed');
    const alreadySaved = (catalog.private_data as typeof catalog.private_data & { chineseReading?: SavedChineseReading }).chineseReading;
    if (alreadySaved) {
      if (alreadySaved.requestHash !== request.bodyHash || alreadySaved.inputHash !== sha256(stableJson(input)) || alreadySaved.fulltextHash !== fulltext.bodyHash) throw new Error('A different saved reading exists; original authorization cannot generate another version');
      await state('saved_private_draft',{actualRequests:0,reused:true,receiptId:alreadySaved.receiptId});
      console.log(JSON.stringify({status:'reused_saved_private_draft',actualRequests:0,receiptId:alreadySaved.receiptId}));
    } else {
    if (mode === 'run' && (!values.approval || !values['execute-once'])) throw new Error('run requires this round\'s explicit approval and --execute-once');
    const inputTokenUpperBound = Buffer.byteLength(JSON.stringify(request.body),'utf8')+1024;
    const price = await fetchTrialPrice();
    const upperMicros = Math.ceil((inputTokenUpperBound*price.inputMicrosPerMillion+CHINESE_READING_OUTPUT_CAP*price.outputMicrosPerMillion)/1000000);
    const prepared = { pmid, recordId: catalog.id, readerId, bundleId: bundle.id, promptVersion,
      abstractMaterialHash: bundle.materialHash, fulltextHash: fulltext.bodyHash, inputHash: sha256(stableJson(input)), requestHash: request.bodyHash,
      modelKey: request.modelKey, modelName: request.modelName, endpoint: request.baseUrl, credentialHash: sha256(credential('models','DEEPSEEK_API_KEY')||''),
      inputTokenUpperBound, inputCountingBasis: 'Final serialized UTF-8 request bytes plus 1024 framing tokens, conservative upper bound for the configured byte-based tokenizer; all input treated as cache misses.',
      outputTokenCap: CHINESE_READING_OUTPUT_CAP, upperMicros, price, maxActualRequests: 1, concurrency: 1, automaticRetries: 0,
      sourceCounts: { abstract: bundle.fragments.length, newFulltext: fulltext.fragments.length }, scope: 'fulltext', authorizationStatus: 'not_granted' };
    if (mode === 'prepare') {
      // Preparing again freezes no new article and does not release an already consumed authorization.
      await save('provided-input.json', input); await save('system-prompt.txt', system);
      await save('request-body.json', request.body); await save('preflight.json', prepared);
      await state('awaiting_authorization',{actualRequests:0,sourceCounts:prepared.sourceCounts,upperMicros});
      console.log(JSON.stringify(prepared));
    } else {
      if (!values.approval || !values['execute-once']) throw new Error('run requires this round\'s explicit approval and --execute-once');
      const frozen = await read<typeof prepared>('preflight.json');
      if (frozen.requestHash !== prepared.requestHash || frozen.inputHash !== prepared.inputHash || frozen.fulltextHash !== prepared.fulltextHash
        || frozen.credentialHash !== prepared.credentialHash || frozen.inputTokenUpperBound !== prepared.inputTokenUpperBound
        || frozen.outputTokenCap !== prepared.outputTokenCap || frozen.bundleId !== bundle.id) throw new Error('Materials, final request or credentials changed since preparation');
      const checkFrozenFiles = async () => {
        if (stableJson(await read('provided-input.json')) !== stableJson(input) || stableJson(await read('request-body.json')) !== stableJson(request.body)
          || await readFile(path.join(directory,'system-prompt.txt'),'utf8') !== system || stableJson(await read('fulltext.json')) !== stableJson(fulltext)) throw new Error('Prepared request artifacts changed');
        await recheckFulltext();
      };
      await checkFrozenFiles();
      const approvalPath = path.resolve(root,values.approval), approvalRelative = path.relative(path.resolve(root,'.data'),approvalPath);
      if (approvalRelative.startsWith('..') || path.isAbsolute(approvalRelative)) throw new Error('Approval must be private');
      const approval = liveApprovalSchema.parse(JSON.parse(await readFile(approvalPath,'utf8')));
      if (!approval.materialProcessingBasis.includes(fulltext.bodyHash) || !approval.materialProcessingBasis.includes('CC BY 4.0')
        || approval.authorizedMicros > 500000 || approval.currency !== 'CNY'
        || approval.pricing.inputTokenUpperBound !== prepared.inputTokenUpperBound || approval.pricing.basisUrl !== price.basisUrl
        || approval.pricing.additionalFeeMicros !== 0) throw new Error('Approval must bind these materials, frozen token upper bound and separate <=0.5 CNY authorization');
      // Refresh primary-source prices within the authorized ceiling; bind them to the same immutable final request.
      const pricedApproval = { ...approval, pricing: { ...approval.pricing, verifiedAt: price.verifiedAt, validUntil: price.validUntil,
        inputMicrosPerMillion: price.inputMicrosPerMillion, outputMicrosPerMillion: price.outputMicrosPerMillion } };
      const preflight = trialPreflight(bundle,request,pricedApproval);
      if (!preflight.ready) throw new Error(preflight.reasons.join('; '));
      const trial = await reserveExtractionTrial(db,bundle,request,pricedApproval);
      await claimExtractionTrial(db,trial.id); // durable one-request claim; restart cannot buy again
      await state('in_flight',{trialId:trial.id,automaticRetries:0});
      let receiptId: number | null = null;
      try {
        config.modelCallsEnabled = true;
        const response = await chatJson({ ...opts, attemptTag: trial.id, approvedRequest: { bodyHash: request.bodyHash, baseUrl: request.baseUrl }, beforeSend: async () => {
          await checkFrozenFiles();
          if (!trialPreflight(bundle,request,pricedApproval).ready
            || prepared.credentialHash !== sha256(credential('models','DEEPSEEK_API_KEY')||'')) throw new Error('Final permission/material/price/time check failed');
        } });
        receiptId = response.receiptId;
        await save('model-output.json', response.data);
        const output = checkReadingProse(response.data,input);
        const [receipt] = await sql<{ response: { model?: string; choices?: Array<{ finish_reason?: string }>; usage?: Record<string,unknown> } }[]>`SELECT response FROM receipts WHERE id=${receiptId}`;
        if (receipt?.response.model !== 'deepseek-flash' || receipt.response.choices?.[0]?.finish_reason !== 'stop') throw new Error('Wrong model or truncated response; keep it as a failed private attempt');
        const draft: SavedChineseReading = { ...output, status: 'private_model_draft', readerId: prepared.readerId, recordId: catalog.id, pmid, doi: catalog.doi,
          originalTitle: catalog.title, html: proseHtml(output.markdown), materialScope: 'fulltext', generatedAt: new Date().toISOString(), model: response.model,
          receiptId, promptVersion, requestHash: request.bodyHash, fulltextHash: fulltext.bodyHash, inputHash: prepared.inputHash,
          humanApprovalGranted: false, publicApprovalGranted: false, semanticStatus: 'not_evaluated', sources: input.fragments,
          license: { name: fulltext.license, url: fulltext.licenseUrl, copyright: fulltext.copyright,
            changesNotice: 'Chinese model-generated interpretation of the published full text and separately saved PubMed abstract; not the original authors\' text. Model output retained unchanged. No human approval or public release.' } };
        await saveChineseReading(db,draft,fulltext); await save('saved-draft.json',draft); await save('中文研究解读.md',output.markdown);
        await markReceiptsCompleted([receiptId]);
        await finishExtractionTrial(db,trial.id,'received',receiptId);
        await state('saved_private_draft',{receiptId,actualRequests:1});
        await save('execution.json',{ status:'saved_private_draft', trialId:trial.id, receiptId, actualRequests:1, automaticRetries:0,
          reservedUpperMicros:upperMicros, usage:response.usage, supplierDeduction:null, humanApprovalGranted:false,
          readerUrl:'http://127.0.0.1:3200/research/read/'+prepared.readerId });
        console.log(JSON.stringify({ status:'saved_private_draft', actualRequests:1, receiptId, reservedUpperMicros:upperMicros }));
      } catch (error) {
        const [receipt] = await sql<{ id: number; status: string }[]>`SELECT id,status FROM receipts WHERE purpose='ep_chinese_reading' AND logical_key LIKE ${'%:'+trial.id} ORDER BY id DESC LIMIT 1`;
        receiptId ??= receipt?.id ?? null;
        await finishExtractionTrial(db,trial.id,receipt?.status==='received' || receipt?.status==='failed' ? 'invalid_output' : 'unknown',receiptId);
        await save('execution.json',{ status:'stopped', trialId:trial.id, receiptId, error:String(error), automaticRetries:0, reservedUpperMicros:upperMicros, supplierDeduction:null });
        throw error;
      } finally { config.modelCallsEnabled=false; }
    }
    }
  }
} catch (error) {
  if (mode !== 'status') await state(mode === 'prepare' ? 'materials_blocked' : 'execution_blocked',{error:String(error),automaticRetries:0});
  throw error;
} finally { config.modelCallsEnabled=false; await closeDb(); }
