# Arabic test and installation evidence

Reference source: RebarFw/meme-autoposter at c0fe3820b0f7a27d741b3bbb615bc683a53ae276. Its tests and adapters were ported. Original production posting evidence is not evidence for this Arabic installation.

On 2026-10-01, lint, TypeScript checks and 118 automated Workers-runtime tests passed (9 test files). Coverage includes exact sender A/B, rejected strangers, isolated expiring setup proofs, duplicate DM delivery, same Reel across senders, downloader failover and validation, Apify budget latching, Cloudflare guards, private media URL controls, deletion after both posts are sent, uncertain Buffer submissions, one-network failure without duplication, Arabic captions, account pinning and secret redaction. GitHub Actions repeats the checks without credentials.

Live account reads verified:

- Buffer's new API key exposes only Instagram @avexiro0 and TikTok @samixr4. Both are connected/unlocked; TikTok has defaultToReminders=false.
- Apify is FREE with $5 credit, a $5 account limit and zero observed usage at setup. No Actor was run by account discovery.
- Wrangler is authenticated to account 97d19512e831722d5d48aa2d05086716. Separate Arabic R2 and D1 resources were created. Managed R2 public access is disabled and no enabled custom domain exists; the two-day Arabic prefix lifecycle rule is installed.
- The local Meta token and app-secret files were initially empty. No Meta authorization, sender enrollment or real Arabic post has been claimed on that basis.

The Arabic Worker is deployed at https://arabic-meme-autoposter.meme-autoposter.workers.dev. Live health, Meta GET verification and unauthorized admin rejection passed. The secure bulk upload installed BUFFER_API_KEY, DOWNLOADER_API_KEY, CLOUDFLARE_USAGE_TOKEN, ADMIN_TOKEN and META_VERIFY_TOKEN; neither empty Meta file was uploaded. Fresh operator tokens belong to this project only.

The live Apify guard reports maxRuns=500, accountLimitUsd=5, stopThresholdUsd=4.5, zero reserved runs and a verified cycle reset at 2026-11-01T00:00:00Z. No Actor run or social post was created.

The supplied Cloudflare token is active, but the GraphQL reader fails account authorization. Its current token cannot read the target account's analytics. The runtime correctly fails closed; protected status and public health stay accessible. Status confirms zero jobs, zero deliveries, no installed senders and polling uninitialized. A correctly scoped Account Analytics Read token is required before the guarded R2 transfer probe can run. No guard was disabled to work around this failure.

Pending live verification: a working Cloudflare analytics reader and guarded R2 upload/read/delete probe, Meta credential installation and account access, the two actual setup DMs, and an approved Reel reaching both Arabic social networks with remote R2 deletion. A deployed Worker and passing mocked tests are not proof of a real Arabic social post.

The original local English checkout remained clean at c0fe3820b0f7a27d741b3bbb615bc683a53ae276. No English Worker, D1, bucket, secret or configuration was mutated.
