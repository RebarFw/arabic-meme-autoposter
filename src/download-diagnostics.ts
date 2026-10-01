import { limitedBytes, META_MEDIA_HOSTS, reelUrl, secureUrl } from './security';
import { AppError, errorCode, type Env, type ReelSource } from './types';
import { ApifyVideoDownloader, configuredThirdPartyProviders, PUBLIC_PAGE_HEADERS } from './downloaders';
import { SiteResponseError } from './downloader-providers/shared';
import { senderAllowed } from './senders';

export async function probeThirdPartyDownload(env: Env, name: string) {
  const provider = configuredThirdPartyProviders(env).find(p => p.name === name);
  if (!provider) throw new AppError('unknown_third_party_provider');
  const source = await authorizedProbeSource(env);
  if (!provider.supports(source, env)) throw new AppError('download_probe_not_safe');
  try {
    const video = await provider.download(source, env);
    const length = Number(video.response.headers.get('content-length'));
    await video.response.body?.cancel();
    return { provider: name, resolved: true, contentType: 'video/mp4', bytes: length, mp4SignatureVerified: true };
  } catch (error) { return { provider: name, resolved: false, code: errorCode(error), ...(error instanceof SiteResponseError ? { facts: error.facts } : {}) }; }
}

async function authorizedProbeSource(env: Env): Promise<ReelSource> {
  const row = await env.DB.prepare('SELECT source_json FROM jobs WHERE source_json IS NOT NULL ORDER BY created_at DESC LIMIT 1').first<{ source_json: string }>();
  if (!row) throw new AppError('job_source_missing');
  const source: ReelSource = JSON.parse(row.source_json);
  const recipients = await env.DB.prepare("SELECT value FROM settings WHERE key='recipient_ids'").first<{ value: string }>();
  if (source.kind !== 'reel' || !senderAllowed(env, source.senderId) || !recipients || !JSON.parse(recipients.value).includes(source.recipientId) || !Number.isFinite(source.timestamp) || Date.now() - source.timestamp > 48 * 3600_000 || source.timestamp > Date.now() + 300_000) throw new AppError('download_probe_not_safe');
  return source;
}

// Explicit operator test of the optional API. Uses the existing per-run/monthly
// credit ceilings; never changes jobs, writes R2, or calls Buffer. Drain the
// validated MP4 to prove the entire Worker transfer, rather than just its URL.
export async function probeApifyDownload(env: Env) {
  const source = await authorizedProbeSource(env);
  const provider = new ApifyVideoDownloader();
  if (!provider.supports(source, env)) throw new AppError('apify_not_configured');
  try {
    const video = await provider.download(source, env);
    const length = Number(video.response.headers.get('content-length'));
    const reader = video.response.body!.getReader();
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > length) throw new AppError('video_length_mismatch');
      }
      if (bytes !== length) throw new AppError('video_length_mismatch');
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    return { provider: provider.name, resolved: true, contentType: 'video/mp4', bytes, mp4SignatureVerified: true, fullDownloadVerified: true };
  } catch (error) { return { provider: provider.name, resolved: false, code: errorCode(error) }; }
}

function urlFacts(raw: string) {
  try {
    const url = new URL(raw);
    let trustedMedia = false;
    try { secureUrl(raw, META_MEDIA_HOSTS); trustedMedia = true; } catch { /* Facts only; never follow an untrusted candidate. */ }
    return { length: raw.length, https: url.protocol === 'https:', trustedMedia, isReelPage: !!reelUrl(raw), unsupportedBrowser: url.pathname === '/unsupportedbrowser', hostClass: ['instagram.com', 'facebook.com', 'meta.com', ...META_MEDIA_HOSTS].find(host => url.hostname === host || url.hostname.endsWith('.' + host)) ?? 'other' };
  } catch { return { invalid: true }; }
}

// Read-only, admin-protected inspection. No source URLs, contents, credentials,
// post creation, R2 writes or unrestricted requests are returned or performed.
export async function diagnoseDownload(env: Env, route: 'reel' | 'post' | 'embed' = 'reel') {
  const row = await env.DB.prepare('SELECT source_json FROM jobs WHERE source_json IS NOT NULL ORDER BY created_at DESC LIMIT 1').first<{ source_json: string }>();
  if (!row) return { jobFound: false };
  const source: ReelSource = JSON.parse(row.source_json);
  if (!source.reelUrl || !reelUrl(source.reelUrl)) return { jobFound: true, reelPermalink: false, mediaId: !!source.mediaId, attachment: !!source.attachmentUrl };
  let url = secureUrl(source.reelUrl, ['instagram.com']);
  const shortcode = url.pathname.split('/')[2]!;
  if (route === 'post') url.pathname = `/p/${shortcode}/`;
  if (route === 'embed') url.pathname = `/p/${shortcode}/embed/`;
  for (let i = 0; i < 4; i++) {
    let response: Response;
    try { response = await fetch(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: PUBLIC_PAGE_HEADERS }); }
    catch { return { jobFound: true, stage: 'page_fetch', error: 'network_error' }; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) return { jobFound: true, stage: 'page_redirect', error: 'missing_location' };
      const target = new URL(location, url).toString();
      try { url = secureUrl(target, ['instagram.com']); }
      catch { return { jobFound: true, stage: 'page_redirect', httpStatus: response.status, destination: urlFacts(target) }; }
      continue;
    }
    const status = response.status;
    const contentType = response.headers.get('content-type')?.split(';')[0];
    if (!response.ok) { await response.body?.cancel(); return { jobFound: true, stage: 'page_fetch', httpStatus: status }; }
    let html: string;
    try { html = new TextDecoder().decode(await limitedBytes(response.body, 1_500_000)); }
    catch (error) { return { jobFound: true, stage: 'page_read', error: errorCode(error) }; }
    const candidates: ReturnType<typeof urlFacts>[] = [];
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
      if (!/property\s*=\s*["']og:video(?::url|:secure_url)?["']/i.test(tag)) continue;
      const value = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (value) candidates.push(urlFacts(value.replace(/&amp;/g, '&').replace(/&quot;/g, '"')));
    }
    return { jobFound: true, route, stage: 'page_metadata', httpStatus: status, contentType, htmlLength: html.length, metaVideos: candidates.slice(0, 6), videoUrlField: html.includes('"video_url"'), escapedVideoUrlField: html.includes('\\"video_url\\"'), videoVersionsField: html.includes('video_versions'), loginForm: /\/accounts\/login\//.test(url.pathname) };
  }
  return { jobFound: true, stage: 'page_redirect', error: 'too_many_redirects' };
}
