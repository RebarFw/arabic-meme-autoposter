export function apifyGuardResponse(input: RequestInfo | URL): Response | undefined {
  const url = new URL(String(input));
  const startAt = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const endAt = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1) - 1).toISOString();
  if (url.hostname !== 'api.apify.com') return;
  if (url.pathname === '/v2/users/me') return Response.json({ data: { id: 'fake-apify-user', plan: { tier: 'FREE', monthlyBasePriceUsd: 0, monthlyUsageCreditsUsd: 5 } } });
  if (url.pathname === '/v2/users/me/limits') return Response.json({ data: { monthlyUsageCycle: { startAt, endAt }, limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 0 } } });
  if (url.pathname === '/v2/users/me/usage/monthly') return Response.json({ data: { usageCycle: { startAt, endAt }, totalUsageCreditsUsdAfterVolumeDiscount: 0, totalUsageCreditsUsdBeforeVolumeDiscount: 0 } });
}
