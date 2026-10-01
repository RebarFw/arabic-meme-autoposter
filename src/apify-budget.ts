import { limitedBytes, sha256 } from './security';
import { AppError, type Env } from './types';

export const APIFY_MAX_RUNS = 500;
// The Actor's official pricing metadata requires this minimum run ceiling.
// Keep it fixed: never automatically increase it when provider prices change.
export const APIFY_RUN_MAX_USD = 0.0073;
const RUN_MICRO = 7_300;
const FREE_MICRO = 5_000_000;
const HEADROOM_MICRO = 500_000;

interface BudgetRow {
  account_hash: string; period_start: number; period_end: number;
  runs: number; reserved_microusd: number; highest_usage_microusd: number;
  ceiling_microusd: number; account_limit_microusd: number;
  blocked: number; stop_code: string | null; updated_at: number;
}
interface Limits {
  monthlyUsageCycle: { startAt: string; endAt: string };
  limits: { maxMonthlyUsageUsd: number };
  current: { monthlyUsageUsd: number };
}
interface Usage {
  usageCycle: { startAt: string; endAt: string };
  totalUsageCreditsUsdAfterVolumeDiscount: number;
  totalUsageCreditsUsdBeforeVolumeDiscount: number;
}

function microusd(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) throw new AppError('apify_budget_unverified');
  return Math.ceil(value * 1_000_000);
}

async function api<T>(env: Env, path: string, parent?: AbortSignal, body?: Record<string, number>): Promise<T> {
  const token = env.DOWNLOADER_API_KEY?.trim();
  if (!token || !/^[A-Za-z0-9_-]{10,256}$/.test(token)) throw new AppError('invalid_downloader_key_format');
  const timeout = AbortSignal.timeout(8_000);
  let response: Response;
  try {
    response = await fetch('https://api.apify.com/v2/users/me' + path, {
      method: body ? 'PUT' : 'GET', redirect: 'manual', signal: parent ? AbortSignal.any([parent, timeout]) : timeout,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new AppError('apify_budget_unavailable', true); }
  if (!response.ok) { await response.body?.cancel(); throw new AppError(`apify_budget_http_${response.status}`, response.status === 429 || response.status >= 500); }
  // Account responses contain private profile/proxy data. Parse internally;
  // never log/return the response or any provider error message.
  try { return JSON.parse(new TextDecoder().decode(await limitedBytes(response.body, 512_000))) as T; }
  catch { throw new AppError('apify_budget_unverified'); }
}

async function snapshot(env: Env, parent?: AbortSignal, enforceLimit = false) {
  const [user, monthly, limitsResult] = await Promise.all([
    api<{ data: { id: string; plan: { tier: string; monthlyBasePriceUsd: number; monthlyUsageCreditsUsd: number } } }>(env, '', parent),
    api<{ data: Usage }>(env, '/usage/monthly', parent),
    api<{ data: Limits }>(env, '/limits', parent),
  ]);
  if (typeof user.data?.id !== 'string' || user.data.plan?.tier !== 'FREE' || user.data.plan.monthlyBasePriceUsd !== 0 || microusd(user.data.plan.monthlyUsageCreditsUsd) < FREE_MICRO) throw new AppError('apify_free_plan_required');
  let limits = limitsResult.data;
  if (enforceLimit && microusd(limits?.limits?.maxMonthlyUsageUsd) > FREE_MICRO) {
    // Lower an existing unsafe cap only. Never raise a smaller limit, change
    // data retention, add a payment method, or upgrade an account.
    await api(env, '/limits', parent, { maxMonthlyUsageUsd: 5 });
    limits = (await api<{ data: Limits }>(env, '/limits', parent)).data;
  }
  const accountLimit = microusd(limits?.limits?.maxMonthlyUsageUsd);
  if (accountLimit <= 0 || accountLimit > FREE_MICRO) throw new AppError('apify_account_limit_unsafe');
  const start = Date.parse(limits?.monthlyUsageCycle?.startAt);
  const end = Date.parse(limits?.monthlyUsageCycle?.endAt);
  const now = Date.now();
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > now || end < now || end - start > 35 * 86400_000 ||
      Date.parse(monthly.data?.usageCycle?.startAt) !== start || Date.parse(monthly.data?.usageCycle?.endAt) !== end) throw new AppError('apify_budget_cycle_unverified');
  const used = Math.max(microusd(limits?.current?.monthlyUsageUsd), microusd(monthly.data?.totalUsageCreditsUsdAfterVolumeDiscount), microusd(monthly.data?.totalUsageCreditsUsdBeforeVolumeDiscount));
  return { accountHash: await sha256(user.data.id), start, end, used, accountLimit, ceiling: Math.max(0, Math.min(FREE_MICRO, accountLimit) - HEADROOM_MICRO) };
}

async function activeStop(env: Env): Promise<BudgetRow | null> {
  // A persisted stop survives deploys, retries, token rotation and stale API
  // usage reports. Do not contact Apify again before this cycle has ended.
  return env.DB.prepare('SELECT * FROM apify_budget WHERE blocked=1 AND period_end>=? ORDER BY period_start DESC LIMIT 1').bind(Date.now()).first<BudgetRow>();
}

async function observe(env: Env, parent?: AbortSignal, enforceLimit = false): Promise<BudgetRow> {
  const data = await snapshot(env, parent, enforceLimit);
  const legacy = await env.DB.prepare("SELECT value FROM settings WHERE key='apify_usage'").first<{ value: string }>();
  let legacyRuns = 0;
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy.value);
      if (!Number.isSafeInteger(parsed.runs) || parsed.runs < 0 || parsed.runs > 40) throw new Error();
      legacyRuns = parsed.runs;
    } catch { throw new AppError('apify_legacy_budget_unverified'); }
  }
  const now = Date.now();
  await env.DB.prepare(`INSERT OR IGNORE INTO apify_budget(account_hash,period_start,period_end,runs,reserved_microusd,highest_usage_microusd,ceiling_microusd,account_limit_microusd,updated_at)
    SELECT ?,?,?,CASE WHEN EXISTS(SELECT 1 FROM apify_budget WHERE account_hash=?) THEN 0 ELSE ? END,
      CASE WHEN EXISTS(SELECT 1 FROM apify_budget WHERE account_hash=?) THEN 0 ELSE ? END,?,?,?,?`)
    .bind(data.accountHash, data.start, data.end, data.accountHash, legacyRuns, data.accountHash, legacyRuns * 50_000, data.used, data.ceiling, data.accountLimit, now).run();
  const row = await env.DB.prepare(`UPDATE apify_budget SET highest_usage_microusd=MAX(highest_usage_microusd,?),
    ceiling_microusd=MIN(ceiling_microusd,?),account_limit_microusd=?,updated_at=?
    WHERE account_hash=? AND period_start=? AND period_end=? RETURNING *`)
    .bind(data.used, data.ceiling, data.accountLimit, now, data.accountHash, data.start, data.end).first<BudgetRow>();
  if (!row) throw new AppError('apify_budget_cycle_unverified');
  return row;
}

async function latchStop(env: Env, row: BudgetRow): Promise<BudgetRow> {
  return (await env.DB.prepare(`UPDATE apify_budget SET blocked=1,stop_code=CASE WHEN runs>=? THEN 'apify_monthly_run_limit' ELSE 'apify_monthly_credit_limit' END,updated_at=?
    WHERE account_hash=? AND period_start=? AND blocked=0 AND (runs>=? OR highest_usage_microusd+reserved_microusd+?>=ceiling_microusd) RETURNING *`)
    .bind(APIFY_MAX_RUNS, Date.now(), row.account_hash, row.period_start, APIFY_MAX_RUNS, RUN_MICRO).first<BudgetRow>()) ??
    (await env.DB.prepare('SELECT * FROM apify_budget WHERE account_hash=? AND period_start=?').bind(row.account_hash, row.period_start).first<BudgetRow>())!;
}

export async function reserveApifyRun(env: Env, parent?: AbortSignal): Promise<void> {
  const stopped = await activeStop(env);
  if (stopped) throw new AppError(stopped.stop_code ?? 'apify_monthly_credit_limit');
  const row = await observe(env, parent);
  const reserved = await env.DB.prepare(`UPDATE apify_budget SET runs=runs+1,reserved_microusd=reserved_microusd+?,updated_at=?
    WHERE account_hash=? AND period_start=? AND period_end>=? AND blocked=0 AND runs<?
    AND highest_usage_microusd+reserved_microusd+?<ceiling_microusd RETURNING runs`)
    .bind(RUN_MICRO, Date.now(), row.account_hash, row.period_start, Date.now(), APIFY_MAX_RUNS, RUN_MICRO).first();
  if (!reserved) {
    const current = await latchStop(env, row);
    throw new AppError(current.stop_code ?? 'apify_budget_unverified');
  }
  await latchStop(env, row);
  // No refunds, including failed/timed-out calls. Already billed spending is
  // deliberately counted again with worst-case reservations: safer than
  // trusting delayed usage reports or releasing uncertain charges.
}

export async function apifyBudgetStatus(env: Env, enforceLimit = false) {
  const row = await activeStop(env) ?? await latchStop(env, await observe(env, undefined, enforceLimit));
  return {
    maxRuns: APIFY_MAX_RUNS, runs: row.runs, perRunMaxUsd: APIFY_RUN_MAX_USD,
    accountLimitUsd: row.account_limit_microusd / 1_000_000,
    stopThresholdUsd: row.ceiling_microusd / 1_000_000,
    reportedUsageUsd: row.highest_usage_microusd / 1_000_000,
    reservedWorstCaseUsd: row.reserved_microusd / 1_000_000,
    blocked: row.blocked === 1, stopCode: row.stop_code,
    resetsAfter: new Date(row.period_end + 1).toISOString(),
  };
}
