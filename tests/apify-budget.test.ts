import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apifyBudgetStatus, reserveApifyRun } from '../src/apify-budget';
import type { Env } from '../src/types';
import { apifyGuardResponse } from './apify-fixture';

const bindings: Env = { ...env, DOWNLOADER_PROVIDER: 'apify', DOWNLOADER_API_KEY: 'fake-apify-api-key' };
beforeEach(async () => { await env.DB.batch([env.DB.prepare('DELETE FROM apify_budget'), env.DB.prepare("DELETE FROM settings WHERE key='apify_usage'")]); });
afterEach(() => vi.restoreAllMocks());

function mockAccount({ used = 0, limit = 5, free = true, malformed = false } = {}) {
  let currentLimit = limit;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe('api.apify.com');
    expect(url.searchParams.has('token')).toBe(false);
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake-apify-api-key');
    if (init?.method === 'PUT') {
      expect(url.pathname).toBe('/v2/users/me/limits');
      expect(JSON.parse(String(init.body))).toEqual({ maxMonthlyUsageUsd: 5 });
      currentLimit = 5;
      return Response.json({});
    }
    const response = apifyGuardResponse(input);
    if (!response) throw new Error('Actor must not be called by budget checks');
    const data = (await response.json()) as Record<string, Record<string, unknown>>;
    if (url.pathname === '/v2/users/me') {
      data.data!.plan = { tier: free ? 'FREE' : 'STARTER', monthlyBasePriceUsd: free ? 0 : 39, monthlyUsageCreditsUsd: free ? 5 : 39 };
      data.data!.email = 'private@example.invalid';
      data.data!.proxy = { password: 'private-proxy-password' };
    }
    if (url.pathname.endsWith('/limits')) {
      data.data!.limits = { maxMonthlyUsageUsd: currentLimit };
      data.data!.current = { monthlyUsageUsd: used };
    }
    if (url.pathname.endsWith('/usage/monthly')) {
      data.data!.totalUsageCreditsUsdAfterVolumeDiscount = malformed ? null : used;
      data.data!.totalUsageCreditsUsdBeforeVolumeDiscount = used;
    }
    return Response.json(data);
  });
  return fetcher;
}

it('counts other account spending and permanently stops before crossing the buffered credit threshold', async () => {
  const fetcher = mockAccount({ used: 2.999 });
  await apifyBudgetStatus(bindings);
  await env.DB.prepare('UPDATE apify_budget SET reserved_microusd=1500000').run();
  await expect(reserveApifyRun(bindings)).rejects.toThrow('apify_monthly_credit_limit');
  const row = await env.DB.prepare('SELECT blocked,runs FROM apify_budget').first();
  expect(row).toEqual({ blocked: 1, runs: 0 });
  fetcher.mockClear();
  fetcher.mockRejectedValue(new Error('Usage report unavailable or stale'));
  await expect(reserveApifyRun(bindings)).rejects.toThrow('apify_monthly_credit_limit');
  expect((await apifyBudgetStatus(bindings)).blocked).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

it('atomically admits only one concurrent run near the money boundary and never refunds reservations', async () => {
  mockAccount({ used: 4.49 });
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => reserveApifyRun(bindings)));
  expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await env.DB.prepare('SELECT runs,reserved_microusd,blocked FROM apify_budget').first()).toEqual({ runs: 1, reserved_microusd: 7300, blocked: 1 });
});

it('fails closed on unsafe account limits, paid plans, malformed reports and unavailable usage', async () => {
  for (const options of [{ limit: 6 }, { free: false }, { malformed: true }]) {
    const fetcher = mockAccount(options);
    await expect(reserveApifyRun(bindings)).rejects.toThrow();
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes('/actors/'))).toBe(true);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM apify_budget').first('n')).toBe(0);
    vi.restoreAllMocks();
  }
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network failure'));
  await expect(reserveApifyRun(bindings)).rejects.toThrow('apify_budget_unavailable');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM apify_budget').first('n')).toBe(0);
});

it('lowers an unsafe platform limit to $5 and verifies it while preserving a smaller existing limit', async () => {
  const fetcher = mockAccount({ limit: 10 });
  expect((await apifyBudgetStatus(bindings, true)).accountLimitUsd).toBe(5);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  vi.restoreAllMocks();
  const lower = mockAccount({ limit: 4 });
  const status = await apifyBudgetStatus(bindings, true);
  expect(status.accountLimitUsd).toBe(4);
  expect(status.stopThresholdUsd).toBe(3.5);
  expect(lower.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  expect(JSON.stringify(status)).not.toContain('private');
  expect(JSON.stringify(status)).not.toContain('fake-apify-user');
});

it('imports existing attempts once at their old worst-case cost and resets only after the billing cycle ends', async () => {
  mockAccount();
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES ('apify_usage',?)").bind(JSON.stringify({ month: '2026-10', runs: 2 })).run();
  let status = await apifyBudgetStatus(bindings);
  expect(status.runs).toBe(2);
  expect(status.reservedWorstCaseUsd).toBe(0.1);
  await reserveApifyRun(bindings);
  status = await apifyBudgetStatus(bindings);
  expect(status.runs).toBe(3);
  expect(status.reservedWorstCaseUsd).toBe(0.1073);
  await env.DB.prepare("UPDATE apify_budget SET period_start=?,period_end=?,blocked=1,stop_code='apify_monthly_credit_limit'").bind(Date.now() - 31 * 86400_000, Date.now() - 1).run();
  status = await apifyBudgetStatus(bindings);
  expect(status.runs).toBe(0);
  expect(status.reservedWorstCaseUsd).toBe(0);
  expect(status.blocked).toBe(false);
});

it('keeps the highest observed usage when later provider reports regress', async () => {
  mockAccount({ used: 2 });
  await apifyBudgetStatus(bindings);
  vi.restoreAllMocks();
  mockAccount({ used: 1 });
  expect((await apifyBudgetStatus(bindings)).reportedUsageUsd).toBe(2);
});

it('does not change limits or start a ledger when the account is on a paid plan', async () => {
  const fetcher = mockAccount({ free: false, limit: 100 });
  await expect(apifyBudgetStatus(bindings, true)).rejects.toThrow('apify_free_plan_required');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM apify_budget').first('n')).toBe(0);
});
