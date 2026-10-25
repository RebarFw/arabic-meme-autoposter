import { APIFY_RUN_MAX_USD, reserveApifyRun } from './apify-budget';
import { limitedBytes, reelUrl, sha256 } from './security';
import { AppError, DownloadDeferred, type Env, type ReelSource } from './types';

const ACTOR = 'apify~instagram-reel-scraper';
const MAX_ATTEMPTS = 3;
const RUN_TIMEOUT_SECONDS = 600;
interface State {
  reelHash: string; state: 'new' | 'starting' | 'uncertain' | 'running' | 'succeeded' | 'failed';
  attempts: number; startedAt: number; nextAt: number; expiresAt: number;
  runId?: string; datasetId?: string; errorCode?: string; reconciliations?: number;
}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9]{1,80}$/.test(value);
const pending = (code = 'apify_run_pending', at = Date.now() + 60_000): never => { throw new DownloadDeferred(code, at); };

// Only one capped Actor start per persisted attempt. Cloud polling resumes the
// same run after an HTTP disconnect or Worker restart; it never restarts a
// still-running scrape simply because a minute passed.
export async function asyncApifyItems(source: ReelSource, env: Env, jobId: string): Promise<unknown> {
  const url = reelUrl(source.reelUrl);
  const token = env.DOWNLOADER_API_KEY?.trim();
  if (env.DOWNLOADER_PROVIDER !== 'apify' || !url || !/^[a-f0-9]{64}$/.test(jobId) || !token || !/^[A-Za-z0-9_-]{10,256}$/.test(token)) throw new AppError('apify_not_configured');
  const key = 'apify_download:' + jobId;
  const hash = await sha256(url);
  async function save(state: State) { await env.DB.prepare('UPDATE settings SET value=? WHERE key=?').bind(JSON.stringify(state), key).run(); }
  async function request(path: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch('https://api.apify.com/v2/' + path, {
        method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new AppError(body ? 'apify_start_uncertain' : 'apify_status_unavailable', true); }
    if (!response.ok) {
      await response.body?.cancel();
      if (body && (response.status >= 500 || response.status === 408)) throw new AppError('apify_start_uncertain', true);
      throw new AppError(`apify_http_${response.status}`, response.status >= 500 || response.status === 429 || response.status === 408);
    }
    try { return JSON.parse(new TextDecoder().decode(await limitedBytes(response.body, 128_000))); }
    catch { throw new AppError(body ? 'apify_start_uncertain' : 'apify_invalid_response', true); }
  }
  const initial: State = { reelHash: hash, state: 'new', attempts: 0, startedAt: 0, nextAt: 0, expiresAt: source.timestamp + 48 * 3600_000 };
  await env.DB.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').bind(key, JSON.stringify(initial)).run();
  const stored = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first<{ value: string }>();
  let state: State = JSON.parse(stored!.value);
  if (state.reelHash !== hash || state.expiresAt <= Date.now()) throw new AppError('apify_download_identity_or_expiry');
  if (state.nextAt > Date.now()) pending(state.errorCode ?? 'apify_run_pending', state.nextAt);

  if (state.state === 'new' || state.state === 'failed') {
    if (state.attempts >= MAX_ATTEMPTS) throw new AppError(state.errorCode ?? 'apify_run_attempts_exhausted');
    const now = Date.now();
    const claimed = await env.DB.prepare(`UPDATE settings SET value=json_set(value,'$.state','starting','$.attempts',json_extract(value,'$.attempts')+1,'$.startedAt',?,'$.nextAt',?)
      WHERE key=? AND json_extract(value,'$.state') IN ('new','failed') AND json_extract(value,'$.nextAt')<=?
      AND (SELECT COUNT(*) FROM settings WHERE key LIKE 'apify_download:%' AND json_extract(value,'$.state') IN ('starting','uncertain','running') AND json_extract(value,'$.startedAt')>?)<4
      RETURNING value`).bind(now, now + 60_000, key, now, now - 12 * 60_000).first<{ value: string }>();
    if (!claimed) pending('apify_concurrency_wait');
    state = JSON.parse(claimed!.value);
    try { await reserveApifyRun(env); }
    catch (error) {
      const nextAt = Date.now() + 5 * 60_000;
      await save({ ...state, state: 'failed', attempts: state.attempts - 1, nextAt });
      if (error instanceof AppError && error.retryable) pending(error.code, nextAt);
      throw error;
    }
    let run: Record<string, unknown>;
    try {
      const query = new URLSearchParams({ timeout: String(RUN_TIMEOUT_SECONDS), maxTotalChargeUsd: String(APIFY_RUN_MAX_USD), maxItems: '1', waitForFinish: '0' });
      const result = await request(`actors/${ACTOR}/runs?${query}`, { username: [url], resultsLimit: 1, includeSharesCount: false, includeTranscript: false, includeDownloadedVideo: false });
      run = result.data as Record<string, unknown>;
      if (!run || !validId(run.id) || !validId(run.defaultDatasetId)) throw new AppError('apify_start_uncertain', true);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'apify_start_uncertain';
      if (code === 'apify_start_uncertain') {
        await save({ ...state, state: 'uncertain', errorCode: code, nextAt: Date.now() + 60_000 });
        pending(code);
      }
      await save({ ...state, state: 'failed', errorCode: code, nextAt: Date.now() + 15 * 60_000 });
      if (error instanceof AppError && error.retryable) pending(code, Date.now() + 15 * 60_000);
      throw error;
    }
    state = { ...state, state: 'running', runId: String(run!.id), datasetId: String(run!.defaultDatasetId), nextAt: 0, errorCode: undefined };
    await save(state);
    pending();
  }

  try {
    if (state.state === 'starting' || state.state === 'uncertain') {
      // Reconcile an ambiguous start before allowing any new start. Only this
      // Actor, the exact input Reel, time and capped options can be adopted.
      const list = await request(`actors/${ACTOR}/runs?desc=1&limit=10`);
      const items = (list.data as { items?: Record<string, unknown>[] })?.items ?? [];
      const candidates = items.filter(run => Date.parse(String(run.startedAt)) >= state.startedAt - 5000 && validId(run.id) && validId(run.defaultKeyValueStoreId));
      const matches = [];
      for (const run of candidates.slice(0, 3)) {
        const input = await request(`key-value-stores/${run.defaultKeyValueStoreId}/records/INPUT`);
        const opts = run.options as { maxTotalChargeUsd?: number; timeoutSecs?: number } | undefined;
        if (Array.isArray(input.username) && input.username.length === 1 && reelUrl(input.username[0]) === url && validId(run.defaultDatasetId) && opts?.maxTotalChargeUsd === APIFY_RUN_MAX_USD && (opts.timeoutSecs ?? Infinity) <= RUN_TIMEOUT_SECONDS) matches.push(run);
      }
      if (matches.length !== 1) {
        state.reconciliations = (state.reconciliations ?? 0) + 1;
        await save(state);
        if (matches.length > 1 || state.reconciliations >= 3) throw new AppError('apify_start_uncertain');
        pending('apify_start_uncertain');
      }
      state = { ...state, state: 'running', runId: String(matches[0]!.id), datasetId: String(matches[0]!.defaultDatasetId), nextAt: 0 };
      await save(state);
    }
    if (!validId(state.runId) || !validId(state.datasetId)) throw new AppError('apify_invalid_run');
    if (state.state !== 'succeeded') {
      const result = await request(`actor-runs/${state.runId}`);
      const run = result.data as { id?: string; status?: string; defaultDatasetId?: string } | undefined;
      if (run?.id !== state.runId || run.defaultDatasetId !== state.datasetId) throw new AppError('apify_invalid_run');
      if (['READY','RUNNING','TIMING-OUT','ABORTING'].includes(run.status ?? '')) pending();
      if (run.status !== 'SUCCEEDED') {
        const code = run.status === 'TIMED-OUT' ? 'apify_run_timed_out' : 'apify_run_failed';
        state = { ...state, state: 'failed', errorCode: code, nextAt: Date.now() + (state.attempts === 1 ? 15 : 120) * 60_000 };
        await save(state);
        if (state.attempts >= MAX_ATTEMPTS) throw new AppError(code);
        pending(code, state.nextAt);
      }
      state = { ...state, state: 'succeeded', nextAt: 0, errorCode: undefined };
      await save(state);
    }
    return await request(`datasets/${state.datasetId}/items?limit=2&clean=true&fields=shortCode,type,productType,videoUrl,caption,error`);
  } catch (error) {
    if (error instanceof AppError && !(error instanceof DownloadDeferred) && error.retryable) pending(error.code, Date.now() + 5 * 60_000);
    throw error;
  }
}
