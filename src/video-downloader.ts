import { AppError, type Env, type ReelSource } from './types';
import { safeFetch } from './security';

export interface DownloadedVideo { response: Response; provider: string; caption?: string }
const signatureVerified = new WeakMap<Response, number>();
export function hasVerifiedMp4Signature(response: Response): boolean { return signatureVerified.get(response) === Number(response.headers.get('content-length')); }
export function videoStreamError(error: unknown): unknown {
  return error instanceof Error && /FixedLengthStream|too (?:many|few) bytes/i.test(error.message)
    ? new AppError(/too many|exceed/i.test(error.message) ? 'video_too_large' : 'video_length_mismatch') : error;
}
export interface VideoDownloader {
  readonly name: string;
  supports(source: ReelSource, env: Env): boolean;
  download(source: ReelSource, env: Env, signal?: AbortSignal): Promise<DownloadedVideo>;
}
export function downloadSignal(parent: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const own = AbortSignal.timeout(milliseconds);
  return parent ? AbortSignal.any([parent, own]) : own;
}

// Validate before selecting a provider, so HTML disguised as MP4 or oversized
// files fall through to the next provider instead of failing later in R2.
export async function videoAt(url: string, hosts: string[], provider: string, env?: Env, signal?: AbortSignal): Promise<DownloadedVideo> {
  const response = await safeFetch(url, hosts, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(`download_http_${response.status}`, response.status >= 500 || response.status === 429);
  }
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'video/mp4') {
    await response.body?.cancel(); throw new AppError('download_not_mp4');
  }
  const length = Number(response.headers.get('content-length'));
  const max = Math.min(Number(env?.MAX_VIDEO_BYTES) || 26_214_400, 100_000_000);
  if (!Number.isSafeInteger(length) || length < 12 || length > max || response.headers.get('content-encoding') || !response.body) {
    await response.body?.cancel(); throw new AppError('video_size_or_type_invalid');
  }
  const reader = response.body.getReader();
  const initial: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < 12) {
      const chunk = await reader.read();
      if (chunk.done) throw new AppError('video_length_mismatch');
      size += chunk.value.length;
      if (size > length) throw new AppError('video_length_mismatch');
      initial.push(chunk.value);
    }
    const prefix = new Uint8Array(12);
    let offset = 0;
    for (const chunk of initial) { const part = chunk.subarray(0, 12 - offset); prefix.set(part, offset); offset += part.length; }
    if (new TextDecoder().decode(prefix.subarray(4, 8)) !== 'ftyp') throw new AppError('video_signature_invalid');
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const stream = new FixedLengthStream(length);
  const writer = stream.writable.getWriter();
  // Only inspect the MP4 prefix in JavaScript; native pipeTo transfers the
  // remaining video without a JavaScript callback for every network chunk.
  void (async () => {
    try {
      for (const chunk of initial) await writer.write(chunk);
      writer.releaseLock(); reader.releaseLock();
      await response.body!.pipeTo(stream.writable);
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      await stream.writable.abort(error).catch(() => {});
    }
  })();
  const verified = new Response(stream.readable, { status: response.status, headers: response.headers });
  signatureVerified.set(verified, length);
  return { provider, response: verified };
}
