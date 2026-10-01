import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { configuredThirdPartyProviders, downloadVideo } from '../src/downloaders';
import { VideoDropperDownloader, encodeVideoDropperUrl } from '../src/downloader-providers/videodropper';
import { FastDlDownloader } from '../src/downloader-providers/fastdl';
import { SaveFromDownloader, saveFromResult } from '../src/downloader-providers/savefrom';
import { SnapInstaDownloader } from '../src/downloader-providers/snapinsta';
import { siteJson, siteText } from '../src/downloader-providers/shared';
import { probeThirdPartyDownload } from '../src/download-diagnostics';
import { videoAt } from '../src/video-downloader';
import type { Env, ReelSource } from '../src/types';

const source: ReelSource = { messageId: 'fallback-mid', senderId: '111', recipientId: '222', timestamp: Date.now(), kind: 'reel', reelUrl: 'https://www.instagram.com/reel/ABCdef123/' };
const bindings: Env = { ...env, THIRD_PARTY_DOWNLOADER_PROVIDERS: 'videodropper,fastdl,savefrom,snapinsta', ALLOW_PUBLIC_PAGE_DOWNLOADER: 'false', DOWNLOADER_API_URL: undefined, DOWNLOADER_API_KEY: undefined, OWNER_IG_SENDER_ID: '111' };
const clip = 'https://scontent.cdninstagram.com/clip.mp4';
const mp4 = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
const video = () => new Response(mp4, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(mp4.length) } });
afterEach(() => vi.restoreAllMocks());

it('matches the live VideoDropper request encoding and downloads the original CDN MP4 without credentials', async () => {
  const encoded = await encodeVideoDropperUrl(source.reelUrl!);
  expect(encoded).toBe('35f91d0ece1ec1b60aea4eb1c27cf17bc8f100c3bcbe89a512eceede70a87a523f6d2e68a57281efed068a0f1a578605');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.has('Authorization')).toBe(false);
    expect(headers.has('Cookie')).toBe(false);
    expect(init?.redirect).toBe('manual');
    if (String(input) === 'https://api.videodropper.app/allinone') {
      expect(headers.get('url')).toBe(encoded);
      return Response.json({ video: [{ video: clip, thumbnail: 'https://scontent.cdninstagram.com/image.jpg' }], fetch: true });
    }
    expect(headers.has('url')).toBe(false);
    expect(String(input)).toBe(clip);
    return video();
  });
  const result = await new VideoDropperDownloader().download(source, bindings);
  expect(result.provider).toBe('videodropper');
  expect(new Uint8Array(await result.response.arrayBuffer())).toEqual(mp4);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('tries providers in configured order, skips fake MP4, HTML and CAPTCHA, and stops at the first valid video', async () => {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input)); calls.push(url.hostname);
    if (url.hostname === 'api.videodropper.app') return Response.json({ video: [{ video: clip }] });
    if (url.hostname === 'scontent.cdninstagram.com' && calls.filter(h => h === url.hostname).length === 1) return new Response('<html>captcha</html>', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '20' } });
    if (url.hostname === 'dl.videodropper.app') return new Response('<html>captcha</html>', { headers: { 'Content-Type': 'text/html' } });
    if (url.hostname === 'api-wh.fastdl.app') return new Response('<title>Just a moment...</title>', { status: 403 });
    if (url.hostname === 'worker.savefrom.net') return new Response('/*js-response*/window.parent.sf.videoResult.show(' + JSON.stringify({ source_url: source.reelUrl, success: true, url: [{ type: 'mp4', url: clip }] }) + ');/*js-response*/');
    if (url.hostname === 'scontent.cdninstagram.com') return video();
    throw new Error('Unexpected request');
  });
  const result = await downloadVideo(source, bindings, 'job-hash');
  expect(result.provider).toBe('savefrom');
  expect(calls).toEqual(['api.videodropper.app', 'scontent.cdninstagram.com', 'dl.videodropper.app', 'api-wh.fastdl.app', 'worker.savefrom.net', 'scontent.cdninstagram.com']);
  await result.response.body?.cancel();
});

it('retains direct/official providers before third-party last resorts and permits disabling or reordering each site', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(video());
  const result = await downloadVideo({ ...source, attachmentUrl: clip }, bindings, 'job');
  expect(result.provider).toBe('meta-attachment');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await result.response.body?.cancel();
  expect(configuredThirdPartyProviders({ ...bindings, THIRD_PARTY_DOWNLOADER_PROVIDERS: 'snapinsta,fastdl,snapinsta' }).map(p => p.name)).toEqual(['snapinsta', 'fastdl']);
  expect(configuredThirdPartyProviders({ ...bindings, THIRD_PARTY_DOWNLOADER_PROVIDERS: '' })).toEqual([]);
  expect(() => configuredThirdPartyProviders({ ...bindings, THIRD_PARTY_DOWNLOADER_PROVIDERS: 'unknown' })).toThrow('unknown_third_party_provider');
  for (const provider of configuredThirdPartyProviders(bindings)) {
    expect(provider.supports({ ...source, kind: 'shared-post' }, bindings)).toBe(false);
    expect(provider.supports({ ...source, reelUrl: 'https://evil.example/reel/ABCdef123/' }, bindings)).toBe(false);
    expect(provider.supports(source, { ...bindings, THIRD_PARTY_DOWNLOADER_PROVIDERS: undefined })).toBe(false);
  }
});

it('validates FastDL website response and prefers its original video URL over its proxy', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).includes('api-wh.fastdl.app')) {
      expect(JSON.parse(String(init?.body))).toEqual({ target_url: source.reelUrl });
      return Response.json([{ code: 'ABCdef123', video_versions: [{ url: clip, url_downloadable: 'https://media.fastdl.app/get?signed=example' }] }]);
    }
    expect(String(input)).toBe(clip); return video();
  });
  const result = await new FastDlDownloader().download(source, bindings);
  await result.response.body?.cancel();
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValue(Response.json([{ code: 'Other123', video_versions: [{ url: clip }] }]));
  await expect(new FastDlDownloader().download(source, bindings)).rejects.toThrow('fastdl_wrong_reel');
});

it('fails over network failures without retrying the same site or carrying headers to redirects', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (String(input).includes('api.videodropper.app')) throw new Error('timed out');
    if (String(input).includes('api-wh.fastdl.app')) return Response.json({ video_versions: [{ url: clip }] });
    return video();
  });
  const result = await downloadVideo(source, bindings, 'job');
  expect(result.provider).toBe('fastdl'); await result.response.body?.cancel();
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }));
  await expect(new FastDlDownloader().download(source, bindings)).rejects.toThrow('third_party_http_302');
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('rejects unsafe media and carousel/image responses before any external media request', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  for (const data of [{ video: [{ video: 'https://127.0.0.1/a.mp4' }] }, { video: [{ video: 'https://cdninstagram.com.evil.example/a.mp4' }] }, { video: [{ video: clip }, { video: clip }] }, { image: [{ url: clip }] }]) {
    fetcher.mockResolvedValue(Response.json(data));
    await expect(new VideoDropperDownloader().download(source, bindings)).rejects.toThrow();
  }
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('rejects missing lengths, oversized media, compressed media, bad signatures and unsafe CDN redirects', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const cases: Record<string, string>[] = [{ 'Content-Type': 'video/mp4' }, { 'Content-Type': 'video/mp4', 'Content-Length': '26214401' }, { 'Content-Type': 'video/mp4', 'Content-Length': '24', 'Content-Encoding': 'gzip' }];
  for (const headers of cases) {
    fetcher.mockResolvedValue(new Response(mp4, { headers }));
    await expect(videoAt(clip, ['cdninstagram.com'], 'test', bindings)).rejects.toThrow('video_size_or_type_invalid');
  }
  fetcher.mockResolvedValue(new Response('<html>captcha</html>', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '20' } }));
  await expect(videoAt(clip, ['cdninstagram.com'], 'test', bindings)).rejects.toThrow('video_signature_invalid');
  fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://evil.example/video.mp4' } }));
  await expect(videoAt(clip, ['cdninstagram.com'], 'test', bindings)).rejects.toThrow('untrusted_url');
});

it('honors the overall deadline before starting another provider', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const controller = new AbortController(); controller.abort();
  await expect(downloadVideo(source, bindings, 'job', controller.signal)).rejects.toThrow('downloader_deadline_exceeded');
  expect(fetcher).not.toHaveBeenCalled();
});

it('parses only strict JSON in known SaveFrom callbacks and never executes result scripts', async () => {
  expect(saveFromResult('window.parent.sf.videoResult.show(' + JSON.stringify({ url: [], title: 'quoted } " text' }) + ');')).toMatchObject({ url: [] });
  expect(saveFromResult('#json#{"success":false}#json#')).toEqual({ success: false });
  expect(() => saveFromResult('eval("send secrets")')).toThrow('savefrom_script_response_unsupported');
  expect(() => saveFromResult('sf.videoResult.show({url:evil()});')).toThrow('third_party_invalid_json');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('sf.result.showEmptyResult({"success":false,"invalid_request":true});'));
  await expect(new SaveFromDownloader().download(source, bindings)).rejects.toThrow('savefrom_unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('skips SnapInsta Turnstile without submitting or solving a challenge', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<form id="search-form"><div class="cf-turnstile"></div></form>'));
  await expect(new SnapInstaDownloader().download(source, bindings)).rejects.toThrow('third_party_challenge');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('supports plain SnapInsta HTML results but rejects executable result formats and non-video links', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/en46')) return new Response('<form id="search-form"></form><script>var k_ver="v1";</script>');
    if (String(input).endsWith('/ajaxSearch')) {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('q')).toBe(source.reelUrl); expect(form.get('t')).toBe('media'); expect(form.get('cftoken')).toBe('');
      return Response.json({ status: 'ok', v: 'v1', data: '<a href="https://evil.example/ad.mp4">Ad</a><a href="' + clip + '">Download Video</a>' });
    }
    expect(String(input)).toBe(clip); return video();
  });
  const result = await new SnapInstaDownloader().download(source, bindings); await result.response.body?.cancel();
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockImplementation(async input => String(input).endsWith('/en46') ? new Response('<form id="search-form"></form><script>var k_ver="v2";</script>') : Response.json({ status: 'ok', v: 'v2', data: 'eval("payload")' }));
  await expect(new SnapInstaDownloader().download(source, bindings)).rejects.toThrow('snapinsta_plain_result_unavailable');
});

it('bounds metadata reads and refuses HTML, challenge responses and invalid JSON', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(256001)));
  await expect(siteText('https://videodropper.app/', {}, AbortSignal.timeout(1000))).rejects.toThrow('body_too_large');
  fetcher.mockResolvedValue(new Response('<title>Just a moment...</title>', { status: 403 }));
  await expect(siteText('https://videodropper.app/', {}, AbortSignal.timeout(1000))).rejects.toThrow('third_party_challenge');
  expect(() => siteJson('<html></html>')).toThrow('third_party_html_response');
  expect(() => siteJson('not-json')).toThrow('third_party_invalid_json');
});

it('probes only approved recent sources and returns MP4 facts without R2 writes or Buffer submissions', async () => {
  await env.DB.prepare('DELETE FROM deliveries').run(); await env.DB.prepare('DELETE FROM message_tombstones').run(); await env.DB.prepare('DELETE FROM jobs').run();
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES('recipient_ids',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(['222'])).run();
  await env.DB.prepare('INSERT INTO jobs(id,source_json,recipient_id,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind('probe-job', JSON.stringify(source), '222', Date.now(), Date.now(), Date.now()).run();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).includes('api.videodropper.app') ? Response.json({ video: [{ video: clip }] }) : video());
  expect(await probeThirdPartyDownload(bindings, 'videodropper')).toEqual({ provider: 'videodropper', resolved: true, contentType: 'video/mp4', bytes: 24, mp4SignatureVerified: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await env.MEDIA.list({ prefix: 'arabic-meme-autoposter/probe-job' })).objects).toHaveLength(0);
  await expect(probeThirdPartyDownload({ ...bindings, OWNER_IG_SENDER_ID: '999' }, 'videodropper')).rejects.toThrow('download_probe_not_safe');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
