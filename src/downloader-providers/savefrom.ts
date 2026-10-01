import { META_MEDIA_HOSTS, reelUrl } from '../security';
import { AppError, type Env, type ReelSource } from '../types';
import { downloadSignal, type VideoDownloader } from '../video-downloader';
import { candidates, enabled, record, requestedReel, siteJson, siteText } from './shared';

// Extract only a strict JSON argument of a known result callback, never execute
// remote JavaScript, unpack eval payloads or fetch scripts/ads from the result.
export function saveFromResult(text: string): unknown {
  if (/^\s*(?:\[|\{)/.test(text)) return siteJson(text);
  const marked = /#json#([\s\S]*?)#json#/.exec(text)?.[1];
  if (marked) return siteJson(marked);
  const call = /\b(?:sf\.(?:videoResult\.show|result\.show(?:EmptyResult)?))\(\s*/.exec(text);
  if (!call) throw new AppError('savefrom_script_response_unsupported');
  const start = call.index + call[0].length;
  if (text[start] !== '{') throw new AppError('savefrom_invalid_result');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (--depth === 0) return siteJson(text.slice(start, i + 1)); }
  }
  throw new AppError('savefrom_invalid_result');
}
export class SaveFromDownloader implements VideoDownloader {
  readonly name = 'savefrom';
  supports(source: ReelSource, env: Env) { return enabled(this.name, source, env); }
  async download(source: ReelSource, env: Env, parent?: AbortSignal) {
    const signal = downloadSignal(parent, 15_000);
    const url = requestedReel(source);
    const text = await siteText('https://worker.savefrom.net/savefrom.php', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://en1.savefrom.net', Referer: 'https://en1.savefrom.net/15xA/download-from-instagram' },
      // Homepage form plus workerApi.js's observed unsigned fallback {url}.
      body: new URLSearchParams({ sf_url: url, url, new: '2', lang: 'en', app: '', ios_app_mode: '1', 'sf-nomad': '1' }).toString(),
    }, signal);
    const item = record(saveFromResult(text));
    if (item.success === false || item.invalid_request === true) throw new AppError('savefrom_unavailable');
    if (typeof item.source_url !== 'string' || reelUrl(item.source_url) !== url) throw new AppError('savefrom_wrong_reel');
    if (!Array.isArray(item.url)) throw new AppError('savefrom_no_video');
    const urls = item.url.filter(v => v && typeof v === 'object').map(record)
      .filter(v => (v.type === 'mp4' || v.ext === 'mp4') && !(v.attr && record(v.attr).class === 'no-audio'))
      .map(v => v.url).filter((v): v is string => typeof v === 'string');
    return candidates(urls, META_MEDIA_HOSTS, this.name, env, signal);
  }
}
