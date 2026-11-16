# YouTube Shorts rollout

The YouTube channel **Velo** (ID `6afb6107ece6dfde5fea2121`) is verified against Buffer. Existing Instagram and TikTok channel IDs are unchanged.

## Production activation
1. `npm ci && npm run check` — all existing tests and the three-channel test must pass.
2. `npm run db:remote` — apply migration **before** deploying (preserves existing deliveries).
3. `npm run deploy` — deploy updated Worker.
4. `npm run setup` — save the verified three-channel list to Cloudflare D1.
5. `npm run status` — send one **new** approved Reel and verify all three destinations report `sent`.

Existing two-channel jobs remain valid and can finish after migration. Until step 4, new jobs continue to use the two existing channels. The existing operator-only rejected-delivery retry is intentionally limited to two-channel jobs; three-channel failures need manual reconciliation.

YouTube requires title and category: the title is the first non-empty line of the cleaned caption (max 100 chars; fallback `Velo Shorts`), and the category is 23 (Comedy). YouTube determines Shorts classification from actual video dimensions/duration.
