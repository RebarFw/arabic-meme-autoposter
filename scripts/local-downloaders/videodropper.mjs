import { createCipheriv } from 'node:crypto';

// Optional operator recovery on the local computer when the site's public
// resolver rejects Cloudflare egress. This constant is its public wire format,
// not a credential. Only a canonical public Reel URL goes to the resolver.
export async function resolveVideoDropper(reelUrl) {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from('qwertyuioplkjhgf'), null);
  const encoded = Buffer.concat([cipher.update(reelUrl, 'utf8'), cipher.final()]).toString('hex');
  let response;
  try {
    response = await fetch('https://api.videodropper.app/allinone', {
      headers: { url: encoded, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(25_000),
    });
  } catch { throw new Error('local_resolver_network_failed'); }
  if (!response.ok || response.headers.get('cf-mitigated') === 'challenge') {
    await response.body?.cancel();
    throw new Error('local_resolver_blocked');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('local_resolver_empty_response');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256_000) throw new Error('local_resolver_response_too_large');
      chunks.push(value);
    }
  } catch { await reader.cancel().catch(() => {}); throw new Error('local_resolver_read_failed'); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('local_resolver_invalid_json'); }
  if (!Array.isArray(result?.video) || result.video.length !== 1 || typeof result.video[0]?.video !== 'string') throw new Error('local_resolver_no_single_video');
  let video;
  try { video = new URL(result.video[0].video); } catch { throw new Error('local_resolver_invalid_video_url'); }
  if (video.href.length > 4096 || video.protocol !== 'https:' || video.username || video.password || (video.port && video.port !== '443') ||
      !['cdninstagram.com', 'fbcdn.net', 'fbsbx.com'].some(h => video.hostname === h || video.hostname.endsWith('.' + h))) throw new Error('local_resolver_untrusted_video_url');
  video.hash = '';
  return video.href;
}
