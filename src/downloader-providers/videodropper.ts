import { META_MEDIA_HOSTS, secureUrl } from '../security';
import { AppError, type Env, type ReelSource } from '../types';
import { downloadSignal, type VideoDownloader } from '../video-downloader';
import { candidates, enabled, record, requestedReel, siteJson, siteText } from './shared';

// Public website request encoding observed in CEx79byz.js on 2026-10-01.
// This constant is its public format key, NOT an account credential. WebCrypto
// CBC of each individual block with zero IV gives ECB's first ciphertext block.
export async function encodeVideoDropperUrl(url: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('qwertyuioplkjhgf'), 'AES-CBC', false, ['encrypt']);
  const input = new TextEncoder().encode(url);
  const padding = 16 - input.length % 16;
  const padded = new Uint8Array(input.length + padding);
  padded.set(input); padded.fill(padding, input.length);
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < padded.length; offset += 16) {
    blocks.push(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, padded.slice(offset, offset + 16))).subarray(0, 16));
  }
  return blocks.map(b => Array.from(b, n => n.toString(16).padStart(2, '0')).join('')).join('');
}

export class VideoDropperDownloader implements VideoDownloader {
  readonly name = 'videodropper';
  supports(source: ReelSource, env: Env) { return enabled(this.name, source, env); }
  async download(source: ReelSource, env: Env, parent?: AbortSignal) {
    const signal = downloadSignal(parent, 25_000);
    const url = requestedReel(source);
    const text = await siteText('https://api.videodropper.app/allinone', { headers: { url: await encodeVideoDropperUrl(url), Accept: 'application/json', Origin: 'https://videodropper.app', Referer: 'https://videodropper.app/' } }, signal);
    const data = record(siteJson(text));
    if (!Array.isArray(data.video) || data.video.length !== 1) throw new AppError('videodropper_not_single_video');
    const item = record(data.video[0]);
    if (typeof item.video !== 'string') throw new AppError('videodropper_no_video');
    // The observed response contains the original Meta CDN URL; try it first.
    const original = secureUrl(item.video, META_MEDIA_HOSTS).toString();
    return candidates([original, 'https://dl.videodropper.app/?url=' + encodeURIComponent(original)], [...META_MEDIA_HOSTS, 'dl.videodropper.app'], this.name, env, signal);
  }
}
