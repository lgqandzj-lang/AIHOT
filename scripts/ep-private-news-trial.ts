import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config, credential } from '../packages/backend/src/config.ts';
import { sql, closeDb } from '../packages/backend/src/db.ts';
import { sha256, stableJson } from '../packages/backend/src/lib/ids.ts';
import { MODELS } from '../packages/backend/src/providers/llm.ts';
import { newsCostCeiling } from '../packages/backend/src/research/private-news.ts';
import { discoverPrivateNews, saveNewsDiscovery, pendingNews, prepareNewsRequest, executeNewsDraft, readPrivateNews } from '../packages/backend/src/research/private-news-store.ts';
import { loadNewsTrial, readTrialLedger, changeTrialLedger, assertTrialFiles, trialStopReason, stopTrial,
  trialWindow, canClaimTrialBatch, assertTrialReservation, fetchTrialPrice, reconcileTrialRequests, writeTrialReport } from '../packages/backend/src/research/private-news-trial.ts';
import type { TrialRequest } from '../packages/backend/src/research/private-news-trial.ts';

export async function privateNewsTrialRun(file: string, resumeUnsent = false) {
  const root = process.cwd(), loaded = await loadNewsTrial(root, file), { trial, directory } = loaded;
  config.modelCallsEnabled = false;
  const connection = await sql.reserve(); let locked = false;
  try {
    const [lock] = await connection`SELECT pg_try_advisory_lock(hashtext('ep-private-news-manual-v1')) AS acquired`;
    if (!lock?.acquired) return { skipped: 'another_batch_active', modelRequests: 0 }; locked = true;
    let ledger = await reconcileTrialRequests(sql, trial);
    if (resumeUnsent) {
      const current = trialWindow(trial), batch = ledger.batches.at(-1);
      const attempts = await sql`SELECT id FROM receipt_attempts WHERE origin='live' AND started_at>=${trial.startedAt}`;
      if (ledger.status !== 'stopped' || ledger.stopReason !== 'Error: Budget for deepseek exhausted (day)'
        || !batch || batch.window !== current.window || batch.day !== current.day || attempts.length
        || ledger.requests.some(request => request.sentAt || request.receiptId || request.status !== 'not_sent')) throw new Error('Only the local copied-budget failure with zero sent requests can be resumed explicitly');
      ledger = await changeTrialLedger(sql, trial, saved => {
        saved.interventions.push({ at: new Date().toISOString(), actor: 'assistant', minutes: null,
          reason: '修复复制历史回执误占本轮额度；仅恢复原采集批次的未发送请求，保留起止时间、次数和费用占位。原停止：' + saved.stoppedAt + ' / ' + saved.stopReason });
        saved.status = 'active'; saved.stopReason = null; saved.stoppedAt = null;
        Object.assign(saved.batches.at(-1)!, { status: 'running', finishedAt: null });
      });
    }
    const stopped = trialStopReason(trial, ledger);
    if (stopped) {
      await changeTrialLedger(sql, trial, saved => stopTrial(saved, stopped));
      return await writeTrialReport(sql, trial, directory);
    }
    await assertTrialFiles(trial, root);
    const spec = MODELS[trial.modelKey]!;
    const assertService = async () => {
      if (spec.model !== trial.modelName || spec.service !== 'deepseek' || stableJson(spec.extra) !== stableJson({ thinking: { type: 'disabled' } })
        || credential('models', spec.baseUrlEnv)?.replace(/\/$/, '') !== trial.baseUrl
        || sha256(stableJson({ baseUrl: credential('models', spec.baseUrlEnv), apiKey: credential('models', spec.apiKeyEnv) })) !== trial.credentialHash) throw new Error('Trial model service or credentials changed');
      const budgets = await sql`SELECT service,per_minute,per_hour,per_day FROM budgets`;
      const budget = budgets.find(row => row.service === 'deepseek');
      if (!budget || !['per_minute', 'per_hour', 'per_day'].every(key => budget[key] > 0 && budget[key] <= 5)
        || budgets.some(row => row.service !== 'deepseek' && (row.per_minute !== 0 || row.per_hour !== 0 || row.per_day !== 0))) throw new Error('Existing trial service quotas changed or missing');
    };
    await assertService();
    if (!resumeUnsent && !canClaimTrialBatch(trial, ledger)) return { ...(await writeTrialReport(sql, trial, directory)), skipped: 'daily_batch_already_claimed', modelRequests: 0 };
    const current = trialWindow(trial), startedAt = new Date().toISOString();
    const runDirectory = resumeUnsent ? path.join(ledger.batches.at(-1)!.directory, 'local-unsent-resume-' + startedAt.replace(/[:.]/g, '-'))
      : path.join(directory, 'runs', `day-${current.window + 1}-${startedAt.replace(/[:.]/g, '-')}`);
    await mkdir(runDirectory, { recursive: true });
    const put = (name: string, value: unknown) => writeFile(path.join(runDirectory, name), JSON.stringify(value, null, 2), { flag: 'wx', encoding: 'utf8' });
    if (!resumeUnsent) ledger = await changeTrialLedger(sql, trial, saved => {
      if (!canClaimTrialBatch(trial, saved)) throw new Error('Daily batch already claimed or trial ended');
      saved.batches.push({ ...current, startedAt, finishedAt: null, directory: runDirectory,
        status: 'running', sources: [], created: 0, duplicates: 0, revised: 0, pending: 0, error: null });
    });
    try {
      const oldIds = new Set<string>();
      const identifiers = await sql`SELECT e.kind,e.value FROM ep_research_external_ids e
        WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.raw->'epPrivateNews'->>'recordId'=e.record_id::text)`;
      for (const row of identifiers) if (row.value) oldIds.add(row.kind + ':' + row.value);
      const discoveries = resumeUnsent ? JSON.parse(await readFile(path.join(ledger.batches.at(-1)!.directory, 'discovery.json'), 'utf8')) as Awaited<ReturnType<typeof discoverPrivateNews>>
        : await discoverPrivateNews({ days: 30, limit: 5, historicalIds: oldIds, contactEmail: process.env.NCBI_CONTACT_EMAIL });
      await put('discovery.json', discoveries);
      const intake = resumeUnsent ? { created: ledger.batches.at(-1)!.created, duplicates: ledger.batches.at(-1)!.duplicates, revised: ledger.batches.at(-1)!.revised }
        : await saveNewsDiscovery(discoveries);
      if (!resumeUnsent) await changeTrialLedger(sql, trial, saved => Object.assign(saved.batches.at(-1)!, intake,
        { sources: discoveries.map(({ candidates: _candidates, ...source }) => source) }));
      const pending = (await pendingNews()).filter(item => !ledger.requests.some(request => request.key === item.articleId + ':' + item.revision
        && !(resumeUnsent && request.status === 'not_sent' && !request.sentAt && !request.receiptId))).slice(0, 5);
      const price = pending.length ? await fetchTrialPrice() : null;
      await put('plan.json', { private: true, current, modelKey: trial.modelKey, price, automaticRetries: 0, automaticModelChanges: 0,
        requests: pending.map(item => { const prepared = prepareNewsRequest(item, trial.modelKey); return { articleId: item.articleId,
          revision: item.revision, requestHash: prepared.request.bodyHash, originalTitle: item.material.title, scope: 'title' }; }) });
      for (const item of pending) {
        const prepared = prepareNewsRequest(item, trial.modelKey), inputTokenUpperBound = Buffer.byteLength(JSON.stringify(prepared.request.body)) + 1024;
        if (prepared.request.baseUrl !== trial.baseUrl || prepared.request.maxTokens !== 512 || prepared.request.modelName !== trial.modelName || !price) throw new Error('Bounded trial request differs from the frozen model');
        const reservation: TrialRequest = { key: item.articleId + ':' + item.revision, articleId: item.articleId, revision: item.revision,
          requestHash: prepared.request.bodyHash, ...current, reservedAt: new Date().toISOString(), sentAt: null,
          upperMicros: newsCostCeiling(inputTokenUpperBound, 512, price.inputMicrosPerMillion, price.outputMicrosPerMillion),
          inputTokenUpperBound, price, status: 'reserved', receiptId: null, estimateMicros: null, error: null };
        await changeTrialLedger(sql, trial, saved => {
          const held = saved.requests.find(request => request.key === reservation.key);
          if (resumeUnsent && held?.status === 'not_sent' && !held.sentAt && !held.receiptId) {
            if (held.requestHash !== reservation.requestHash || held.inputTokenUpperBound !== reservation.inputTokenUpperBound
              || held.day !== reservation.day || held.window !== reservation.window
              || saved.requests.reduce((sum, request) => sum + request.upperMicros, 0) + Math.max(0, reservation.upperMicros - held.upperMicros) > trial.maxMicros) throw new Error('Original unsent reservation changed');
            held.status = 'reserved'; held.error = null; held.price = price; held.upperMicros = Math.max(held.upperMicros, reservation.upperMicros);
          } else { assertTrialReservation(trial, saved, reservation); saved.requests.push(reservation); }
        });
        config.modelCallsEnabled = true;
        try {
          const send = await executeNewsDraft(item, trial.modelKey, { bodyHash: prepared.request.bodyHash, baseUrl: trial.baseUrl, inputTokenUpperBound }, async () => {
            await assertTrialFiles(trial, root); await assertService();
            await changeTrialLedger(sql, trial, saved => {
              const request = saved.requests.find(request => request.key === reservation.key), now = Date.now();
              const time = trialWindow(trial, now);
              if (saved.status !== 'active' || !request || request.status !== 'reserved' || request.sentAt
                || now >= Date.parse(trial.endsAt) || now >= Date.parse(price.validUntil) || time.window !== current.window || time.day !== current.day
                || saved.requests.length > trial.maxRequests || saved.requests.filter(request => request.day === current.day || request.window === current.window).length > trial.dailyRequests
                || saved.requests.reduce((sum, request) => sum + request.upperMicros, 0) > trial.maxMicros) throw new Error('Final persistent trial send guard rejected');
              request.sentAt = new Date(now).toISOString(); request.status = 'sending';
            });
          }, trial.startedAt);
          await put('execution-' + item.articleId + '.json', send);
        } finally { config.modelCallsEnabled = false; }
        ledger = await reconcileTrialRequests(sql, trial);
        const reason = trialStopReason(trial, ledger);
        if (reason) { await changeTrialLedger(sql, trial, saved => stopTrial(saved, reason)); break; }
      }
      ledger = await reconcileTrialRequests(sql, trial);
      const leftover = await pendingNews();
      await changeTrialLedger(sql, trial, saved => Object.assign(saved.batches.at(-1)!, { finishedAt: new Date().toISOString(), pending: leftover.length,
        status: saved.status === 'stopped' ? 'stopped' : discoveries.some(source => source.status === 'unavailable') ? 'source_error' : 'ok' }));
      await put('saved-feed.json', await readPrivateNews());
      const summary = { ...intake, ...(await writeTrialReport(sql, trial, directory)), current,
        sources: discoveries.map(({ candidates: _candidates, ...source }) => source),
        modelRequests: ledger.requests.filter(request => request.window === current.window && request.sentAt).length, pendingCount: leftover.length,
        automaticRetries: 0, automaticModelChanges: 0, publicDeployment: false };
      await put('summary.json', summary); return summary;
    } catch (error) {
      config.modelCallsEnabled = false;
      await reconcileTrialRequests(sql, trial);
      const reason = String(error).slice(0, 2000);
      const pendingCount = (await pendingNews()).length;
      await changeTrialLedger(sql, trial, saved => {
        stopTrial(saved, reason);
        Object.assign(saved.batches.at(-1)!, { status: 'stopped', finishedAt: new Date().toISOString(), error: reason, pending: pendingCount });
      });
      await put('stopped.json', { reason, automaticRetries: 0 });
      await writeTrialReport(sql, trial, directory); throw error;
    }
  } catch (error) {
    // A frozen-input failure is terminal, never a restart with fresh capacity.
    await changeTrialLedger(sql, trial, saved => stopTrial(saved, String(error).slice(0, 2000))).catch(() => {});
    await writeTrialReport(sql, trial, directory).catch(() => {}); throw error;
  } finally {
    config.modelCallsEnabled = false; process.env.MODEL_CALLS_ENABLED = 'false';
    if (locked) await connection`SELECT pg_advisory_unlock(hashtext('ep-private-news-manual-v1'))`;
    connection.release(); await closeDb();
  }
}
