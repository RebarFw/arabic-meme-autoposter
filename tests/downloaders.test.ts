import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiVideoDownloader, ApifyVideoDownloader, MetaGraphDownloader, PublicPageDownloader, downloadVideo } from '../src/downloaders';
import type { Env, ReelSource } from '../src/types';
import { apifyBudgetStatus } from '../src/apify-budget';
import { apifyGuardResponse } from './apify-fixture';

const source: ReelSource = {messageId:'mid',senderId:'111',recipientId:'222',timestamp:Date.now(),kind:'shared-post',mediaId:'123'};
const bindings = {...env,META_ACCESS_TOKEN:'fake-meta'} as Env;
const video = () => new Response(new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]), {headers:{'Content-Type':'video/mp4','Content-Length':'24'}});
afterEach(()=>vi.restoreAllMocks());
beforeEach(async () => { await env.DB.batch([env.DB.prepare("DELETE FROM settings WHERE key='apify_usage'"), env.DB.prepare('DELETE FROM apify_budget')]); });

it('uses official Graph metadata for ambiguous current post shares and requires a Reel', async () => {
  const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(async input => String(input).includes('graph.instagram.com')
    ? Response.json({media_type:'VIDEO',media_product_type:'REELS',media_url:'https://scontent.cdninstagram.com/clip.mp4'}) : video());
  const result = await new MetaGraphDownloader().download(source,bindings);
  expect(result.provider).toBe('meta-graph');
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValue(Response.json({media_type:'IMAGE',media_product_type:'FEED',media_url:'https://scontent.cdninstagram.com/image.jpg'}));
  await expect(new MetaGraphDownloader().download(source,bindings)).rejects.toThrow('meta_media_not_reel');
});

it('resolves published video metadata only on the canonical Reel page', async () => {
  vi.spyOn(globalThis,'fetch').mockImplementation(async input => String(input).includes('instagram.com/reel/')
    ? new Response('<meta property="og:video:secure_url" content="https://scontent.cdninstagram.com/clip.mp4?a=1&amp;b=2">') : video());
  const result = await new PublicPageDownloader().download({...source,kind:'reel',reelUrl:'https://www.instagram.com/reel/ABCdef123/'});
  expect(result.provider).toBe('instagram-public-page');
});

it('optional API uses its explicit adapter contract and requires Reel evidence for ambiguous shares', async () => {
  const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
    if(String(input).includes('api.downloader.example')) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake-optional-key');
      expect(JSON.parse(String(init?.body)).mediaId).toBe('123');
      return Response.json({videoUrl:'https://scontent.cdninstagram.com/clip.mp4',isReel:true});
    }
    return video();
  });
  const optional = {...bindings,DOWNLOADER_API_URL:'https://api.downloader.example/resolve',DOWNLOADER_API_KEY:'fake-optional-key'};
  expect((await new ApiVideoDownloader().download(source,optional)).provider).toBe('optional-downloader-api');
  fetcher.mockResolvedValue(Response.json({videoUrl:'https://scontent.cdninstagram.com/clip.mp4',isReel:false}));
  await expect(new ApiVideoDownloader().download(source,optional)).rejects.toThrow('not_reel');
});

it('rejects thumbnail MIME and backs off transient download network failures', async () => {
  const fetcher = vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('thumbnail',{headers:{'Content-Type':'image/jpeg'}}));
  const reel = {...source,kind:'reel' as const,mediaId:undefined,attachmentUrl:'https://lookaside.fbsbx.com/a'};
  await expect(downloadVideo(reel,bindings,'job')).rejects.toMatchObject({code:'no_downloader_could_resolve_reel',retryable:false});
  fetcher.mockRejectedValue(new Error('network unavailable'));
  await expect(downloadVideo(reel,bindings,'job')).rejects.toMatchObject({code:'no_downloader_could_resolve_reel',retryable:true});
});

const apifyBindings: Env = { ...bindings, DOWNLOADER_PROVIDER: 'apify', DOWNLOADER_API_KEY: 'fake-apify-api-key' };
const apifySource: ReelSource = { ...source, kind: 'reel', reelUrl: 'https://www.instagram.com/reel/ABCdef123/' };
const apifyItem = { shortCode: 'ABCdef123', type: 'Video', productType: 'clips', videoUrl: 'https://scontent.cdninstagram.com/clip.mp4' };

it('uses the real Apify Actor contract, caps costs and keeps the key away from media URLs and requests', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const guard = apifyGuardResponse(input); if (guard) return guard;
    const url = new URL(String(input));
    if (url.hostname === 'api.apify.com') {
      expect(url.pathname).toBe('/v2/actors/apify~instagram-reel-scraper/run-sync-get-dataset-items');
      expect(url.searchParams.get('maxTotalChargeUsd')).toBe('0.0073');
      expect(url.searchParams.get('maxItems')).toBe('1');
      expect(url.searchParams.get('limit')).toBe('1');
      expect(url.searchParams.has('token')).toBe(false);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake-apify-api-key');
      expect(JSON.parse(String(init?.body))).toEqual({ username: [apifySource.reelUrl], resultsLimit: 1, includeSharesCount: false, includeTranscript: false, includeDownloadedVideo: false });
      return Response.json([apifyItem]);
    }
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    return video();
  });
  expect((await new ApifyVideoDownloader().download(apifySource, apifyBindings)).provider).toBe('apify-instagram-reel');
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it('cannot use Apify without its optional key and selected provider', async () => {
  const downloader = new ApifyVideoDownloader();
  const fetcher = vi.spyOn(globalThis, 'fetch');
  for (const missing of [{ DOWNLOADER_API_KEY: undefined }, { DOWNLOADER_PROVIDER: undefined }]) {
    const incomplete = { ...apifyBindings, ...missing };
    expect(downloader.supports(apifySource, incomplete)).toBe(false);
    await expect(downloader.download(apifySource, incomplete)).rejects.toThrow('apify_not_configured');
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects wrong clips, images, feed videos and untrusted media from a downloader response', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  for (const item of [{ ...apifyItem, shortCode: 'Other123' }, { ...apifyItem, type: 'Image' }, { ...apifyItem, productType: 'feed' }, { ...apifyItem, videoUrl: 'https://evil.example/a.mp4' }]) {
    fetcher.mockImplementation(async input => apifyGuardResponse(input) ?? Response.json([item]));
    await expect(new ApifyVideoDownloader().download(apifySource, apifyBindings)).rejects.toThrow();
  }
  expect(fetcher.mock.calls.filter(([input]) => String(input).includes('/actors/'))).toHaveLength(4);
});

it('enforces the monthly credit ceiling atomically under concurrent requests', async () => {
  let actorRuns = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const guard = apifyGuardResponse(input); if (guard) return guard;
    if (String(input).includes('api.apify.com')) { actorRuns++; return Response.json([apifyItem]); }
    return video();
  });
  await apifyBudgetStatus(apifyBindings);
  await env.DB.prepare('UPDATE apify_budget SET runs=495,reserved_microusd=3613500').run();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => new ApifyVideoDownloader().download(apifySource, apifyBindings)));
  expect(actorRuns).toBe(5);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5);
  for (const result of results.filter(result => result.status === 'rejected')) expect(result.reason.code).toBe('apify_monthly_run_limit');
  expect(await env.DB.prepare('SELECT runs FROM apify_budget').first('runs')).toBe(500);
});

it('never forwards an API key to redirects and handles exhausted credits without retrying', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => apifyGuardResponse(input) ?? new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
  await expect(new ApifyVideoDownloader().download(apifySource, apifyBindings)).rejects.toMatchObject({ code: 'apify_http_302', retryable: false });
  fetcher.mockImplementation(async input => apifyGuardResponse(input) ?? new Response(null, { status: 402 }));
  await expect(new ApifyVideoDownloader().download(apifySource, apifyBindings)).rejects.toMatchObject({ code: 'apify_http_402', retryable: false });
  expect(fetcher.mock.calls.filter(([input]) => String(input).includes('/actors/'))).toHaveLength(2);
});
