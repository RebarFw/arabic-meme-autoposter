import { limitedBytes, reelUrl, secureUrl } from '../security';
import { AppError, type Env, type ReelSource } from '../types';
import { videoAt, type DownloadedVideo } from '../video-downloader';

export class SiteResponseError extends AppError {
  constructor(code: string, public readonly facts: { httpStatus?: number; challengeHeader?: boolean; resultKeys?: string[]; hasVideoVersions?: boolean; codeMatchesReel?: boolean; sourceMatchesReel?: boolean }) { super(code); }
}

export function enabled(id: string, source: ReelSource, env: Env): boolean {
  return !!env.THIRD_PARTY_DOWNLOADER_PROVIDERS?.split(',').map(s => s.trim()).includes(id) && source.kind === 'reel' && !!reelUrl(source.reelUrl);
}
export function requestedReel(source: ReelSource): string {
  const url = source.kind === 'reel' && reelUrl(source.reelUrl);
  if (!url) throw new AppError('third_party_requires_reel');
  return url;
}
export function challenge(text: string): boolean {
  return /(?:<title>\s*(?:Just a moment|Attention Required)|\/cdn-cgi\/challenge-platform\/|cf-chl-|class=["'][^"']*cf-turnstile|captcha_required|captcha required|please (?:complete|solve) (?:the )?captcha)/i.test(text);
}

// Fixed endpoint; do not redirect a POST/header containing the Reel to a new
// host. No Meta, Buffer, administrator credentials or login cookies are sent.
export async function siteText(url: string, init: RequestInit, signal: AbortSignal): Promise<string> {
  let response: Response;
  try { response = await fetch(url, { ...init, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36', ...init.headers }, redirect: 'manual', signal }); }
  catch { throw new AppError('third_party_network_error', true); }
  if (response.headers.get('cf-mitigated') === 'challenge' || response.status === 422) { await response.body?.cancel(); throw new SiteResponseError('third_party_challenge', { httpStatus: response.status, challengeHeader: response.headers.get('cf-mitigated') === 'challenge' }); }
  if (!response.ok && response.status !== 403) { await response.body?.cancel(); throw new AppError(`third_party_http_${response.status}`, response.status === 429 || response.status >= 500); }
  const text = response.body ? new TextDecoder().decode(await limitedBytes(response.body, 256_000)) : '';
  if (challenge(text)) throw new SiteResponseError('third_party_challenge', { httpStatus: response.status, challengeHeader: false });
  if (!response.ok) throw new AppError(`third_party_http_${response.status}`, response.status === 429 || response.status >= 500);
  return text;
}
export function siteJson(text: string): unknown {
  if (/^\s*</.test(text)) throw new AppError('third_party_html_response');
  try { return JSON.parse(text); } catch { throw new AppError('third_party_invalid_json'); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('third_party_invalid_result');
  return value as Record<string, unknown>;
}
export function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x([a-f0-9]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}
export async function candidates(urls: string[], hosts: string[], provider: string, env: Env, signal: AbortSignal): Promise<DownloadedVideo> {
  let failure: unknown = new AppError('third_party_no_video');
  // Prefer native CDN candidates; a site's own observed proxy is allowed only
  // by that provider. Arbitrary advertised/download hosts remain rejected.
  for (const url of [...new Set(urls)].slice(0, 2)) {
    try { secureUrl(url, hosts); return await videoAt(url, hosts, provider, env, signal); }
    catch (error) { failure = error; }
  }
  throw failure;
}
