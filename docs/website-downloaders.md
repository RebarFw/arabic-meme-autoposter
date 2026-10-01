# Website downloader fallbacks

Inspected 2026-10-01. These are unofficial website adapters, not vendor API guarantees. Source pages and their current scripts establish the actual request formats:

| Provider | Primary evidence | Request / accepted result | Observed limitation |
| --- | --- | --- | --- |
| VideoDropper | [Homepage](https://videodropper.app/), `_app/immutable/chunks/CEx79byz.js` loaded by its form | `GET https://api.videodropper.app/allinone` with AES-128-ECB/PKCS7 URL encoded as hexadecimal in `url` header; public format constant from client script. `{video:[{video: HTTPS Meta CDN URL}]}` | Only one video accepted. Direct CDN first, observed `dl.videodropper.app` proxy second. Actual owner's test Reel returned one MP4 URL. |
| FastDL | [Website](https://fastdl.app/en5IW), `js/app.js` | `POST https://api-wh.fastdl.app/api/convert`, JSON `{target_url: canonicalReel}`; client's observed unsigned fallback when its signing module is unavailable. `video_versions[0].url`, then `url_downloadable`. | Current direct request gets Cloudflare challenge. No signing code, challenge cookies or remote executable scripts are copied. [Advertised API access](https://fastdl.app/api) is separate and requires contacting the provider. |
| SaveFrom | [Website](https://en1.savefrom.net/15xA/download-from-instagram), `build/js/workerApi.js` | `POST https://worker.savefrom.net/savefrom.php`, form from the homepage plus worker's anonymous `{url}` fallback. Accept strict JSON or a strict JSON argument to a known result callback, matching `source_url`, and an MP4 URL. | Current unsigned response says `invalid_request`. Never evaluate returned wrapper scripts, obfuscated signing modules or downloader software. |
| SnapInsta | [Website](https://snapinsta.to/en46), `snapinsta/js/app.min.js?v=7`, rendered `search-form` button | Homepage first; if it does not require a challenge, `POST /api/ajaxSearch` with `q`, `t=media`, current `v`, `lang=en`, empty `cftoken`/`html`. Accept `status=ok,v=v1,data` with explicit Download Video/MP4 anchors only. | Current entry gets Cloudflare challenge; rendered site uses Turnstile and executable `v2` results. Both fail closed. No challenge token is harvested. |

Each class implements `VideoDownloader`. The registry is replaceable and selectable in a non-secret config field; website endpoints and media allowlists belong to their own adapter. Add a new site only after verifying its real flow. No wildcard cloud-hosting allowlist is permitted.

All providers receive only the canonical public permalink. Private/restricted content is not supported, and repost permission is still required. A native request/authorized provider is tried first. Each website failure logs only provider name, job hash and fixed error code, then the next enabled provider runs. Challenges and executable response formats count as failures, never as videos.

The downloader verifies exact `video/mp4`, a bounded declared length, no content encoding, and `ftyp` bytes before accepting a response. It replays the inspected bytes through a stream rather than buffering the entire file. R2 verifies the complete streamed length; a truncated or oversized transfer cannot become a post. MP4 container detection does not replace Buffer's codec/aspect-ratio/duration checks.

Provider probes use a protected endpoint and the stored authorized job. They cancel after MP4 prefix verification and perform no posting or storage. The existing job can be retried only before any Buffer reservation exists; tombstones and per-channel reservations are retained.

## Operator recovery when Worker egress is blocked

`npm run recover:download -- JOB_HASH` optionally resolves the existing authorized Reel through VideoDropper from the operator's computer. It needs the existing Cloudflare CLI login and ignored administrator token. D1 source data and the resulting signed CDN URL remain in memory; neither is printed or saved. The resolver receives only the canonical public permalink, with no account credentials or private DM text.

The authenticated Worker checks the exact original Reel, installed sender, owned recipient, message age, trusted HTTPS CDN host and absence of **any** Buffer reservation. A conditional D1 update resumes the original job; concurrent recovery attempts cannot both succeed. The Worker then performs the actual bounded MP4 download, private R2 upload and normal immediate publishing. HTML/CAPTCHA and malformed files still fail validation. Recovery never creates a new job or removes its permanent tombstone.

This is an explicit local operator tool, not a background PC requirement or proof that future native Share DMs can always download entirely within the Worker. A working Worker-compatible provider is still needed for that fully autonomous workflow. `npm run posts:refresh -- JOB_HASH` expedites only Buffer status reads for an existing waiting job; it cannot submit another post.
