# Arabic Meme Autoposter

Private Arabic meme automation adapted from [RebarFw/meme-autoposter](https://github.com/RebarFw/meme-autoposter), reference commit `c0fe3820b0f7a27d741b3bbb615bc683a53ae276`. The English repository and its production resources are read-only references.

## Accounts and resources

- Instagram: `@avexiro0`, Buffer channel `6abea343ea19ca0bde46e40d`.
- TikTok: `@avexiro0`, Buffer channel `6abebd37ea19ca0bde48a1b8`, explicitly confirmed by the user.
- Worker: `arabic-meme-autoposter`.
- Private R2: `arabic-meme-autoposter-media`, Standard storage, two-day lifecycle rule.
- D1: `arabic-meme-autoposter-jobs`.
- Cloudflare account: `maiklkarkoch51@gmail.com`, ID `7d7578de8373f18cc730837758c40395`. Deployment uses only this project's local token and pinned account; it never falls back to the global Wrangler login. Account IDs and URLs are in `wrangler.jsonc`; runtime credentials are Worker secrets.

The Buffer API key exposes exactly this connected pair. Both IDs and usernames are pinned; ambiguous, incorrect, disconnected, locked or reminder-only channels fail closed. Before submitting each job, channel discovery rechecks the pair.

## Publishing workflow

An approved person shares a Reel in a separate 1-to-1 Instagram DM to the meme account. A minute cron polls the two exact sender-filtered conversations through Meta's Instagram Login API. It rechecks sender ID, recipient, timestamp and Reel format, commits permanent dedupe records, downloads a validated MP4 into private R2 and requests immediate automatic Buffer posts. It confirms both posts are `sent`, deletes the R2 object and revokes its temporary URL. The PC can be off.

The user approved publishing the Arabic Meta app on October 2, 2026, and its dashboard now reports Published. Webhook signature validation and GET verification are retained, but only polling ingests publishing jobs in this configuration. No App Review or group chat integration was performed.

Publishing resolved live DM visibility: the same installed receiver token immediately returned conversation data. Both separate setup DMs were read through Meta, and their two distinct sender IDs were securely installed. Polling is active. The real social posting test remains pending; see [installation evidence](docs/testing.md).

### Two-person authorization

`@avexiro0` is the only connected Instagram account, DM receiver and Instagram posting destination; TikTok posting also targets `@avexiro0`. `@rebarfw` and Michel karkoush are DM senders only. The owner's DM proof succeeded without accepting a sender tester invitation. Sender enrollment never adds a Buffer channel or connects a sender as a posting account.

Only `OWNER_IG_SENDER_ID` and `FRIEND_IG_SENDER_ID` are allowed. **Publishing stays closed until both are installed and distinct.** Usernames and display names never authorize publishing.

The administrator issues a separate random, 15-minute DM challenge for each slot. `@rebarfw` sends the owner challenge; the friend identified as Michel karkoush sends the friend challenge from his own Instagram account. Only a signed Meta notification or authenticated Meta message read supplies the real sender ID. The importer requires the active challenge hash, a recent message and the correct recipient. An optional username adds a selection check; it cannot replace the DM proof. A self-chosen challenge, expired/replaced challenge, duplicate person or third slot is rejected.

The authenticated installer sends the verified ID to Wrangler stdin as the matching Worker secret and deletes the temporary proof after the deployment confirms it. Normal status output shows booleans/counts and omits sender IDs. Polling history starts when both identities are installed.

### Dedupe policy

A canonical Reel shortcode (or stable Meta media ID when no permalink is available) can create **one permanent job across both senders**, including later DMs. Message hashes are also permanent tombstones. Removing private source contents never removes these records. When Meta exposes neither a permalink nor a stable media ID, message-level dedupe still prevents repeated delivery of that DM; identity across different attachment-only DMs cannot be guaranteed.

Each social-network delivery is reserved atomically before its Buffer mutation. A crash, timeout or ambiguous response never automatically repeats that external create. A successful network is never resubmitted after another network fails. Uncertain creates require operator reconciliation; this favors avoiding duplicate posts over blindly retrying.

### Polling and downloaders

Both people share one D1 state row, lease, backoff and bounded hash cache. Quiet runs make four small Meta GETs total. At most three unseen message details per conversation and six per run are read, with the first sender alternating for fairness. Message history is bounded to Meta's latest 20 messages and 48 hours; high-volume bursts beyond that window are not guaranteed recoverable.

The full reference downloader chain is retained: Meta attachment, authorized Meta Graph media, public Reel metadata, optional generic API, Apify Instagram Reel Scraper, VideoDropper, FastDL, SaveFrom and SnapInsta. Free direct providers run first. Apify precedes the unreliable website fallbacks as in the working project. No CAPTCHA solving, remote JavaScript execution, cookies or account credentials are sent to websites. The optional local VideoDropper recovery tool remains available for an existing approved job only.

MP4 signature, MIME, byte limits, trusted hosts, redirect destinations and full streamed length are validated. Short colloquial Arabic captions are deterministic and local, with Arabic meme hashtags and general discovery tags. Source captions are not copied.

## Cost controls

Cloudflare automation pauses at **90%** of the Workers Free/D1 Free/R2 Standard allowances, with account-wide analytics and atomic R2 reservations. Missing, partial or stale analytics fail closed. Health and protected status routes remain available during an application pause. Known-object deletion and independent R2 lifecycle expiry support cleanup. The app never upgrades a Cloudflare subscription. Analytics is delayed and sampled; this is a conservative application guard, not an account billing cap against unrelated usage or sudden bursts. See [Cloudflare limits and boundaries](docs/cloudflare-usage.md).

A newly created database can be absent from storage analytics. The manual `cloudflare:bootstrap` command can initialize one normal 60-second cache window using fresh account analytics, direct database-size measurements and a verified empty bucket. It requires this account to contain only the Arabic Worker/database/bucket, zero jobs/deliveries/reservations, complete analytics and safe usage. It adds conservative margins, preserves latched stops and never uploads the deployment token. After that window, missing storage analytics pauses automation again. This command is for initial enrollment and probes; it is not an automatic replacement for normal monitoring.

Apify requires a verified FREE plan, zero base price, $5 free credits and an account usage cap no greater than $5. Its limit is **500 reserved runs per billing cycle**, with a $0.0073 per-run ceiling and $0.50 safety margin. Delayed usage plus worst-case reservations may stop it before 500 runs. Stops persist until a verified new cycle; token rotation and redeployment do not clear them. The guard never raises a smaller account cap or upgrades a plan.

## Local commands

Use Node.js 24. Secrets and diagnostics are ignored before any project files are staged.

```powershell
npm ci
npm run check
npm run deploy
npm run secrets:install
npm run setup
npm run owner:start -- owner
npm run owner:start -- friend
npm run owner:import -- owner rebarfw SETUP_DM_CODE
npm run owner:import -- friend FRIEND_USERNAME SETUP_DM_CODE
npm run owner:finish -- owner
npm run owner:finish -- friend
npm run status
npm run polling:validate
npm run cloudflare:validate
npm run apify:budget
```

The `.secrets/` filenames are `buffer-api-key.txt`, `apify-token.txt`, `cloudflare-usage-token.txt`, `meta-access-token.txt`, and `meta-app-secret.txt`. A separate local `cloudflare-deploy-token.txt` can grant Workers Scripts Edit, Workers R2 Storage Edit, D1 Edit and Account Settings Read for the pinned account. This deployment credential is never uploaded to the Worker; its runtime analytics reader remains separate. Deployment creates project-specific `admin-token` and `meta-verify-token`. The installer uploads only nonempty runtime secret files through Wrangler stdin and prints names only. Leave the local operator tokens available for diagnostics and Meta verification; remove source credentials only after secure installation is confirmed and recovery is assured.

Deployment checks resource names and the explicitly confirmed Arabic account, creates/reuses only the Arabic resources, rejects public R2 domains, installs lifecycle expiry, applies migrations, deploys and verifies the actual URL. It never reads the English project's credentials. GitHub Actions repeats lint, typechecking, deployment authentication tests, Worker-runtime tests and a dry build without production secrets.

Current installation and real-test evidence: [testing](docs/testing.md). External Meta steps: [deployment](docs/deployment.md).
