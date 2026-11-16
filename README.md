# Arabic Meme Autoposter

AI maintainer guide for the Arabic Instagram-DM-to-social-posting Worker. Read this before changing the project. The code and configuration in this repository describe intended behavior; they do not by themselves prove what is currently deployed or connected in Meta, Buffer, or Cloudflare.

## Purpose and boundaries

This Cloudflare Worker receives eligible content shared in a one-to-one Instagram DM to `@avexiro0`, downloads and validates the video, then publishes it through Buffer to the configured Instagram, TikTok, and YouTube channels. Scheduled polling means the owner's PC does not need to stay on.

Supported inputs are Instagram Reels/shared posts, direct video attachments, and one public TikTok video link sent through Instagram DM. The project does **not** read TikTok DMs. Only the two separately verified sender IDs stored as Worker secrets may create jobs. Sender names and message text are not authorization.

The Arabic project has its own Cloudflare account, Worker, D1 database, R2 bucket, Meta credentials, Buffer key, and Apify budget. Do not copy secrets, account state, or production configuration from the English `meme-autoposter` project.

## Current implementation and rollout state

- The `main` branch includes three-channel Buffer delivery and migration `0005_youtube.sql`. The expected channel identities are pinned in `wrangler.jsonc`; Buffer discovery rejects missing, ambiguous, mismatched, disconnected, locked, or reminder-only channels.
- YouTube posting uses the first non-empty line of the cleaned caption as the title, up to 100 characters, falling back to `Velo Shorts`. Category `23` is Comedy. YouTube decides whether the uploaded video qualifies as a Short based on the video itself.
- The latest three-channel automated test uses a mocked Buffer API. It proves the code path and payload shape, not a real YouTube post.
- Production rollout on 2026-11-16: D1 migration `0005_youtube.sql` is applied and recorded, preserving prior delivery rows. Cloudflare Workers Builds successfully deployed the YouTube-enabled `main` source, and the live Worker `/health` endpoint returns `ok`. D1 `settings.channels` now lists Instagram `avexiro0`, TikTok `avexiro0`, and YouTube `Velo` (Buffer channel ID `6afb6107ece6dfde5fea2121`). The channel list was updated directly after confirming Buffer's 3/3 connected channels; `npm run setup` was not run. The YouTube entry stores the ID, name, and service used by the current publisher; run normal setup from a trusted environment if future code starts depending on additional Buffer channel metadata. A real three-platform post is still **unverified**; no public test post has been sent.

GitHub Actions in `.github/workflows/check.yml` runs checks and a dry build; it does not deploy. Cloudflare Workers Builds is connected to this repository's `main` branch with production deploy command `npx wrangler deploy`. A push to `main` triggers production deployment. This build path does **not** apply D1 migrations, install runtime secrets, or run `npm run setup`; a green build alone does not mean YouTube is active.

## How a post moves through the system

1. A signed Meta Instagram webhook and the one-minute polling job can both discover the same message. Both go through the same parser and permanent deduplication logic.
2. The Worker verifies the recipient, exact sender ID, message timestamp, supported media type, and source URL. It reserves one durable job. A Reel's canonical identity deduplicates it across both approved senders; message tombstones prevent replay.
3. The downloader chain obtains the source video. The Worker validates the MP4 signature, MIME type, allowed host and redirects, maximum size, and complete streamed length before storing it in the private R2 bucket.
4. D1 records one delivery reservation per configured social network. Buffer receives an immediate automatic video post for each channel. Existing successful deliveries are preserved if another channel fails.
5. The Worker reconciles each Buffer post until it is actually `sent`. After all configured deliveries are sent, it deletes the private R2 object and revokes the temporary media URL.

## Rules future changes must preserve

- **Authorization:** publishing remains closed unless both verified sender IDs are installed and distinct. A username, display name, or sender-provided text never substitutes for proof.
- **No duplicates:** a Buffer create with a timeout or ambiguous response may already have succeeded. Never replay it automatically. Never recreate a delivery already confirmed as sent. Reconcile uncertain Buffer posts using the operator procedure in [operations](docs/operations.md).
- **Separate delivery state:** Instagram, TikTok, and YouTube can have different outcomes. Do not mark the entire job sent based only on Buffer accepting a create; require each configured post to reach `sent`.
- **Captions:** keep the original Reel caption/title and its whitespace and hashtags, removing @mentions as implemented. Do not generate, translate, append, or substitute sender DM text. An explicitly empty caption remains empty; the configured empty-caption fallback only permits a validated video when source caption retrieval fails.
- **Media and privacy:** keep source videos in private R2, use short-lived URLs, validate every download and redirect, and delete media after delivery. Never log or return access tokens, raw DM contents, signed media URLs, or credentials.
- **External accounts and cost:** deployment must stay pinned to the Arabic Cloudflare account. Keep Apify on its verified Free plan and preserve its durable budget guard. Do not upgrade subscriptions, enable overage, or bypass quota checks.
- **Change evidence:** mocked tests and green CI are not proof of live Buffer/Meta behavior. State clearly whether a claim is code support, CI evidence, dashboard configuration, or a real production post.

## Code map

| Path | Responsibility |
|---|---|
| `src/index.ts` | Worker fetch/cron entry points, protected admin routes, Meta webhook handling, setup and status responses. |
| `src/instagram-polling.ts`, `src/meta.ts`, `src/senders.ts`, `src/owner-setup.ts` | Meta polling/webhooks, message parsing and sender enrollment/authorization. |
| `src/jobs.ts` | Durable jobs, deduplication, download and delivery state, per-channel reservations, reconciliation, and cleanup. |
| `src/downloaders.ts`, `src/video-downloader.ts`, `src/downloader-providers/` | Source selection, provider fallbacks, download streaming, and validation inputs. |
| `src/apify-download.ts`, `src/apify-budget.ts` | Optional Apify download and Free-plan spend/run controls. |
| `src/buffer.ts` | Buffer channel discovery and immediate post creation/status queries, including YouTube metadata. |
| `src/media.ts`, `src/security.ts`, `src/caption.ts` | Private R2 media lifecycle, URL/hash/video security, and caption cleaning. |
| `src/cloudflare-usage.ts`, `src/cloudflare-probe.ts` | Cloudflare quota measurement, conservative capacity guard, reservations, and explicit probe. |
| `src/privacy.ts`, `src/types.ts` | Public privacy/deletion information and shared types/error codes. |
| `migrations/` | D1 schema evolution. `0005_youtube.sql` safely widens per-job deliveries to include YouTube while preserving existing rows. |
| `scripts/` | Local operator commands for deployment, secrets, setup, status, diagnosis, and guarded recovery. |
| `tests/`, `.github/workflows/check.yml` | Worker-runtime and deployment-safety tests; CI lint, typecheck, tests, and dry build. |

## Deployment and verification

Use Node.js 24. The deployment token and runtime credentials belong in ignored local `.secrets/` files; never paste them into chat or commit them.

```powershell
npm ci
npm run check
npm run deploy
npm run setup
npm run status
```

`npm run deploy` is the local, project-pinned deployment path: it applies remote D1 migrations before deploying, installs non-empty runtime secrets, and verifies the deployment. Cloudflare Workers Builds currently runs only `npx wrangler deploy`; it does not run migrations, install runtime secrets, or setup. Before a future code change that depends on a new migration, apply the D1 migration before the code reaches the production build. `npm run setup` then rediscovers the Buffer channels and saves the verified configuration in D1; it also checks the Meta/Instagram account relationship and performs the configured Meta subscription. With YouTube expected in `wrangler.jsonc`, setup must discover exactly the pinned Instagram, TikTok, and YouTube channels or fail closed.

For YouTube activation, run the checks, deploy, run setup, then send one **new, approved** Reel and verify three `sent` delivery records with `npm run status`. The setup command is essential: until D1 stores the three-channel list, new jobs can still use the previous two-channel configuration. Do not use a real public post as a test unless the owner has approved it.

Useful read-only or guarded checks:

- `npm run polling:validate` — validate polling access and recent media visibility.
- `npm run cloudflare:validate` and `npm run cloudflare:usage` — inspect the Cloudflare guard.
- `npm run apify:budget` — inspect Apify budget state without starting an Actor.
- `npm run meta:diagnose` — inspect protected Meta connectivity.
- `npm run status` — inspect recent jobs and per-channel outcomes.

## Detailed references

- [YouTube activation and three-channel behavior](docs/youtube-rollout.md)
- [Deployment and Meta setup](docs/deployment.md)
- [Operational recovery and uncertain Buffer posts](docs/operations.md)
- [Tests and historical installation evidence](docs/testing.md)
- [Cloudflare quota guard and limitations](docs/cloudflare-usage.md)
- [Verified external API contracts](docs/api-contracts.md)
- [Downloader recovery](docs/website-downloaders.md)

## Instructions for future AI maintainers

1. Start with this README, then read the relevant source files and detailed reference docs before editing. Source code and live diagnostics take precedence over an old prose claim.
2. Preserve the security, deduplication, per-network delivery, privacy, and budget rules above. Prefer narrow changes and keep the English project and its production resources untouched.
3. After any change to behavior, supported input, channel setup, configuration, deployment, recovery, or verified production state, update this README in the same change. Update the detailed runbook or tests too when their instructions or coverage change.
4. Keep the status section honest and dated when it contains a time-sensitive claim. Separate code support from passing tests and from live deployment/post evidence. Never infer a production change from a commit or mocked test.
5. Never put secrets, DM contents, signed media URLs, or unnecessary personal/account data in this file, logs, commits, or responses.
