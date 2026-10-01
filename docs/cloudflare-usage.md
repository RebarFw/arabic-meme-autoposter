# Cloudflare free usage guard

The deployed guard targets **90%** of the published Workers Free, D1 Free and R2 Standard allowances. It pauses this app's ingestion and publishing when any guarded meter approaches its boundary. It does not upgrade subscriptions, enable paid products, change the Apify credit guard, or require a running PC.

| Meter | Published free allowance | Guard boundary |
| --- | --- | --- |
| Workers requests | 100,000 per UTC day | 90,000 |
| D1 rows read | 5,000,000 per UTC day | 4,500,000 |
| D1 rows written | 100,000 per UTC day | 90,000 |
| D1 storage across account | 5 GB | 4.5 GB |
| D1 storage in this database | 500 MB on Free | 450 MB |
| R2 Standard Class A operations | 1,000,000 per month | 900,000 over the previous 31 days |
| R2 Standard Class B operations | 10,000,000 per month | 9,000,000 over the previous 31 days |
| R2 Standard storage | 10 GB-month | Conservative 9.0 GB instantaneous/peak cap |

The app reserves extra room before starting work: ten requests, 1,000 D1 reads, 100 D1 writes, 1 MB database growth, ten Class A operations, twenty Class B operations and one maximum-size video. Consequently it can pause slightly before the numerical boundary. CPU/memory and other runtime restrictions remain Cloudflare's native Free-plan limits; this guard is not a meter for every Cloudflare product.

## Measurements and reservations

An account-scoped **Account → Account Analytics → Read** API token is stored only as `CLOUDFLARE_USAGE_TOKEN`. A token named “Account Analytics” with **User → API Tokens → Read** is insufficient. Scope it to the account hosting this Worker. The non-secret account/database IDs and `CLOUDFLARE_USAGE_GUARD=true` are configured in `wrangler.jsonc`.

The Worker queries Cloudflare's official GraphQL API at most once per minute, with a D1 lease to prevent simultaneous refreshes. Account-wide Workers, D1 and R2 datasets include other projects' reported use. No source URL, object name, token, private API error message or raw account response enters logs or CLI output. Partial responses, missing datasets, truncation, malformed totals, inaccessible credentials and non-Standard storage fail closed: normal work pauses until a fresh successful measurement is available.

For initial provisioning, `npm run cloudflare:bootstrap` can fill a missing new-resource storage record using authoritative REST reads. It requires the pinned Arabic account to contain exactly this Worker, database and bucket, verifies no jobs/deliveries/reservations and an empty unfiltered object listing, measures database file size, and requires all five account-wide GraphQL datasets to be complete and authorized. Conservative margins cover delayed provisioning activity; R2 metadata calls are charged conservatively to local reservations. It never disables the guard, resets a latched stop, increases a limit, uploads its deployment credential or extends the normal 60-second cache. Expiry without normal storage analytics pauses automation again. Existing jobs/media or additional account resources make this initial-only recovery unavailable.

D1 migration `0003_cloudflare_usage.sql` stores daily high watermarks, pause latches, R2 operation baselines and outstanding media reservations. Deployments and a lower later daily report cannot clear a daily pause. Workers and D1 daily budgets resume after a successful measurement on the next UTC day. R2 operations use a conservative rolling 31-day history rather than guessing a billing-month reset, so they resume when older use leaves that window. Storage resumes when reported usage and outstanding reservations fit again.

Each app R2 `put`/`list` reserves a Class A attempt atomically before making the call; `get`/`head` reserves Class B. Uncertain/failed attempts are not refunded. The ledger uses the greater of reported daily usage and the initial reported baseline plus app attempts; later analytics catching up does not count the same known attempt twice. Unknown operation types count against both classes. Multipart upload is unavailable through the guarded binding, and uploads force Standard storage.

A validated video's full byte length is reserved atomically before streaming into R2. Reservations remain until physical deletion succeeds. Daily reported storage peaks and reservations can overlap, deliberately pausing early. R2 pricing averages daily peak storage over the month; an instantaneous cap is conservative and does not maximize every GB-month of the allowance.

## Pause behavior and limitations

Polling and job processing stop before new downloads or Buffer submissions. Existing job and delivery records remain intact, preserving duplicate protection. A reservation failure during an active stage pauses the same stage without exhausting its download retry allowance. Existing temporary media URLs remain subject to their expiry and R2 operation reservations; accepted Buffer posts may still consume media while their jobs are paused. A sufficiently long pause can outlast a video's expiry or Meta's available message history. It cannot promise recovery of every DM received during a long outage.

Known expired objects can still be deleted during an R2 pause because DeleteObject is free. If the daily Workers/D1 budget is paused, the independent two-day prefix lifecycle rule remains the cleanup fallback. It does not need this Worker or the PC to run. Lifecycle deletion is asynchronous.

**This is a protective application cutoff, not a guaranteed account billing cap.** Cloudflare documents GraphQL analytics as distinct from billing measurements, and some datasets are sampled or delayed. Concurrent work, other applications and a sudden burst can use quota before analytics reflects it. Public requests, rejected requests and scheduled invocations still reach Workers; the app cannot stop them from counting merely by returning an error. Monitoring itself uses a small amount of Workers/D1 quota. It cannot stop activity by other clients in your account. Keep Workers/D1 on Free for their provider-enforced hard limits. R2 can bill excess use; budget alerts only notify and do not enforce a cap. No code can honestly guarantee an exact 90% stop or zero R2 charges under all account activity with these APIs.

## Operator checks

```powershell
npx wrangler secret put CLOUDFLARE_USAGE_TOKEN
npm run cloudflare:validate
npm run cloudflare:probe
npm run cloudflare:usage
```

`cloudflare:validate` checks the real reader and guarded capacity even before the main switch is enabled. A token rotation may take up to the one-minute cache interval to be tested. `cloudflare:usage` reports the switch, fixed pause code, safe numeric counters, thresholds and daily reset time. Both routes require `ADMIN_TOKEN`.

`cloudflare:probe` is an explicit authenticated test, not scheduled monitoring. It exercises the actual guarded upload stream with a 24-byte MP4 header, verifies HEAD/GET, physically deletes it and confirms deletion. It uses one Class A and three Class B attempts, creates no jobs or posts, publishes no media URL and accepts no arbitrary caller-supplied content. Do not use it as a repeated health check.

For a new installation, apply the migration, install the account reader, validate it and run the probe before setting `CLOUDFLARE_USAGE_GUARD=true` and deploying. An enabled guard with an unavailable reader deliberately pauses automation; do not disable it to bypass a quota stop. Token permission changes do not require redeploying the Worker.

Official contracts checked on 2026-10-01: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [R2 pricing and operation classes](https://developers.cloudflare.com/r2/pricing/), [GraphQL authentication](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/), [GraphQL measurement limitations](https://developers.cloudflare.com/analytics/graphql-api/), [adaptive sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/), and [budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/).
