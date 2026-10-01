const privacyPolicy = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="How Arabic Meme Autoposter processes Instagram messages and temporarily stores authorized videos for publishing.">
  <title>Privacy Policy | Arabic Meme Autoposter</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f5f7fa; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 48px 20px; line-height: 1.7; }
    main { max-width: 760px; margin: auto; padding: 40px; background: white; border: 1px solid #e1e6ef; border-radius: 16px; }
    .brand { margin: 0 0 8px; color: #43516c; font-weight: 650; font-size: 14px; }
    h1 { margin: 0; font-size: clamp(30px, 6vw, 42px); line-height: 1.2; letter-spacing: -1px; }
    h2 { margin: 30px 0 8px; font-size: 20px; line-height: 1.4; }
    p, ul { margin: 10px 0; }
    .updated, footer { color: #526078; font-size: 14px; }
    a { color: #1756a9; text-underline-offset: 3px; }
    a:focus-visible { outline: 3px solid #1756a9; outline-offset: 3px; }
    footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #e1e6ef; }
    @media (max-width: 540px) { body { padding: 20px 12px; } main { padding: 26px 22px; } }
  </style>
</head>
<body>
<main>
  <p class="brand">Arabic Meme Autoposter</p>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: <time datetime="2026-10-01">October 1, 2026</time></p>

  <p>Arabic Meme Autoposter is a private automation operated by the owner of its connected Instagram and TikTok meme accounts. It processes Instagram messages to repost videos that the owner has permission to share.</p>

  <h2>Information we process</h2>
  <p>Instagram sends message events through Meta's API. These can include sender and recipient account IDs, a message ID, a timestamp, message text, and shared media URLs, IDs or captions. The app checks the sender against the two separately approved Instagram-scoped sender IDs. Messages from other senders do not create publishing jobs or posts.</p>
  <p>The owner has enabled scheduled API reads, normally once per minute, of the two separate one-to-one conversations with the approved people. During sender setup, an authenticated administrator may check a limited number of recent messages to match the exact setup message and selected username. Unrelated message contents are discarded. Signed webhook notifications are also validated, but only one ingestion method creates publishing jobs at a time.</p>
  <p>For an approved Reel, we process the video, generate a short caption, and store job status, channel IDs and Buffer post IDs to track publication and prevent duplicate posts. Access tokens and API keys are stored as Cloudflare Worker secrets.</p>

  <h2>How we use information</h2>
  <p>We use this information to verify authorized requests, obtain the shared video, publish it to the owner's connected channels, confirm publication, resolve errors and delete temporary files. If enabled, the app sends the owner a completion message through Instagram. We do not sell personal information or use message data for advertising.</p>

  <h2>Services that receive information</h2>
  <ul>
    <li><strong>Meta / Instagram:</strong> provides authorized conversation and message reads, signed message events, media and optional message replies.</li>
    <li><strong>Cloudflare:</strong> hosts the app, stores job records, and temporarily stores videos in a private R2 bucket.</li>
    <li><strong>Buffer:</strong> receives the video through an expiring link, its caption and the selected channel information to publish to Instagram and TikTok.</li>
    <li><strong>Apify:</strong> receives the approved public Reel permalink as a budget-controlled fallback, never private message contents or sender IDs.</li>
    <li><strong>Downloader providers:</strong> the owner has enabled VideoDropper, FastDL, SaveFrom and SnapInsta as sequential last-resort fallbacks. A provider receives only the canonical public Reel URL needed to obtain its video; Instagram, Buffer and administrator credentials, sender IDs and private message text are never sent to these sites. An optional API provider can also be configured by the owner.</li>
  </ul>
  <p>Published videos and captions are visible according to the Instagram and TikTok accounts' settings. These providers process information under their own policies, including <a href="https://www.facebook.com/privacy/policy/">Meta's Privacy Policy</a>, <a href="https://www.tiktok.com/legal/page/eea/privacy-policy/en">TikTok's Privacy Policy</a>, <a href="https://buffer.com/legal#privacy-policy">Buffer's Privacy Policy</a> and <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare's Privacy Policy</a>.</p>

  <h2>Storage and retention</h2>
  <p>Temporary videos are deleted after both posts are confirmed as sent, or when they are no longer needed after a known failure. Video access links normally expire after 24 hours. Cleanup removes expired or stuck files, with a separate R2 rule that expires the app's files after two days; physical deletion may take additional time to complete.</p>
  <p>Stored source message details, media URLs and generated captions are normally removed about two days after a job finishes or is marked for attention. Minimal job hashes, recipient and channel IDs, publication records and error codes are retained to prevent duplicates and support operation. Polling retains a small bounded set of message hashes and operational timestamps. The one-time sender setup stores a hash of its authorization code and the verified sender ID; this temporary proof is removed after setup completes or its 15-minute validity expires. The two approved sender IDs and credentials are retained until the owner replaces or removes them. Service logs and provider backups follow the applicable service's retention settings.</p>
  <p>Deleting the app's temporary copy does not delete a video already published on Instagram or TikTok, or copies retained by those services.</p>

  <h2>Security and website visits</h2>
  <p>The app validates Meta webhook signatures and accepts publishing requests only from the two approved sender IDs. Video storage is private, and temporary download links require an expiring access token. Operational logs avoid message content, source URLs and secrets.</p>
  <p>This privacy page sets no cookies and includes no analytics or tracking scripts. Cloudflare may process technical information such as IP addresses and request metadata to deliver and protect the service.</p>

  <h2 id="contact">Contact and deletion requests</h2>
  <p>To ask about this policy or request access, correction or deletion of information processed by Arabic Meme Autoposter, contact the owner by direct message to the Instagram meme account that you messaged. Start your message with <strong>“Arabic Meme Autoposter privacy request”</strong> and describe your request. The owner may need to verify your identity before acting on it.</p>
  <p>To request removal of a published video, identify the Instagram or TikTok post in your message. You can also revoke the app's access through your account's app permissions settings.</p>

  <h2>Changes to this policy</h2>
  <p>Updates will be published on this page with a revised date.</p>
  <footer>Arabic Meme Autoposter · Privacy Policy</footer>
</main>
</body>
</html>`;

export function privacyResponse(method: string): Response {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (!['GET','HEAD'].includes(method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' } });
  return new Response(method === 'HEAD' ? null : privacyPolicy, { headers });
}
