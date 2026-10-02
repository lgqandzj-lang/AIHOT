import { z } from 'zod';
import type { Database, Parameter } from './contracts.ts';
import type { LiteratureMetadata } from './metadata.ts';
import { extractionFieldReport, readExtractionDraft } from './abstract-extraction.ts';
import type { StructuredExtractionOutput } from './extraction-schema.ts';
import { readAbstractMaterialBundle } from './abstract-evidence.ts';
import { sha256, stableJson } from '../lib/ids.ts';
import { replayStructuredCollections, checkedStructuredReadingParts, STRUCTURED_FORMAT_COMPAT_VERSION } from './extraction-format-compat.ts';
import type { ReplayInput } from './extraction-replay.ts';
import type { ExtractionCompletion } from './extraction-validation.ts';
import { structuredPrivateReadingView } from './private-reading-view.ts';
import { privateProductEntry } from './private-product.ts';
import type { StudyDesign, RecordInput } from './contracts.ts';

const json = (value: unknown): Parameter => JSON.parse(JSON.stringify(value)) as Parameter;
const text = z.string().min(1).max(3000);
const attributionSchema = z.object({ copyright: text, license: text, licenseUrl: z.url(), changesNotice: text }).strict();
export type ReadingAttribution = z.infer<typeof attributionSchema>;
const catalogSchema = z.object({ version: z.literal('private-reader-v1'), materialId: z.uuid(), draftId: z.uuid().nullable(),
  readerId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), family: text, processingAllowed: z.boolean(),
  attribution: attributionSchema, reviews: z.array(z.unknown()) }).strict();
type Catalog = z.infer<typeof catalogSchema>;
const rowSchema = z.object({ groupId: z.string().min(1).max(100), path: text,
  verdict: z.enum(['source_supported','citation_incomplete','model_omission','material_not_reported','structure_coverage_gap',
    'source_conflict','contract_ambiguous','acceptance_definition_insufficient','not_required','not_evaluated']), reason: text,
  quotes: z.array(z.object({ fragmentId: z.uuid(), quote: z.string().min(1).max(2000) }).strict()).max(20) }).strict();
export type ReadingReviewRow = z.infer<typeof rowSchema>;
type Report = Awaited<ReturnType<typeof extractionFieldReport>>;
type FormatReplay = {version:string;draftId:string;rawHash:string;inputHash:string;candidate:unknown;transformations:unknown[];completion:ExtractionCompletion;createdAt:string};
type CatalogRow = { id: string; metadata: LiteratureMetadata; study_design: StudyDesign; material_scope: RecordInput['materialScope']; private_data: { privateReading?: unknown; privateReadingVersions?: unknown[]; privateReadingFormatReplays?: FormatReplay[] }; publication_state: string };
const q = <Row extends Record<string, unknown>>(db: Database, sql: string, values: Parameter[] = []) => db.query<Row>({text:sql,values});
const valueHash = (value: unknown) => sha256(stableJson(value));

/** A separate immutable replay in existing private JSONB. No draft, receipt, failure or schema is rewritten. */
export async function savePrivateReadingFormatReplay(db: Database, draftId: string) {
  const draft=await readExtractionDraft(db,z.uuid().parse(draftId));
  if(draft.origin!=='live'||draft.inputManifest.fullTextProvided!==false)throw new Error('Replay needs an existing live abstract response');
  const [saved]=await q<{raw_output:unknown;request_summary:{promptVersion?:string};response:{choices?:Array<{finish_reason?:string}>;usage?:{completion_tokens?:number}}}>(db,
    'SELECT d.raw_output,r.request AS request_summary,r.response FROM ep_research_extraction_drafts d JOIN receipts r ON r.id=d.receipt_id WHERE d.id=$1::uuid',[draftId]);
  if(!saved||saved.request_summary?.promptVersion!=='ep-abstract-extract-v4')throw new Error('Missing saved v4 response');
  const completion={finishReason:saved.response?.choices?.[0]?.finish_reason??null,outputTokens:saved.response?.usage?.completion_tokens??null};
  const replay=replayStructuredCollections(saved.raw_output,draft.inputManifest,completion);
  if(!replay.transformations.length)throw new Error('No unambiguous supported collection conversion');
  const stored:FormatReplay={version:STRUCTURED_FORMAT_COMPAT_VERSION,draftId,rawHash:replay.originalRawHash,inputHash:valueHash(draft.inputManifest),
    candidate:replay.candidate,transformations:replay.transformations,completion,createdAt:new Date().toISOString()};
  await db.transaction(async tx=>{
    const [record]=await tx.query<{id:string;private_data:CatalogRow['private_data']}>({text:`SELECT r.id::text,r.private_data FROM ep_research_records r
      JOIN ep_research_materials m ON m.record_id=r.id WHERE m.id=$1::uuid FOR UPDATE OF r`,values:[draft.inputManifest.materialId]});
    if(!record)throw new Error('Missing linked private record');
    const catalogs=[catalogSchema.parse(record.private_data.privateReading),...(record.private_data.privateReadingVersions??[]).map(item=>catalogSchema.parse(item))];
    if(!catalogs.some(catalog=>catalog.draftId===draftId&&catalog.processingAllowed))throw new Error('No processing permission for this private draft');
    const versions=record.private_data.privateReadingFormatReplays??[],existing=versions.find(item=>item.draftId===draftId&&item.version===stored.version);
    if(existing){if(!equalReplay(existing,stored))throw new Error('Saved format replay is immutable');return;}
    await tx.query({text:"UPDATE ep_research_records SET private_data=jsonb_set(private_data,'{privateReadingFormatReplays}',$2::jsonb) WHERE id=$1::uuid",values:[record.id,json([...versions,stored])]});
  });
  return replay;
}
const equalReplay=(a:FormatReplay,b:FormatReplay)=>stableJson({...a,createdAt:null})===stableJson({...b,createdAt:null});

function checkedSections(raw:unknown,input:ReplayInput,completion:ExtractionCompletion) {
  const checked=checkedStructuredReadingParts(raw,input,completion);
  const sections:Array<{id:string;label:string;fields:Array<{key:string;label:string;modelValue:string;review:'pending';note:string;evidence:Array<{label:string;quote:string}>}>}>=[];
  const labels=new Map(checked.parts.filter(part=>part.path.endsWith('.groupLabel')).map(part=>[part.groupId,part.modelValue]));
  for(const part of checked.parts){
    let section=sections.find(section=>section.id===part.groupId);
    if(!section){section={id:part.groupId,label:part.groupId==='overall'?'总体':part.groupId==='comparison'?'明确比较':labels.get(part.groupId)??'研究组别',fields:[]};sections.push(section);}
    section.fields.push({key:part.groupId+':'+part.path,label:part.label,modelValue:part.modelValue,review:'pending',
      note:'尚待内容核查。',
      evidence:part.citations.map(id=>{const fragment=input.fragments.find(fragment=>fragment.citation.fragmentId===id)!;return {label:fragment.sectionLabel??'已提供摘要',quote:fragment.text};})});
  }
  return {sections,deferredCount:checked.deferred.length};
}

/** Only the linked, original official snapshot enters this private catalogue. No output is copied into PR1 findings. */
export async function registerPrivateReading(db: Database, input: {
  materialId: string; draftId: string | null; readerId?: string; family: string;
  processingAllowed: boolean; attribution: ReadingAttribution; appendVersion?: boolean;
}) {
  z.uuid().parse(input.materialId);
  const [material] = await q<{ id:string; record_id:string|null; metadata:LiteratureMetadata; intake_state:string }>(db,
    'SELECT id::text,record_id::text,metadata,intake_state FROM ep_research_materials WHERE id=$1::uuid',[input.materialId]);
  if (!material?.record_id || material.intake_state!=='linked' || !material.metadata.title
    || /(?:TEST COPY|SYNTHETIC|DELETED[- ]EVIDENCE)/i.test(material.metadata.title)) throw new Error('Only original, linked literature can enter the private catalogue');
  if (input.draftId) {
    const [draft] = await q<{ material_id:string; origin:string }>(db,`SELECT b.material_id::text,d.origin FROM ep_research_extraction_drafts d
      JOIN ep_research_abstract_bundles b ON b.id=d.bundle_id WHERE d.id=$1::uuid`,[z.uuid().parse(input.draftId)]);
    if (!draft || draft.material_id!==input.materialId || draft.origin!=='live') throw new Error('Catalogue draft must belong to this original live material');
  }
  const {appendVersion,...binding}=input;
  const catalog = catalogSchema.parse({version:'private-reader-v1',...binding,readerId:input.readerId??material.record_id,reviews:[]});
  const licence = new URL(catalog.attribution.licenseUrl);
  if (licence.protocol!=='https:' || licence.username || licence.password || licence.search || licence.hash) throw new Error('Unsafe attribution URL');
  if (catalog.processingAllowed && (licence.hostname!=='creativecommons.org' || licence.pathname!=='/licenses/by/4.0/')) throw new Error('This local trial requires confirmed CC BY 4.0 processing rights');
  const [existing] = await q<{ private_data:{privateReading?:unknown;privateReadingVersions?:unknown[]} }>(db,'SELECT private_data FROM ep_research_records WHERE id=$1::uuid',[material.record_id]);
  if (existing?.private_data.privateReading) {
    const saved = catalogSchema.parse(existing.private_data.privateReading);
    if (stableJson({...saved,reviews:[]})!==stableJson(catalog)) {
      if (!appendVersion || !input.readerId || !input.draftId || saved.materialId!==catalog.materialId || saved.readerId===catalog.readerId) throw new Error('Existing catalogue binding is immutable');
      await db.transaction(async tx=>{
        const [record]=await tx.query<{private_data:{privateReadingVersions?:unknown[]}}>({text:'SELECT private_data FROM ep_research_records WHERE id=$1::uuid FOR UPDATE',values:[material.record_id]});
        const versions=(record?.private_data.privateReadingVersions??[]).map(value=>catalogSchema.parse(value));
        const previous=versions.find(value=>value.readerId===catalog.readerId||value.draftId===catalog.draftId);
        if(previous){if(stableJson({...previous,reviews:[]})!==stableJson(catalog))throw new Error('Saved reader version is immutable');return;}
        await tx.query({text:"UPDATE ep_research_records SET private_data=jsonb_set(private_data,'{privateReadingVersions}',$2::jsonb) WHERE id=$1::uuid",values:[material.record_id,json([...versions,catalog])]});
      });
    }
  } else {
    await q(db,`UPDATE ep_research_records SET private_data=jsonb_set(private_data,'{privateReading}',$2::jsonb)
      WHERE id=$1::uuid AND NOT private_data ? 'privateReading'`,[material.record_id,json(catalog)]);
  }
  return {recordId:material.record_id,readerId:catalog.readerId,readingUrl:'http://127.0.0.1:3200/research/read/'+catalog.readerId};
}

/** The separate assistant comparison stores decisions and quotes, never replacement model values or human approval. */
export async function savePrivateReadingReview(db: Database, draftId: string, reviewId: string, rows: ReadingReviewRow[]) {
  text.parse(reviewId);
  const report = await extractionFieldReport(db,draftId);
  const bundle = await readAbstractMaterialBundle(db,report.bundleId);
  const checked = z.array(rowSchema).max(1000).parse(rows);
  const keys = new Set<string>();
  const savedRows = checked.map(row => {
    const key = row.groupId+':'+row.path;
    if (keys.has(key)) throw new Error('Duplicate semantic review field'); keys.add(key);
    const field = report.fields.find(field=>field.groupId===row.groupId && field.path===row.path);
    if (!field) throw new Error('Review field does not exist in the saved model output');
    if (row.verdict==='source_supported' && (field.value===null || !row.quotes.length)) throw new Error('Supported reader value needs its own saved model value and quote');
    for (const quote of row.quotes) {
      if (!bundle.providedFragmentIds.includes(quote.fragmentId)
        || !bundle.fragments.find(fragment=>fragment.id===quote.fragmentId)?.text.includes(quote.quote)) throw new Error('Review quote is outside the provided source material');
      const evidence = field.evidence.find(evidence=>evidence.identity==='valid' && evidence.reference.fragmentId===quote.fragmentId);
      if (row.verdict==='source_supported' && !evidence?.text?.includes(quote.quote)) throw new Error('Supported review cannot add model citations or change source quotes');
    }
    return {...row,valueHash:valueHash(field.value),citationHash:valueHash(field.citations)};
  });
  const review = {id:reviewId,draftId,method:'assistant_source_comparison',humanApprovalGranted:false,modelValuesChanged:false,
    rows:savedRows,createdAt:new Date().toISOString()};
  await db.transaction(async tx=>{
    const [record] = await tx.query<{id:string;private_data:{privateReading?:unknown;privateReadingVersions?:unknown[]}}>({text:
      `SELECT r.id::text,r.private_data FROM ep_research_records r JOIN ep_research_materials m ON m.record_id=r.id
       WHERE m.id=$1::uuid FOR UPDATE OF r`,values:[report.materialId]});
    if (!record) throw new Error('Missing private catalogue record');
    const original=catalogSchema.parse(record.private_data.privateReading);
    const versions=(record.private_data.privateReadingVersions??[]).map(value=>catalogSchema.parse(value));
    const versionIndex=versions.findIndex(value=>value.draftId===draftId);
    const catalog=original.draftId===draftId?original:versions[versionIndex];
    if (!catalog || catalog.draftId!==draftId) throw new Error('Review is for another catalogue draft');
    const previous = catalog.reviews.find(value=>(value as {id?:string})?.id===reviewId) as typeof review|undefined;
    if (previous) {
      if (stableJson({...previous,createdAt:null})!==stableJson({...review,createdAt:null})) throw new Error('Saved assistant review is immutable');
      return;
    }
    catalog.reviews.push(review);
    if(original.draftId===draftId)await tx.query({text:`UPDATE ep_research_records SET private_data=jsonb_set(private_data,'{privateReading}',$2::jsonb) WHERE id=$1::uuid`,values:[record.id,json(catalog)]});
    else {versions[versionIndex]=catalog;await tx.query({text:`UPDATE ep_research_records SET private_data=jsonb_set(private_data,'{privateReadingVersions}',$2::jsonb) WHERE id=$1::uuid`,values:[record.id,json(versions)]});}
  });
  return review;
}

function structuredReadingSections(report:Report,output:StructuredExtractionOutput,
  decisions:Array<ReadingReviewRow&{valueHash:string;citationHash:string}>,evaluated:boolean) {
  const sections:Array<{id:string;label:string;fields:Array<{key:string;label:string;modelValue:string;review:'source_supported'|'pending'|'not_reported';note:string;evidence:Array<{label:string;quote:string}>}>}>=[];
  const sectionsById=new Map<string,typeof sections[number]>();
  const labels=new Map(output.groups.map(group=>[group.groupId,group.groupLabel.value??'模型组别待核查']));
  const display=(field:{value:unknown;status?:string})=>field.value===null?field.status==='not_reported'?'摘要未报告':'未知':typeof field.value==='string'||typeof field.value==='number'?String(field.value):JSON.stringify(field.value);
  const owner=(population:{value:unknown})=>population.value && typeof population.value==='object' && 'scope' in population.value
    ? population.value.scope==='overall'?'overall':'groupId' in population.value?String(population.value.groupId):'unresolved':'unresolved';
  const add=(groupId:string,path:string,label:string,modelValue:string,keys:string[])=>{
    let section=sectionsById.get(groupId);
    if(!section){section={id:groupId,label:groupId==='overall'?'总体':groupId==='unresolved'?'归属待核查':groupId==='comparison'?'明确比较':labels.get(groupId)??'模型组别待核查',fields:[]};sectionsById.set(groupId,section);sections.push(section);}
    const fields=keys.map(key=>report.fields.find(field=>field.groupId===groupId&&field.path===(key?path+'.'+key:path))).filter(field=>field!==undefined);
    const rows=fields.map(field=>decisions.find(row=>row.groupId===groupId&&row.path===field.path&&row.valueHash===valueHash(field.value)&&row.citationHash===valueHash(field.citations)));
    const matched=evaluated&&fields.length===keys.length&&rows.every((row,index)=>row&&(
      fields[index].value===null?['material_not_reported','not_required'].includes(row.verdict):row.verdict==='source_supported'&&row.quotes.length>0
        &&row.quotes.every(quote=>fields[index].evidence.some(evidence=>evidence.identity==='valid'&&evidence.reference.fragmentId===quote.fragmentId&&evidence.text?.includes(quote.quote)))));
    const absent=fields.length>0&&fields.every(field=>field.value===null);
    const evidence=[...new Map(fields.flatMap((field,index)=>{
      const quotes=rows[index]?.quotes;
      return quotes?.length?quotes.map(quote=>({label:field.evidence.find(e=>e.reference.fragmentId===quote.fragmentId)?.label??'摘要片段',quote:quote.quote})):
        field.evidence.filter(e=>e.identity==='valid'&&e.text).map(e=>({label:e.label??'模型绑定摘要',quote:e.text!}));
    }).map(entry=>[stableJson(entry),entry])).values()];
    const pending=rows.find(row=>row&&!['source_supported','material_not_reported','not_required'].includes(row.verdict));
    section.fields.push({key:groupId+':'+path,label,modelValue,review:matched?absent?'not_reported':'source_supported':'pending',
      note:matched?'AI 已对照提供摘要；尚无人类审核批准。':pending?.reason??'模型原值尚待核查。',evidence});
  };
  const counts=(groupId:string,path:string,value:StructuredExtractionOutput['overallSample'])=>{
    if(Array.isArray(value))value.forEach((count,index)=>add(groupId,`${path}[${index}]`,'样本计数',`${display(count.quantity)} ${display(count.unit)} · ${display(count.denominator)}`,['quantity','unit','denominator']));
    else add(groupId,path,'样本计数',display(value),['']);
  };
  counts('overall','overallSample',output.overallSample);
  for(const group of output.groups)counts(group.groupId,'sample',group.sample);
  if(Array.isArray(output.results))output.results.forEach((result,index)=>add(owner(result.population),`results[${index}]`,
    (result.kind==='duration'?'测量时长 · ':'结局 · ')+display(result.metric),
    `${display(result.resultValue)} ${display(result.unit)} · ${display(result.statistic)}`,
    ['population','metric','resultValue','unit','statistic']));
  else add('unresolved','results','结果',display(output.results),['']);
  if(Array.isArray(output.proceduralContexts))output.proceduralContexts.forEach((context,index)=>add(owner(context.population),`proceduralContexts[${index}]`,'流程阶段（非随访）',display(context.stage),['population','stage']));
  else add('unresolved','proceduralContexts','流程阶段（非随访）',display(output.proceduralContexts),['']);
  const resultOwners=new Map(Array.isArray(output.results)?output.results.map(result=>[result.resultId,owner(result.population)]):[]);
  if(Array.isArray(output.observationTimes))output.observationTimes.forEach((observation,index)=>{
    const time=observation.time.value;
    add(resultOwners.get(observation.resultId)??'unresolved',`observationTimes[${index}]`,'结局观察窗口',`${time.start}–${time.end} ${time.unit} · ${display(time.anchor)}`,['time']);
  });else add('unresolved','observationTimes','结局观察窗口',display(output.observationTimes),['']);
  if(Array.isArray(output.comparisons))output.comparisons.forEach((comparison,index)=>add('comparison',`comparisons[${index}]`,'模型报告的比较',display(comparison.description),['resultIds','description']));
  return sections;
}

export function privateDraftProjection(report: Report | null, catalog: Catalog,structuredOutput?:StructuredExtractionOutput|null) {
  const review = [...catalog.reviews].reverse().find(value=>(value as {draftId?:string})?.draftId===report?.draftId) as {
    method?:string;humanApprovalGranted?:boolean;rows?:Array<ReadingReviewRow&{valueHash:string;citationHash:string}>;
  }|undefined;
  const evaluated = review?.method==='assistant_source_comparison' && review.humanApprovalGranted===false;
  const degraded = report?.state==='invalid_output' || review?.rows?.some(row=>!['source_supported','material_not_reported','not_required'].includes(row.verdict));
  const usable = catalog.processingAllowed && report?.formatStatus==='valid' && report.citationStatus==='valid'
    && report.truncationStatus!=='truncated';
  const groups = [];
  const structured=report?.fields.some(field=>field.path.startsWith('overallSample'))??false;
  for (const [index,groupId] of [...new Set(report?.fields.map(field=>field.groupId)??[])].entries()) {
    if (structured) break;
    const supported = (path:string) => {
      if (!usable || !evaluated) return null;
      const field = report!.fields.find(field=>field.groupId===groupId && field.path===path);
      const decision = review!.rows?.find(row=>row.groupId===groupId && row.path===path && row.verdict==='source_supported');
      if (!field || !decision || field.value===null || decision.valueHash!==valueHash(field.value) || decision.citationHash!==valueHash(field.citations)
        || !decision.quotes.length || decision.quotes.some(quote=>!field.evidence.some(evidence=>evidence.identity==='valid'
          && evidence.reference.fragmentId===quote.fragmentId && evidence.text?.includes(quote.quote)))) return null;
      return {field,decision};
    };
    const subjects = supported('researchSubjects'), quantity = supported('sample.quantity'), unit = supported('sample.unit'), scope = supported('sample.denominator');
    if (!subjects && !scope) continue;
    const label = supported('groupLabel');
    const countAllowed = !!quantity && !!unit && !!scope && typeof quantity.field.value==='number' && Number.isSafeInteger(quantity.field.value) && quantity.field.value>0;
    const selected = [subjects,scope,...(countAllowed?[quantity,unit]:[])].filter(item=>item!==null);
    const evidence = [...new Map(selected.flatMap(item=>item.decision.quotes.map(quote=>({label:
      item.field.evidence.find(evidence=>evidence.reference.fragmentId===quote.fragmentId)?.label||'摘要片段',quote:quote.quote})))
      .map(item=>[stableJson(item),item])).values()];
    groups.push({id:groupId,label:typeof label?.field.value==='string'?label.field.value:'研究组 '+(index+1),
      quantity:countAllowed?quantity!.field.value as number:null,unit:countAllowed?String(unit!.field.value):null,
      subjects:subjects?String(subjects.field.value):null,populationScope:scope?String(scope.field.value):null,evidence});
  }
  const sections=structured && usable && structuredOutput?structuredReadingSections(report!,structuredOutput,review?.rows??[],evaluated):undefined;
  return {status:'private_auto_draft' as const,reviewMethod:evaluated?'assistant_source_comparison' as const:'not_evaluated' as const,
    state:!catalog.processingAllowed?'index_only' as const:!report?'unreviewed' as const:report.state==='unknown'?'unknown' as const:
      report.formatStatus!=='valid'||report.truncationStatus==='truncated'||report.citationStatus==='invalid'?'invalid_output' as const:
      evaluated?degraded?'degraded' as const:'private_draft' as const:'unreviewed' as const,groups,...(sections?{sections}:{}),attribution:catalog.attribution};
}

/** Local private HTTP adapters call this. Publication readers never import it. */
export async function readPrivateReadingPapers(db: Database) {
  const rows = await q<CatalogRow>(db,`SELECT r.id::text,r.private_data,r.publication_state,r.study_design,r.material_scope,m.metadata
    FROM ep_research_records r JOIN ep_research_materials m ON m.id=(r.private_data->'privateReading'->>'materialId')::uuid
    AND m.record_id=r.id WHERE r.private_data ? 'privateReading' ORDER BY r.id`);
  const papers = [];
  for (const row of rows) {
    const catalogs=[catalogSchema.parse(row.private_data.privateReading),...(row.private_data.privateReadingVersions??[]).map(value=>catalogSchema.parse(value))];
    for (const [version,catalog] of catalogs.entries()) {
    if (!row.metadata.title || /(?:TEST COPY|SYNTHETIC|DELETED[- ]EVIDENCE)/i.test(row.metadata.title)) continue;
    const report = catalog.draftId ? await extractionFieldReport(db,catalog.draftId) : null;
    const draft=catalog.draftId?await readExtractionDraft(db,catalog.draftId):null,output=draft?.output;
    const privateDraft=privateDraftProjection(report,catalog,output?.schemaVersion==='ep-abstract-extract-v4'?output:null);
    let sourceAbstract:{scope:'abstract';fullTextProvided:false;sourceName:string;sourceUrl:string;acquiredAt:string;fragments:Array<{id:string;label:string|null;text:string}>}|undefined;
    let automatic:{sections:ReturnType<typeof checkedSections>['sections'];deferredCount:number;formatConverted:boolean;readingView:ReturnType<typeof structuredPrivateReadingView>}|undefined;
    if(catalog.processingAllowed){
      const bundleId=report?.bundleId??(await q<{id:string}>(db,'SELECT id::text FROM ep_research_abstract_bundles WHERE material_id=$1::uuid AND state=\'ready\' ORDER BY id LIMIT 1',[catalog.materialId]))[0]?.id;
      if(bundleId){
        const bundle=await readAbstractMaterialBundle(db,bundleId);
        if(bundle.materialId!==catalog.materialId)throw new Error('Abstract belongs to another material');
        if(bundle.fragments.length)sourceAbstract={scope:'abstract',fullTextProvided:false,sourceName:'PubMed · 已保存摘要',sourceUrl:row.metadata.sourceUrl,acquiredAt:row.metadata.acquiredAt,
          fragments:bundle.fragments.map(fragment=>({id:fragment.id,label:fragment.sectionLabel,text:fragment.text}))};
      }
      if(draft&&sourceAbstract){
        const [saved]=await q<{raw_output:unknown;request_summary:{promptVersion?:string};response:{choices?:Array<{finish_reason?:string}>}}>(db,
          'SELECT d.raw_output,r.request AS request_summary,r.response FROM ep_research_extraction_drafts d LEFT JOIN receipts r ON r.id=d.receipt_id WHERE d.id=$1::uuid',[catalog.draftId]);
        if(saved?.request_summary?.promptVersion==='ep-abstract-extract-v4'){
          const completion={finishReason:saved.response?.choices?.[0]?.finish_reason??null};
          const stored=row.private_data.privateReadingFormatReplays?.find(item=>item.draftId===draft.id&&item.version===STRUCTURED_FORMAT_COMPAT_VERSION);
          let candidate=saved.raw_output,formatConverted=false;
          if(stored){
            const recomputed=replayStructuredCollections(saved.raw_output,draft.inputManifest,completion);
            if(stored.rawHash!==valueHash(saved.raw_output)||stored.inputHash!==valueHash(draft.inputManifest)
              ||valueHash(stored.candidate)!==recomputed.candidateHash||stableJson(stored.transformations)!==stableJson(recomputed.transformations))throw new Error('Stored format replay identity changed');
            candidate=stored.candidate;formatConverted=stored.transformations.length>0;
          }
          automatic={...checkedSections(candidate,draft.inputManifest,completion),formatConverted,
            readingView:structuredPrivateReadingView(candidate,draft.inputManifest,completion)};
        }
      }
    }
    if (report && report.materialId!==catalog.materialId) throw new Error('Private reader material identity changed');
    const paper={id:catalog.readerId,title:row.metadata.title,journal:row.metadata.journal,year:row.metadata.publishedYear,
      authors:row.metadata.authors,doi:row.metadata.doi,pmid:row.metadata.pmid,topic:'pfa' as const,
      sources:[{name:'PubMed · 摘要来源',url:row.metadata.sourceUrl,acquiredAt:row.metadata.acquiredAt},
        {name:'出版社 · 原文',url:'https://doi.org/'+row.metadata.doi,acquiredAt:row.metadata.acquiredAt}],
      privateDraft:{...privateDraft,...(sourceAbstract?{sourceAbstract}:{groups:[],sections:undefined}),...(automatic?{state:'degraded' as const,groups:[],sections:automatic.sections,
        readingView:automatic.readingView,readingChecks:{formatConverted:automatic.formatConverted,deferredCount:automatic.deferredCount,semanticStatus:'not_evaluated' as const}}:{}),
        ...(catalog.draftId?{diagnosticUrl:'http://127.0.0.1:3201/api/research-preview/admin/diagnostics/'+catalog.readerId}:{})}};
    papers.push({...paper,privateResearch:privateProductEntry(paper,{id:row.id,version,publishedOn:row.metadata.publishedOn,
      studyDesign:row.study_design,materialScope:row.material_scope})});
    }
  }
  if (new Set(papers.map(paper=>paper.id)).size!==papers.length) throw new Error('Duplicate private reader identifier');
  return papers;
}

/** Only the authenticated local admin endpoint calls this; never part of reader/SSR projections. */
export async function readPrivateReadingDiagnostic(db:Database,readerId:string){
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(readerId))throw new Error('Invalid private reader ID');
  const rows=await q<{private_data:CatalogRow['private_data']}>(db,"SELECT private_data FROM ep_research_records WHERE private_data ? 'privateReading'");
  for(const row of rows){
    const catalogs=[catalogSchema.parse(row.private_data.privateReading),...(row.private_data.privateReadingVersions??[]).map(value=>catalogSchema.parse(value))];
    const catalog=catalogs.find(catalog=>catalog.readerId===readerId);
    if(!catalog?.draftId)continue;
    const draft=await readExtractionDraft(db,catalog.draftId);
    const [saved]=await q<{raw_output:unknown;response:{choices?:Array<{message?:{content?:string};finish_reason?:string}>}}>(db,
      'SELECT d.raw_output,r.response FROM ep_research_extraction_drafts d LEFT JOIN receipts r ON r.id=d.receipt_id WHERE d.id=$1::uuid',[catalog.draftId]);
    const stored=row.private_data.privateReadingFormatReplays?.find(item=>item.draftId===draft.id&&item.version===STRUCTURED_FORMAT_COMPAT_VERSION);
    const completion={finishReason:saved?.response?.choices?.[0]?.finish_reason??null};
    return {readerId,draftId:draft.id,originalState:draft.state,originalIssues:draft.issues,
      originalModelResponse:saved?.response?.choices?.[0]?.message?.content??null,
      ...(stored&&saved?{formatReplay:replayStructuredCollections(saved.raw_output,draft.inputManifest,completion),
        deferred:checkedStructuredReadingParts(stored.candidate,draft.inputManifest,completion).deferred}:{}),
      semanticStatus:'not_evaluated',humanApprovalGranted:false,publicApprovalGranted:false};
  }
  return null;
}
