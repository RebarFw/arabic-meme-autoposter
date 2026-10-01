import { cloudflareCapacity, withCloudflareR2Guard } from './cloudflare-usage';
import { storeVideo } from './media';
import { sha256 } from './security';
import { AppError, type Env } from './types';

// Authenticated explicit test only: 24 bytes, no jobs, no Buffer API and no
// public media capability. Exercises the same guarded stream/bindings as jobs.
export async function probeCloudflareGuard(env: Env) {
  const guarded = withCloudflareR2Guard({ ...env, CLOUDFLARE_USAGE_GUARD: 'true' });
  const capacity = await cloudflareCapacity(guarded);
  if (!capacity.allowed) throw new AppError(capacity.code ?? 'cloudflare_usage_paused');
  const bytes = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
  const key = `arabic-meme-autoposter/${await sha256(crypto.randomUUID())}.mp4`;
  try {
    await storeVideo(guarded, new Response(bytes, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '24' } }), key, Date.now() + 60_000);
    const metadata = await guarded.MEDIA.head(key);
    const object = await guarded.MEDIA.get(key);
    if (!metadata || metadata.size !== bytes.length || !object || (await object.arrayBuffer()).byteLength !== bytes.length) throw new AppError('cloudflare_probe_transfer_failed');
  } finally { await guarded.MEDIA.delete(key); }
  const deleted = await guarded.MEDIA.head(key) === null;
  if (!deleted) throw new AppError('cloudflare_probe_cleanup_failed');
  return { guardedUploadVerified: true, guardedReadVerified: true, bytes: bytes.length, physicalDeletionVerified: true, postsCreated: 0 };
}
