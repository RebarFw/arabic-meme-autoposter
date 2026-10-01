import { META_MEDIA_HOSTS } from '../security';
import { AppError, type Env, type ReelSource } from '../types';
import { downloadSignal, type VideoDownloader } from '../video-downloader';
import { candidates, decodeHtml, enabled, record, requestedReel, siteJson, siteText } from './shared';

export class SnapInstaDownloader implements VideoDownloader {
  readonly name = 'snapinsta';
  supports(source: ReelSource, env: Env) { return enabled(this.name, source, env); }
  async download(source: ReelSource, env: Env, parent?: AbortSignal) {
    const signal = downloadSignal(parent, 15_000);
    const url = requestedReel(source);
    const page = await siteText('https://snapinsta.to/en46', {}, signal);
    if (/cf-turnstile|challenges\.cloudflare\.com\/turnstile|grecaptcha/i.test(page)) throw new AppError('third_party_challenge');
    const version = /\bk_ver\s*=\s*["'](v[12])["']/.exec(page)?.[1];
    if (!version || !/id=["']search-form["']/.test(page)) throw new AppError('snapinsta_form_unavailable');
    // Observed button: ksearchvideo(false,"media"). The site's current public
    // form requires Turnstile and is skipped above; no challenge is solved.
    const text = await siteText('https://snapinsta.to/api/ajaxSearch', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://snapinsta.to', Referer: 'https://snapinsta.to/en46' },
      body: new URLSearchParams({ q: url, t: 'media', v: version, lang: 'en', cftoken: '', html: '' }).toString(),
    }, signal);
    const data = record(siteJson(text));
    if (data.status !== 'ok' || data.mess || data.v !== 'v1' || typeof data.data !== 'string') throw new AppError('snapinsta_plain_result_unavailable');
    const urls: string[] = [];
    for (const anchor of data.data.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
      if (!/download\s*(?:video|mp4)/i.test(anchor.replace(/<[^>]*>/g, ' '))) continue;
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(anchor)?.[1];
      if (href) urls.push(decodeHtml(href));
    }
    return candidates(urls, META_MEDIA_HOSTS, this.name, env, signal);
  }
}
