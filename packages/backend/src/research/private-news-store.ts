import { sql, type Sql } from '../db.ts';
import { upsertMaterial, type MaterialInput } from '../content/materials.ts';
import { fetchRss } from '../sources/rss.ts';
import type { Candidate, SourceRow } from '../sources/types.ts';
import { fetchPubmedMetadata } from './metadata.ts';
import { importLiteratureMetadata } from './metadata-import.ts';
import { researchDatabase } from './postgres.ts';
import { registerPrivateReading } from './private-reading.ts';
import { completeReceipt } from '../providers/receipts.ts';
import { chatJson, prepareChatJsonRequest } from '../providers/llm.ts';
import { stableJson } from '../lib/ids.ts';
import { NEWS_SOURCES, PRIVATE_NEWS_VERSION, PRIVATE_NEWS_PROMPT, NEWS_SYSTEM, newsModelInput,
  newsKind, newsCopySchema, newsDisplay, parseNewsMaterial, productFromTitle, titleMetadata, materialFingerprint, explicitNewsReferences } from './private-news.ts';
import type { NewsMaterial, NewsDisplay, PrivateNewsFeed, PrivateNewsItem } from './private-news.ts';

export interface DiscoveryOptions { days: number; limit: number; now?: Date; fetcher?: typeof fetch;
  officialReader?: () => Promise<Candidate[]>; historicalIds?: Set<string>; contactEmail?: string }
export interface SourceDiscovery { sourceId: string; status: 'ok' | 'unavailable'; found: number;
  returnedCount: number | null; outcome: 'normal_matches' | 'normal_no_match' | 'normal_empty' | 'source_error';
  candidates: { input: MaterialInput; material: NewsMaterial }[]; error: string | null; checkedAt: string }
function sourceRow(): SourceRow {
  const source = NEWS_SOURCES[1]!;
  return { id: source.id, name: source.name, kind: 'rss', config: { feedUrl: source.url }, tier: 'T1',
    participation_mode: 'isolated', first_party: true, interval_minutes: 1440, enabled: false, cursor: null, fail_count: 0 };
}
const urlDate = (date: Date) => date.toISOString().slice(0, 10).replaceAll('-', '/');

/** Fixed API and RSS, with no detail/fulltext fetch, browser, paid reader or automatic retry. */
export async function discoverPrivateNews(options: DiscoveryOptions): Promise<SourceDiscovery[]> {
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 365 || !Number.isInteger(options.limit)
    || options.limit < 1 || options.limit > 5) throw new Error('Use a 1–365 day window and a 1–5 item limit');
  const now = options.now ?? new Date(), results: SourceDiscovery[] = [];
  for (const source of NEWS_SOURCES) {
    const checkedAt = new Date().toISOString();
    try {
      const candidates: SourceDiscovery['candidates'] = [];
      let found = 0, returnedCount = 0;
      if (source.kind === 'research') {
        const url = new URL(source.url);
        for (const [key, value] of Object.entries({ db: 'pubmed', term: 'VARIPULSE[Title/Abstract]', retmode: 'json',
          retmax: '20', sort: 'pub_date', datetype: 'pdat', mindate: urlDate(new Date(now.getTime() - options.days * 86400000)),
          maxdate: urlDate(now), tool: 'epvoice_private_news', ...(options.contactEmail ? { email: options.contactEmail } : {}) })) url.searchParams.set(key, value);
        const response = await (options.fetcher ?? fetch)(url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('PubMed search HTTP ' + response.status);
        const text = await response.text();
        if (Buffer.byteLength(text) > 100000) throw new Error('PubMed search is too large');
        const result = JSON.parse(text).esearchresult;
        if (!Array.isArray(result?.idlist) || result.idlist.length > 20 || result.idlist.some((id: unknown) => typeof id !== 'string' || !/^[1-9][0-9]{0,11}$/.test(id))) throw new Error('Invalid PubMed search response');
        found = Number(result.count);
        returnedCount = result.idlist.length;
        if (!Number.isSafeInteger(found) || found < 0) throw new Error('Invalid PubMed result count');
        const selected = [...new Set<string>(result.idlist)].filter(pmid => !options.historicalIds?.has('pmid:' + pmid)).slice(0, options.limit);
        for (const pmid of selected) {
          // Below the official three-requests/second limit, including the preceding ESearch.
          if (!options.fetcher) await new Promise(resolve => setTimeout(resolve, 400));
          const metadata = titleMetadata(await fetchPubmedMetadata(pmid, { fetcher: options.fetcher, contactEmail: options.contactEmail }));
          if (!metadata.title || metadata.doi && options.historicalIds?.has('doi:' + metadata.doi)) continue;
          const material: NewsMaterial = { version: PRIVATE_NEWS_VERSION, kind: newsKind(metadata.title, false), scope: 'title',
            sourceId: source.id, sourceName: source.name, title: metadata.title, url: metadata.sourceUrl,
            acquiredAt: metadata.acquiredAt, metadata, product: productFromTitle(metadata.title, metadata.sourceUrl), recordId: null, relatedResearch: null };
          candidates.push({ material, input: { sourceId: source.id, url: material.url, title: material.title,
            identityKey: 'pmid:' + pmid, author: metadata.authors.join('; ') || null, language: 'en',
            publishedAt: metadata.publishedOn ? new Date(metadata.publishedOn + 'T00:00:00Z') : null,
            backfill: metadata.publishedOn ? undefined : 'publication-date-unknown',
            discoveredAt: now, via: 'fetch', bodyStatus: 'none', raw: { epPrivateNews: material } } });
        }
      } else {
        const listing = options.officialReader ? await options.officialReader() : (await fetchRss(sourceRow(), { force: true, strict: true })).candidates;
        returnedCount = listing.length;
        const relevant = listing.filter(candidate => /\bVARIPULSE\b/i.test(candidate.title)
          && new URL(candidate.url).hostname === 'www.jnj.com'
          && (!candidate.publishedAt || candidate.publishedAt.getTime() >= now.getTime() - options.days * 86400000));
        found = relevant.length;
        for (const candidate of relevant.slice(0, options.limit)) {
          const material: NewsMaterial = { version: PRIVATE_NEWS_VERSION, kind: 'official', scope: 'title', sourceId: source.id,
            sourceName: source.name, title: candidate.title, url: candidate.url, acquiredAt: checkedAt,
            metadata: null, product: productFromTitle(candidate.title, candidate.url), recordId: null, relatedResearch: null,
            sourceReferences: explicitNewsReferences(candidate.excerpt ?? '') };
          candidates.push({ material, input: { sourceId: source.id, url: material.url, title: material.title,
            publishedAt: candidate.publishedAt, backfill: candidate.publishedAt ? undefined : 'publication-date-unknown',
            discoveredAt: now, via: 'fetch', bodyStatus: 'none', raw: { epPrivateNews: material } } });
        }
      }
      results.push({ sourceId: source.id, status: 'ok', found, returnedCount,
        outcome: found ? 'normal_matches' : returnedCount ? 'normal_no_match' : 'normal_empty', candidates, error: null, checkedAt });
    } catch (error) { results.push({ sourceId: source.id, status: 'unavailable', found: 0, returnedCount: null, outcome: 'source_error', candidates: [], error: String(error).slice(0, 1000), checkedAt }); }
  }
  return results;
}

export interface PendingNews { articleId: string; revision: number; contentHash: string; materialHash: string; material: NewsMaterial }
/** Reuse the one material entrance; isolated, disabled sources never enqueue editorial/public jobs. */
export async function saveNewsDiscovery(discoveries: SourceDiscovery[], db: Sql = sql) {
  let created = 0, duplicates = 0, revised = 0;
  for (const source of NEWS_SOURCES) {
    const config = { ...(source.kind === 'official' ? { feedUrl: source.url } : {}), privateNews: {
      version: PRIVATE_NEWS_VERSION, materialScope: 'title', basisUrl: source.basisUrl, policyUrl: source.policyUrl } };
    await db`INSERT INTO sources (id,name,kind,config,tier,participation_mode,first_party,enabled,site_fulltext,syndicate_fulltext,interval_minutes)
      VALUES (${source.id},${source.name},${source.kind === 'official' ? 'rss' : 'external'},${db.json(config)},'T1','isolated',true,false,false,false,1440)
      ON CONFLICT (id) DO NOTHING`;
    const [saved] = await db`SELECT participation_mode,enabled,site_fulltext,syndicate_fulltext,config FROM sources WHERE id=${source.id}`;
    if (!saved || saved.participation_mode !== 'isolated' || saved.enabled || saved.site_fulltext || saved.syndicate_fulltext
      || stableJson(saved.config) !== stableJson(config)) throw new Error('Private news source configuration changed');
  }
  for (const discovery of discoveries) {
    let newCount = 0, duplicateCount = 0, revisedCount = 0;
    for (const candidate of discovery.candidates) {
      parseNewsMaterial(candidate.material);
      const result = await upsertMaterial(candidate.input, db);
      if (result.created) { created++; newCount++; }
      else if (result.revised) { revised++; revisedCount++; }
      else { duplicates++; duplicateCount++; }
      const [article] = await db`SELECT source_id,raw FROM articles WHERE id=${result.articleId}`;
      if (article?.source_id !== candidate.material.sourceId) continue;
      let material = parseNewsMaterial(article.raw.epPrivateNews);
      if ((result.created || result.revised) && candidate.material.metadata) {
        const saved = await importLiteratureMetadata(researchDatabase(db), candidate.material.metadata);
        if (saved.recordId && saved.status === 'created') {
          await registerPrivateReading(researchDatabase(db), { materialId: saved.materialId, draftId: null,
            readerId: saved.recordId, family: 'PubMed VARIPULSE title-only news', processingAllowed: false,
            attribution: { copyright: '来源：PubMed 书目信息；原文权利归作者或出版方。', license: '仅题名与书目信息；未提供摘要或全文。',
              licenseUrl: NEWS_SOURCES[0]!.policyUrl, changesNotice: '资讯中文文案独立保存；没有临床结果提取。' } });
        }
        material = { ...candidate.material, recordId: saved.status === 'created' || saved.status === 'unchanged' ? saved.recordId : null };
      } else if (result.revised) material = { ...candidate.material, recordId: material.recordId };
      if ((result.created || result.revised) && material.sourceReferences?.length) {
        const matches = [];
        for (const reference of material.sourceReferences) {
          const rows = await db`SELECT e.record_id::text AS record_id FROM ep_research_external_ids e JOIN ep_research_records r ON r.id=e.record_id
            WHERE e.kind=${reference.kind} AND e.value=${reference.value} AND r.private_data ? 'privateReading'`;
          for (const row of rows) matches.push({ recordId: row.record_id as string, reference });
        }
        if (new Set(matches.map(match => match.recordId)).size === 1) {
          const match = matches[0]!;
          const identifiers = await db`SELECT kind,value FROM ep_research_external_ids WHERE record_id=${match.recordId}`;
          material = { ...material, relatedResearch: { recordId: match.recordId, method: 'exact_identifier', sourceReference: match.reference.url,
            pmid: identifiers.find(row => row.kind === 'pmid')?.value ?? null, doi: identifiers.find(row => row.kind === 'doi')?.value ?? null } };
        }
      }
      if (result.created || result.revised) await db`UPDATE articles SET raw=jsonb_set(coalesce(raw,'{}'::jsonb),'{epPrivateNews}',${db.json(material as never)}) WHERE id=${result.articleId}`;
    }
    await db`INSERT INTO fetch_runs (source_id,started_at,finished_at,status,found_count,new_count,error,detail)
      VALUES (${discovery.sourceId},${discovery.checkedAt},now(),${discovery.status === 'ok' ? 'ok' : 'failed'},${discovery.found},${newCount},${discovery.error},
        ${db.json({ pipeline: PRIVATE_NEWS_VERSION, scope: 'title', mode: 'manual', paidReader: false,
          returnedCount: discovery.returnedCount, outcome: discovery.outcome, duplicateCount, revisedCount })})`;
  }
  return { created, duplicates, revised };
}

export async function pendingNews(db: Sql = sql): Promise<PendingNews[]> {
  const rows = await db`SELECT a.id,a.revision,a.content_hash,a.raw FROM articles a JOIN sources s ON s.id=a.source_id
    WHERE s.id IN ${db(NEWS_SOURCES.map(source => source.id))} AND s.participation_mode='isolated' AND NOT s.enabled
    AND NOT EXISTS (SELECT 1 FROM analyses n WHERE n.article_id=a.id AND n.input_revision=a.revision AND n.prompt_version=${PRIVATE_NEWS_PROMPT}) ORDER BY a.discovered_at,a.id`;
  return rows.map(row => { const material = parseNewsMaterial(row.raw.epPrivateNews); return {
    articleId: row.id as string, revision: row.revision as number, contentHash: row.content_hash as string, materialHash: materialFingerprint(material), material }; });
}
export function prepareNewsRequest(pending: PendingNews, model: string) {
  const options = { model, purpose: 'ep_private_news', subject: pending.articleId, promptVersion: PRIVATE_NEWS_PROMPT,
    system: NEWS_SYSTEM, user: newsModelInput(pending.material), schema: newsCopySchema, maxTokens: 512,
    temperature: 0, retryPolicy: 'never' as const, attemptTag: pending.articleId + ':' + pending.revision };
  return { options, request: prepareChatJsonRequest(options) };
}
/** The only model path; receipt first, then a separately saved display draft. */
export async function executeNewsDraft(pending: PendingNews, model: string, approved: { bodyHash: string; baseUrl: string; inputTokenUpperBound: number }, beforeSend?: () => Promise<void>, budgetSince?: string) {
  const prepared = prepareNewsRequest(pending, model);
  const result = await chatJson({ ...prepared.options, approvedRequest: approved, beforeSend, budgetSince,
    parse: (content, completion) => {
      if (completion?.finishReason !== 'stop') throw new Error('News response was not complete');
      return JSON.parse(content);
    } });
  const [receipt] = await sql`SELECT attempts,retry_policy,response,usage FROM receipts WHERE id=${result.receiptId}`;
  const usage = receipt?.usage;
  if (!receipt || receipt.attempts !== 1 || receipt.retry_policy !== 'never' || receipt.response?.model !== prepared.request.modelName
    || !Number.isSafeInteger(usage?.prompt_tokens) || usage.prompt_tokens < 0 || usage.prompt_tokens > approved.inputTokenUpperBound
    || !Number.isSafeInteger(usage?.completion_tokens) || usage.completion_tokens < 0 || usage.completion_tokens > prepared.request.maxTokens) throw new Error('Model or usage differs from the approved bounded news request');
  const display = newsDisplay(result.data, pending.material, new Date().toISOString());
  await sql.begin(async tx => {
    const [current] = await tx`SELECT revision,content_hash,raw FROM articles WHERE id=${pending.articleId} FOR UPDATE`;
    if (!current || current.revision !== pending.revision || current.content_hash !== pending.contentHash
      || materialFingerprint(parseNewsMaterial(current.raw.epPrivateNews)) !== pending.materialHash) throw new Error('Material changed while writing news');
    const [existing] = await tx`SELECT id FROM analyses WHERE article_id=${pending.articleId} AND input_revision=${pending.revision} AND prompt_version=${PRIVATE_NEWS_PROMPT}`;
    if (!existing) await tx`INSERT INTO analyses (article_id,input_revision,origin,model,prompt_version,receipt_ids,relevance,title_zh,summary_zh,selected,output)
      VALUES (${pending.articleId},${pending.revision},'model',${result.model},${PRIVATE_NEWS_PROMPT},${[result.receiptId]},'unknown',${display.titleZh},${display.leadZh},false,
        ${tx.json({ pipeline: PRIVATE_NEWS_VERSION, materialHash: pending.materialHash, display, parsedCopy: result.data, clinicalReview: 'not_performed', publicApproval: false } as never)})`;
    await completeReceipt(tx, result.receiptId);
  });
  return { articleId: pending.articleId, receiptId: result.receiptId, reused: result.reused, usage: result.usage,
    requestModel: prepared.request.modelName, responseModel: receipt.response.model, actualDeduction: null,
    deductionStatus: 'provider_did_not_supply_bill_amount', requestHash: prepared.request.bodyHash };
}

export async function readPrivateNews(db: Sql = sql): Promise<PrivateNewsFeed> {
  const rows = await db`SELECT a.*,s.name,n.title_zh,n.summary_zh,n.output,n.receipt_ids FROM articles a JOIN sources s ON s.id=a.source_id
    LEFT JOIN LATERAL (SELECT title_zh,summary_zh,output,receipt_ids FROM analyses WHERE article_id=a.id AND input_revision=a.revision
      AND prompt_version=${PRIVATE_NEWS_PROMPT} ORDER BY id DESC LIMIT 1) n ON true
    WHERE s.id IN ${db(NEWS_SOURCES.map(source => source.id))} AND s.participation_mode='isolated' AND NOT s.enabled
      AND NOT s.site_fulltext AND NOT s.syndicate_fulltext ORDER BY a.published_at DESC NULLS LAST,a.discovered_at DESC LIMIT 100`;
  const items: PrivateNewsItem[] = rows.map(row => {
    const material = parseNewsMaterial(row.raw.epPrivateNews);
    const display: NewsDisplay | null = row.output?.pipeline === PRIVATE_NEWS_VERSION
      && row.output.materialHash === materialFingerprint(material) && row.receipt_ids?.length === 1 ? row.output.display : null;
    if (display && (display.curation !== 'model_draft' || display.scope !== 'title' || display.titleZh !== row.title_zh || display.leadZh !== row.summary_zh)) throw new Error('Invalid saved news display');
    return { id: row.id as string, originalTitle: row.title as string, titleZh: display?.titleZh ?? null, leadZh: display?.leadZh ?? null,
      kind: material.kind, materialScope: 'title', publishedAt: row.published_at?.toISOString() ?? null,
      discoveredAt: row.discovered_at.toISOString(), historical: row.backfill as boolean,
      source: { name: material.sourceName, url: material.url, acquiredAt: material.acquiredAt }, product: material.product,
      researchUrl: material.recordId ? '/research/read/' + material.recordId : null, relatedResearch: material.relatedResearch,
      curation: display ? 'model_draft' : 'pending' };
  });
  const sources: PrivateNewsFeed['sources'] = [];
  for (const source of NEWS_SOURCES) {
    const [run] = await db`SELECT started_at,status,found_count,new_count FROM fetch_runs WHERE source_id=${source.id}
      AND detail->>'pipeline'=${PRIVATE_NEWS_VERSION} ORDER BY id DESC LIMIT 1`;
    sources.push({ id: source.id, name: source.name, kind: source.kind, basisUrl: source.basisUrl, policyUrl: source.policyUrl,
      checkedAt: run?.started_at?.toISOString() ?? null, status: !run ? 'not_run' : run.status === 'ok' ? 'ok' : 'unavailable',
      found: run?.found_count ?? 0, created: run?.new_count ?? 0 });
  }
  return { version: PRIVATE_NEWS_VERSION, private: true, items, checkedAt: sources.map(source => source.checkedAt).filter(Boolean).sort().at(-1) ?? null, sources };
}
