import { AppError } from './types';

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  // Fixed-length digests, including for different-length inputs.
  const [aa, bb] = await Promise.all([sha256(a), sha256(b)]);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return difference === 0;
}

export function normalizeMetaAppSecret(secret: string): string {
  return secret.trim().replace(/^(["'])([a-f0-9]{32})\1$/i, '$2');
}

export async function validSignature(body: Uint8Array, header: string | null, secret: string): Promise<boolean> {
  if (!header || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizeMetaAppSecret(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(header.slice(7).match(/../g)!, part => parseInt(part, 16));
  return crypto.subtle.verify('HMAC', key, signature, body);
}

export function secureUrl(raw: string, hosts: string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError('invalid_url'); }
  if (raw.length > 4096 || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) throw new AppError('untrusted_url');
  url.hash = '';
  return url;
}

export const META_MEDIA_HOSTS = ['cdninstagram.com', 'fbcdn.net', 'fbsbx.com'];

export function reelUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return;
  try {
    const url = secureUrl(raw, ['instagram.com']);
    const match = /^\/reels?\/([A-Za-z0-9_-]{5,80})\/?$/.exec(url.pathname);
    if (!match) return;
    return `https://www.instagram.com/reel/${match[1]}/`;
  } catch { return; }
}

export async function limitedBytes(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!body) throw new AppError('empty_body');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > max) throw new AppError('body_too_large');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function safeFetch(raw: string, hosts: string[], init: RequestInit = {}): Promise<Response> {
  let url = secureUrl(raw, hosts);
  for (let i = 0; i < 4; i++) {
    let response: Response;
    try { response = await fetch(url.toString(), { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(20_000) }); }
    catch { throw new AppError('download_network_error', true); }
    if (![301,302,303,307,308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new AppError('invalid_redirect');
    url = secureUrl(new URL(location, url).toString(), hosts);
  }
  throw new AppError('too_many_redirects');
}
