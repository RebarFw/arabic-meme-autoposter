import { AppError, errorCode, log, type Env, type ReelSource } from './types';
import { limitedBytes, META_MEDIA_HOSTS, reelUrl, safeFetch, secureUrl } from './security';
import { metaRequest } from './meta';
import { downloadSignal, videoAt, type DownloadedVideo, type VideoDownloader } from './video-downloader';
import { VideoDropperDownloader } from './downloader-providers/videodropper';
import { FastDlDownloader } from './downloader-providers/fastdl';
import { SaveFromDownloader } from './downloader-providers/savefrom';
import { SnapInstaDownloader } from './downloader-providers/snapinsta';
import { APIFY_RUN_MAX_USD, reserveApifyRun } from './apify-budget';
export type { DownloadedVideo, VideoDownloader } from './video-downloader';

// Anonymous public-page metadata requests need a supported web client header;
// the default runtime client can be redirected to an unsupported-browser page.
// No login cookies or account credentials are used for this provider.
export const PUBLIC_PAGE_HEADERS = {
  Accept: 'text/html',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
};

export class MetaAttachmentDownloader implements VideoDownloader {
  readonly name = 'meta-attachment';
  supports(source: ReelSource): boolean { return !!source.attachmentUrl && source.kind === 'reel'; }
  async download(source: ReelSource, env?: Env, signal?: AbortSignal): Promise<DownloadedVideo> {
    return videoAt(source.attachmentUrl!, META_MEDIA_HOSTS, this.name, env, downloadSignal(signal, 25_000));
  }
}

export class MetaGraphDownloader implements VideoDownloader {
  readonly name = 'meta-graph';
  supports(source: ReelSource, env: Env): boolean { return !!source.mediaId && !!env.META_ACCESS_TOKEN; }
  async download(source: ReelSource, env: Env, parent?: AbortSignal): Promise<DownloadedVideo> {
    const signal = downloadSignal(parent, 35_000);
    const media = await metaRequest<{ media_type?: string; media_product_type?: string; media_url?: string; permalink?: string; caption?: string }>(env,
      `${encodeURIComponent(source.mediaId!)}?fields=media_type,media_product_type,media_url,permalink,caption`, { signal });
    if (media.media_type !== 'VIDEO' || (media.media_product_type !== 'REELS' && !reelUrl(media.permalink)) || !media.media_url) throw new AppError('meta_media_not_reel');
    return { ...await videoAt(media.media_url, META_MEDIA_HOSTS, this.name, env, signal), caption: typeof media.caption === 'string' ? media.caption : undefined };
  }
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x([a-f0-9]+);/gi, (_, n) => String.fromCharCode(parseInt(n,16))).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n,10)));
}

export class PublicPageDownloader implements VideoDownloader {
  readonly name = 'instagram-public-page';
  supports(source: ReelSource, env: Env): boolean { return !!source.reelUrl && env.ALLOW_PUBLIC_PAGE_DOWNLOADER === 'true'; }
  async download(source: ReelSource, env?: Env, parent?: AbortSignal): Promise<DownloadedVideo> {
    const signal = downloadSignal(parent, 25_000);
    const response = await safeFetch(source.reelUrl!, ['instagram.com'], { headers: PUBLIC_PAGE_HEADERS, signal });
    if (!response.ok) { await response.body?.cancel(); throw new AppError('public_page_unavailable', response.status === 429 || response.status >= 500); }
    const html = new TextDecoder().decode(await limitedBytes(response.body, 1_500_000));
    const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
    for (const tag of metaTags) {
      if (!/property\s*=\s*["']og:video(?::url|:secure_url)?["']/i.test(tag)) continue;
      const value = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (value) return videoAt(decodeHtml(value), META_MEDIA_HOSTS, this.name, env, signal);
    }
    // Narrowly accept video_url from the Reel's embedded JSON, never eval scripts.
    const encoded = /"video_url"\s*:\s*("(?:\\.|[^"\\])+")/.exec(html)?.[1];
    if (encoded) {
      let url: string;
      try { url = JSON.parse(encoded); } catch { throw new AppError('public_page_invalid_media'); }
      return videoAt(url, META_MEDIA_HOSTS, this.name, env, signal);
    }
    throw new AppError('public_page_no_video');
  }
}

export class ApiVideoDownloader implements VideoDownloader {
  readonly name = 'optional-downloader-api';
  supports(source: ReelSource, env: Env): boolean { return !!env.DOWNLOADER_API_URL && !!(source.reelUrl || source.mediaId); }
  async download(source: ReelSource, env: Env, parent?: AbortSignal): Promise<DownloadedVideo> {
    const signal = downloadSignal(parent, 25_000);
    // This is our documented adapter contract, not an invented vendor endpoint.
    const endpoint = secureUrl(env.DOWNLOADER_API_URL!, [new URL(env.DOWNLOADER_API_URL!).hostname]);
    if (/^\d|:/.test(endpoint.hostname) || !endpoint.hostname.includes('.') || endpoint.hostname.endsWith('.local')) throw new AppError('downloader_invalid_host');
    let response: Response;
    try { response = await fetch(endpoint.toString(), {
      method: 'POST', redirect: 'manual', signal,
      headers: { 'Content-Type': 'application/json', ...(env.DOWNLOADER_API_KEY ? { Authorization: `Bearer ${env.DOWNLOADER_API_KEY}` } : {}) },
      body: JSON.stringify({ url: source.reelUrl, mediaId: source.mediaId, attachmentUrl: source.attachmentUrl }),
    }); } catch { throw new AppError('downloader_api_network_error', true); }
    if (!response.ok) { await response.body?.cancel(); throw new AppError('downloader_api_error', response.status === 429 || response.status >= 500); }
    let data: { videoUrl?: string; contentType?: string; isReel?: boolean; caption?: string };
    try { data = JSON.parse(new TextDecoder().decode(await limitedBytes(response.body, 64_000))); } catch { throw new AppError('downloader_api_invalid_response'); }
    if (!data.videoUrl || (source.kind !== 'reel' && data.isReel !== true)) throw new AppError('downloader_api_not_reel');
    const hosts = [...META_MEDIA_HOSTS, ...(env.DOWNLOADER_MEDIA_HOSTS?.split(',').map(h => h.trim()).filter(h => /^[a-z0-9.-]+$/.test(h)) ?? [])];
    return { ...await videoAt(data.videoUrl, hosts, this.name, env, signal), caption: typeof data.caption === 'string' ? data.caption : undefined };
  }
}

export class ApifyVideoDownloader implements VideoDownloader {
  readonly name = 'apify-instagram-reel';
  supports(source: ReelSource, env: Env): boolean { return env.DOWNLOADER_PROVIDER === 'apify' && !!env.DOWNLOADER_API_KEY && !!reelUrl(source.reelUrl); }
  async download(source: ReelSource, env: Env, parent?: AbortSignal): Promise<DownloadedVideo> {
    const signal = downloadSignal(parent, 70_000);
    const url = reelUrl(source.reelUrl);
    if (!url || env.DOWNLOADER_PROVIDER !== 'apify' || !env.DOWNLOADER_API_KEY) throw new AppError('apify_not_configured');
    const token = env.DOWNLOADER_API_KEY.trim();
    if (!/^[A-Za-z0-9_-]{10,256}$/.test(token)) throw new AppError('invalid_downloader_key_format');
    await reserveApifyRun(env, signal);
    const query = new URLSearchParams({ timeout: '60', maxTotalChargeUsd: String(APIFY_RUN_MAX_USD), maxItems: '1', limit: '1', clean: 'true', fields: 'shortCode,type,productType,videoUrl,caption' });
    let response: Response;
    try {
      response = await fetch('https://api.apify.com/v2/actors/apify~instagram-reel-scraper/run-sync-get-dataset-items?' + query, {
        method: 'POST', redirect: 'manual', signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // These are the current Actor's documented inputs. No profile crawl,
        // transcript, paid shares feature or separately stored video copy.
        body: JSON.stringify({ username: [url], resultsLimit: 1, includeSharesCount: false, includeTranscript: false, includeDownloadedVideo: false }),
      });
    } catch { throw new AppError('apify_network_error', true); }
    if (!response.ok) { await response.body?.cancel(); throw new AppError(`apify_http_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500); }
    let items: unknown;
    try { items = JSON.parse(new TextDecoder().decode(await limitedBytes(response.body, 128_000))); }
    catch { throw new AppError('apify_invalid_response'); }
    if (!Array.isArray(items) || items.length !== 1) throw new AppError('apify_reel_not_found');
    const item = items[0];
    if (!item || typeof item !== 'object' || item.shortCode !== new URL(url).pathname.split('/')[2] || item.type !== 'Video' || item.productType !== 'clips' || typeof item.videoUrl !== 'string') throw new AppError('apify_result_not_requested_reel');
    // The key is sent only to Apify; media downloads never inherit its headers.
    return { ...await videoAt(item.videoUrl, META_MEDIA_HOSTS, this.name, env, signal), caption: typeof item.caption === 'string' ? item.caption : undefined };
  }
}

export const providers: VideoDownloader[] = [new MetaAttachmentDownloader(), new MetaGraphDownloader(), new PublicPageDownloader(), new ApiVideoDownloader(), new ApifyVideoDownloader()];
export const thirdPartyProviders: VideoDownloader[] = [new VideoDropperDownloader(), new FastDlDownloader(), new SaveFromDownloader(), new SnapInstaDownloader()];
export function configuredThirdPartyProviders(env: Env): VideoDownloader[] {
  const selected = [...new Set(env.THIRD_PARTY_DOWNLOADER_PROVIDERS?.split(',').map(s => s.trim()).filter(Boolean) ?? [])];
  return selected.map(name => {
    const provider = thirdPartyProviders.find(p => p.name === name);
    if (!provider) throw new AppError('unknown_third_party_provider');
    return provider;
  });
}

export async function downloadVideo(source: ReelSource, env: Env, jobId: string, parent?: AbortSignal, requireCaption = false): Promise<DownloadedVideo> {
  // Fit the entire chain and its streamed upload inside the job's 180s lease.
  const signal = downloadSignal(parent, 150_000);
  let retryable = false;
  let missingCaption = false;
  for (const provider of [...providers, ...configuredThirdPartyProviders(env)]) {
    if (!provider.supports(source, env)) continue;
    // These providers cannot supply an original caption. Avoid parsing a large
    // public HTML page or downloading a video that publishing must discard.
    if (requireCaption && (provider.name === 'instagram-public-page' || typeof source.title !== 'string' && provider.name === 'meta-attachment')) { missingCaption ||= typeof source.title !== 'string'; continue; }
    if (signal.aborted) throw new AppError('downloader_deadline_exceeded', true);
    try {
      const video = await provider.download(source, env, signal);
      // A share's metadata title is a fallback, never the sender's DM text or
      // an Open Graph description containing creator names and engagement counts.
      const caption = video.caption ?? source.title;
      if (requireCaption && typeof caption !== 'string') {
        await video.response.body?.cancel();
        missingCaption = true;
        log('downloader_failed', { job: jobId, provider: provider.name, code: 'source_caption_unavailable' });
        continue;
      }
      return { ...video, caption };
    }
    catch (error) { retryable ||= error instanceof AppError && error.retryable; log('downloader_failed', { job: jobId, provider: provider.name, code: errorCode(error) }); }
  }
  throw new AppError(missingCaption ? 'source_caption_unavailable' : 'no_downloader_could_resolve_reel', missingCaption || retryable);
}
