import { AppError, type Env, type Job } from './types';
import { constantTimeEqual } from './security';
import { reserveCloudflareMedia } from './cloudflare-usage';

export async function storeVideo(env: Env, response: Response, key: string, expiresAt: number): Promise<number> {
  const max = Math.min(Number(env.MAX_VIDEO_BYTES) || 26_214_400, 100_000_000);
  const length = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length < 12 || length > max || !response.body || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'video/mp4' || response.headers.get('content-encoding')) {
    await response.body?.cancel(); throw new AppError('video_size_or_type_invalid');
  }
  const reader = response.body.getReader();
  const initial: Uint8Array[] = [];
  let initialSize = 0;
  try {
    while (initialSize < 12) {
      const next = await reader.read();
      if (next.done) throw new AppError('video_length_mismatch');
      initialSize += next.value.length;
      if (initialSize > length) throw new AppError('video_too_large');
      initial.push(next.value);
    }
    const prefix = new Uint8Array(12);
    let offset = 0;
    for (const chunk of initial) {
      const sample = chunk.subarray(0, 12 - offset);
      prefix.set(sample, offset);
      offset += sample.length;
    }
    if (new TextDecoder().decode(prefix.subarray(4,8)) !== 'ftyp') throw new AppError('video_signature_invalid');
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  try { await reserveCloudflareMedia(env, key, length, expiresAt); }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const stream = new FixedLengthStream(length);
  const writer = stream.writable.getWriter();
  const upload = env.MEDIA.put(key, stream.readable, {
    httpMetadata: { contentType: 'video/mp4', cacheControl: 'private, no-store' },
    customMetadata: { expiresAt: String(expiresAt) },
  }).catch(async error => {
    // A quota reservation may reject before R2 consumes the stream. Unblock
    // the producer instead of leaving its first write waiting forever.
    await stream.readable.cancel(error).catch(() => {});
    throw error;
  });
  const pump = (async () => {
    let size = initialSize;
    try {
      for (const chunk of initial) await writer.write(chunk);
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > length || size > max) throw new AppError('video_too_large');
        await writer.write(next.value);
      }
      if (size !== length) throw new AppError('video_length_mismatch');
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      await reader.cancel().catch(() => {});
      throw error;
    }
  })();
  const results = await Promise.allSettled([upload, pump]);
  const failure = results.find(r => r.status === 'rejected');
  if (failure?.status === 'rejected') { await env.MEDIA.delete(key); throw failure.reason; }
  return length;
}

export function temporaryMediaUrl(env: Env, job: Job): string {
  if (!env.PUBLIC_BASE_URL || !job.media_token || !job.media_expires_at) throw new AppError('media_url_not_configured');
  const base = new URL(env.PUBLIC_BASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search) throw new AppError('invalid_public_base_url');
  return `${base.origin}/media/${job.id}.mp4?token=${encodeURIComponent(job.media_token)}`;
}

export async function serveMedia(request: Request, env: Env, jobId: string): Promise<Response> {
  const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const notFound = () => new Response('Not found', { status: 404, headers });
  if (!/^[a-f0-9]{64}$/.test(jobId)) return notFound();
  const token = new URL(request.url).searchParams.get('token');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return notFound();
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<Job>();
  if (!job?.object_key || !job.media_token || !job.media_expires_at || job.media_expires_at <= Date.now() || !await constantTimeEqual(token, job.media_token)) return notFound();
  const range = request.headers.get('range');
  if (request.method === 'GET' && range) {
    const metadata = await env.MEDIA.head(job.object_key);
    if (!metadata) return notFound();
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const invalid = !match || (!match[1] && !match[2]) ||
      (match[1] ? !Number.isSafeInteger(Number(match[1])) || Number(match[1]) >= metadata.size : !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) ||
      (!!match[2] && !!match[1] && (Number(match[2]) < Number(match[1]) || !Number.isSafeInteger(Number(match[2]))));
    if (invalid) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${metadata.size}` } });
  }
  const object = request.method === 'HEAD'
    ? await env.MEDIA.head(job.object_key)
    : await env.MEDIA.get(job.object_key, { range: request.headers });
  if (!object) return notFound();
  const output = new Headers(headers);
  object.writeHttpMetadata(output);
  output.set('Cache-Control', headers['Cache-Control']);
  output.set('Content-Type', 'video/mp4');
  output.set('Accept-Ranges', 'bytes');
  output.set('ETag', object.httpEtag);
  let status = 200;
  if ('range' in object && object.range && 'offset' in object.range && 'length' in object.range) {
    const { offset = 0, length = object.size } = object.range;
    output.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    output.set('Content-Length', String(length));
    status = 206;
  } else output.set('Content-Length', String(object.size));
  return new Response('body' in object ? (object as R2ObjectBody).body : null, { status, headers: output });
}
