import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { claimJob, enqueue, maintenance, processJob, saveSetting } from '../src/jobs';
import { parseMessages } from '../src/meta';
import { normalizeMetaAppSecret, secureUrl, validSignature } from '../src/security';
import { storeVideo } from '../src/media';
import { BufferClient } from '../src/buffer';
import { downloadVideo } from '../src/downloaders';
import type { Channel, Delivery, Env, Job, ReelSource } from '../src/types';

const base = 'https://worker.example';
const channels: Channel[] = [
  { id: 'ig-channel', service: 'instagram', name: 'memes', serviceId: '222', organizationId: 'org', isLocked: false, isDisconnected: false },
  { id: 'tt-channel', service: 'tiktok', name: 'memes', serviceId: '333', organizationId: 'org', isLocked: false, isDisconnected: false },
];
const mp4 = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
const source = (): ReelSource => ({ messageId: 'mid-1', senderId: '111', recipientId: '222', timestamp: Date.now(), attachmentUrl: 'https://lookaside.fbsbx.com/clip.mp4', kind: 'reel' });
const configured = (): Env => ({ ...env, BUFFER_API_KEY: 'fake-buffer' });
function payload(sender = '111', overrides: Record<string, unknown> = {}) {
  return { object: 'instagram', entry: [{ id: '222', messaging: [{ sender: { id: sender }, recipient: { id: '222' }, timestamp: Date.now(), message: { mid: 'mid-1', attachments: [{ type: 'ig_reel', payload: { url: 'https://lookaside.fbsbx.com/clip.mp4' } }], ...overrides } }] }] };
}
async function sign(body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-app-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return 'sha256=' + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join('');
}
async function call(path: string, init: RequestInit = {}, bindings: Env = configured()) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(base + path, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function rows() { return (await env.DB.prepare('SELECT * FROM deliveries ORDER BY service').all<Delivery>()).results; }
async function job(id: string) { return (await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first<Job>())!; }

beforeEach(async () => {
  const objects = await env.MEDIA.list(); if (objects.objects.length) await env.MEDIA.delete(objects.objects.map(o => o.key));
  await env.DB.batch([env.DB.prepare('DELETE FROM deliveries'), env.DB.prepare('DELETE FROM message_tombstones'), env.DB.prepare('DELETE FROM message_tombstones'), env.DB.prepare('DELETE FROM jobs'), env.DB.prepare('DELETE FROM settings')]);
  await saveSetting(env,'recipient_ids',['222']);
  await saveSetting(env,'channels',channels);
});
afterEach(() => vi.restoreAllMocks());

describe('webhook security', () => {
  it('verifies the independent RFC 4231 HMAC-SHA256 vector and safely handles clipboard whitespace', async () => {
    const body = new TextEncoder().encode('what do ya want for nothing?');
    const signature = 'sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
    expect(await validSignature(body, signature, 'Jefe')).toBe(true);
    expect(await validSignature(body, signature, ' Jefe\r\n')).toBe(true);
    expect(await validSignature(body, signature, 'wrong')).toBe(false);
    expect(normalizeMetaAppSecret(' "' + 'a'.repeat(32) + '"\r\n')).toBe('a'.repeat(32));
  });
  it('serves health and verifies only the correct token', async () => {
    expect((await call('/health')).status).toBe(200);
    const valid = await call('/webhooks/instagram?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=123');
    expect(await valid.text()).toBe('123');
    expect((await call('/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')).status).toBe(403);
  });
  it('rejects missing and forged signatures before any jobs', async () => {
    for (const signature of ['', 'sha256=' + '0'.repeat(64)]) {
      expect((await call('/webhooks/instagram', { method: 'POST', body: JSON.stringify(payload()), headers: { 'x-hub-signature-256': signature } })).status).toBe(403);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{n:number}>())?.n).toBe(0);
  });
  it('authentic stranger DMs never call Buffer or create a job', async () => {
    const fetcher = vi.spyOn(globalThis,'fetch');
    const body = JSON.stringify(payload('random-person'));
    expect((await call('/webhooks/instagram', { method:'POST', body, headers:{'x-hub-signature-256':await sign(body)} })).status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{n:number}>())?.n).toBe(0);
  });
  it('rejects malformed signed JSON and oversized bodies', async () => {
    expect((await call('/webhooks/instagram',{method:'POST', body:'{', headers:{'x-hub-signature-256':await sign('{')}})).status).toBe(400);
    expect((await call('/webhooks/instagram',{method:'POST', body:'x'.repeat(256001)})).status).toBe(413);
  });
  it('acknowledges signed notifications but never publishes when the owner is not configured', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const body = JSON.stringify(payload());
    const response = await call('/webhooks/instagram',{method:'POST', body, headers:{'x-hub-signature-256':await sign(body)}}, {...configured(),OWNER_IG_SENDER_ID:undefined});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, publishingReady: false });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>())?.n).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('retries only approved Reels during a publishing configuration outage', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const bindings = { ...configured(), BUFFER_API_KEY: undefined };
    for (const sender of ['111', 'stranger']) {
      const body = JSON.stringify(payload(sender));
      const response = await call('/webhooks/instagram', { method: 'POST', body, headers: { 'x-hub-signature-256': await sign(body) } }, bindings);
      expect(response.status).toBe(sender === '111' ? 503 : 200);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>())?.n).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('admin is protected and status never returns secrets', async () => {
    expect((await call('/admin/status')).status).toBe(401);
    const response = await call('/admin/status',{headers:{Authorization:'Bearer test-admin'}});
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('fake-buffer');
  });
});

describe('Reel parsing and URL restrictions', () => {
  it('requires exact owner and correct recipient and ignores echoes, deleted messages and stale events', () => {
    expect(parseMessages(payload('stranger'),'111',['222'])).toEqual([]);
    expect(parseMessages(payload(),'111',['other'])).toEqual([]);
    expect(parseMessages(payload('111',{is_echo:true}),'111',['222'])).toEqual([]);
    expect(parseMessages(payload('111',{is_self:true}),'111',['222'])).toEqual([]);
    expect(parseMessages(payload('111',{is_deleted:true}),'111',['222'])).toEqual([]);
    expect(parseMessages(payload(),'111',['222'], Date.now()+49*3600_000)).toEqual([]);
  });
  it('supports canonical Reel links and current ig_post shares without treating a thumbnail as a Reel', () => {
    const p = payload('111',{attachments:[{type:'ig_post',payload:{ig_post_media_id:'123',url:'https://lookaside.fbsbx.com/thumbnail.jpg',title:'test'}}]});
    const share = parseMessages(p,'111',['222'])[0];
    expect(share?.kind).toBe('shared-post');
    expect(share?.mediaId).toBe('123');
    const link = parseMessages(payload('111',{attachments:[],text:'https://www.instagram.com/reel/ABCdef123/?igsh=abc'}),'111',['222'])[0];
    expect(link?.reelUrl).toBe('https://www.instagram.com/reel/ABCdef123/');
  });
  it('dedupes legacy/current dual attachments and rejects conflicting media', () => {
    const attachment = {payload:{ig_post_media_id:'123',url:'https://lookaside.fbsbx.com/a'}};
    expect(parseMessages(payload('111',{attachments:[{type:'share',...attachment},{type:'ig_post',...attachment}]}),'111',['222'])).toHaveLength(1);
    expect(parseMessages(payload('111',{attachments:[{type:'ig_post',...attachment},{type:'ig_post',payload:{ig_post_media_id:'456',url:'https://lookaside.fbsbx.com/b'}}]}),'111',['222'])).toHaveLength(0);
  });
  it('blocks SSRF, deceptive suffixes, credentials, HTTP and ports', () => {
    for (const url of ['http://lookaside.fbsbx.com/v','https://fbsbx.com.evil.com/v','https://localhost/v','https://127.0.0.1/v','https://user:pass@lookaside.fbsbx.com/v','https://lookaside.fbsbx.com:8080/v']) expect(()=>secureUrl(url,['fbsbx.com'])).toThrow();
  });
  it('never follows a download redirect to an untrusted host', async () => {
    const fetcher = vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:302,headers:{Location:'https://evil.example/v'}}));
    await expect(downloadVideo(source(),configured(),'job')).rejects.toThrow('no_downloader');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('persistent jobs and media', () => {
  it('concurrent webhook retries create one durable job and one lease', async () => {
    const ids = await Promise.all(Array.from({length:10},()=>enqueue(configured(),source())));
    expect(new Set(ids).size).toBe(1);
    const leases = await Promise.all(Array.from({length:10},()=>claimJob(configured(),ids[0]!)));
    expect(leases.filter(Boolean)).toHaveLength(1);
  });
  it('streams a bounded MP4 and rejects fake content and excessive declared sizes', async () => {
    await storeVideo(configured(),new Response(mp4,{headers:{'Content-Type':'video/mp4','Content-Length':String(mp4.length)}}),'arabic-meme-autoposter/test.mp4',Date.now()+60000);
    expect((await env.MEDIA.head('arabic-meme-autoposter/test.mp4'))?.size).toBe(mp4.length);
    await expect(storeVideo(configured(),new Response(mp4,{headers:{'Content-Type':'video/mp4','Content-Length':'999999999'}}),'bad',Date.now())).rejects.toThrow('video_size');
    await expect(storeVideo(configured(),new Response('abcdefghijkl',{headers:{'Content-Type':'video/mp4','Content-Length':'12'}}),'bad',Date.now())).rejects.toThrow('video_signature');
    expect(await env.MEDIA.head('bad')).toBeNull();
  });
  it('publishes both channels with shareNow only once despite duplicate webhook deliveries', async () => {
    let creates = 0;
    const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('fbsbx.com')) return new Response(mp4,{headers:{'Content-Type':'video/mp4','Content-Length':String(mp4.length)}});
      const body = JSON.parse(String(init?.body));
      expect(body.variables.input.mode).toBe('shareNow');
      expect(body.variables.input.schedulingType).toBe('automatic');
      expect(body.variables.input.text).toContain('#ميمز #ضحك');
      creates++;
      return Response.json({data:{createPost:{__typename:'PostActionSuccess',post:{id:'post-'+creates,status:'sending',schedulingType:'automatic'}}}});
    });
    const body = JSON.stringify(payload());
    const request = {method:'POST',body,headers:{'x-hub-signature-256':await sign(body)}};
    await call('/webhooks/instagram',request);
    await call('/webhooks/instagram',request);
    expect(creates).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await rows()).every(d=>d.state==='accepted')).toBe(true);
  });
  it('never resubmits uncertain Buffer creates and continues the other channel', async () => {
    let creates = 0;
    vi.spyOn(globalThis,'fetch').mockImplementation(async (input) => {
      if(String(input).includes('fbsbx.com')) return new Response(mp4,{headers:{'Content-Type':'video/mp4','Content-Length':String(mp4.length)}});
      creates++;
      if(creates===1) throw new Error('timeout after possible acceptance');
      return Response.json({data:{createPost:{__typename:'PostActionSuccess',post:{id:'tt-post',status:'sent',schedulingType:'automatic'}}}});
    });
    const id = await enqueue(configured(),source());
    await processJob(configured(),id);
    await env.DB.prepare('UPDATE jobs SET next_run_at=0 WHERE id=?').bind(id).run();
    await processJob(configured(),id);
    expect(creates).toBe(2);
    expect((await rows())[0]?.state).toBe('unknown');
    expect((await job(id)).state).toBe('attention');
  });
  it('serves HEAD and Range only with the correct token and deletes after both posts are sent', async () => {
    let creates = 0;
    vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
      if(String(input).includes('fbsbx.com')) return new Response(mp4,{headers:{'Content-Type':'video/mp4','Content-Length':String(mp4.length)}});
      const body = JSON.parse(String(init?.body));
      if(body.query.includes('mutation')) return Response.json({data:{createPost:{__typename:'PostActionSuccess',post:{id:'p'+(++creates),status:'sending',schedulingType:'automatic'}}}});
      return Response.json({data:{post:{id:body.variables.input.id,status:'sent',schedulingType:'automatic'}}});
    });
    const id = await enqueue(configured(),source());
    await processJob(configured(),id);
    const stored = await job(id);
    const path = `/media/${id}.mp4?token=${stored.media_token}`;
    expect((await call(`/media/${id}.mp4?token=${'a'.repeat(64)}`)).status).toBe(404);
    const originalHead = env.MEDIA.head.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, 'head').mockImplementation(async key => {
      const object = await originalHead(key);
      return object ? { ...object, range: { offset: 0, length: object.size }, writeHttpMetadata: object.writeHttpMetadata.bind(object) } : null;
    });
    const head = await call(path,{method:'HEAD'});
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe(String(mp4.length));
    expect(head.headers.get('Content-Range')).toBeNull();
    expect((await call(path,{method:'HEAD',headers:{Range:'bytes=0-7'}})).status).toBe(200);
    const whole = await call(path);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('Content-Range')).toBeNull();
    expect((await whole.arrayBuffer()).byteLength).toBe(mp4.length);
    const ranged = await call(path,{headers:{Range:'bytes=0-7'}});
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(8);
    expect((await call(path,{headers:{Range:'bytes=99999-'}})).status).toBe(416);
    await env.DB.prepare('UPDATE jobs SET next_run_at=0 WHERE id=?').bind(id).run();
    await processJob(configured(),id);
    expect((await job(id)).state).toBe('completed');
    expect(await env.MEDIA.head(stored.object_key!)).toBeNull();
    expect((await call(path)).status).toBe(404);
    expect(await enqueue(configured(),source())).toBe(id);
    expect((await job(id)).state).toBe('completed');
  });
  it('expires access independently of cron and cleans stuck/orphaned objects without touching other bucket data', async () => {
    const id = await enqueue(configured(),source());
    const key = `arabic-meme-autoposter/${id}.mp4`;
    await env.MEDIA.put(key,mp4);
    await env.MEDIA.put('arabic-meme-autoposter/orphan.mp4',mp4,{customMetadata:{expiresAt:String(Date.now()-10000)}});
    await env.MEDIA.put('unrelated.mp4',mp4);
    await env.DB.prepare("UPDATE jobs SET state='waiting',object_key=?,media_token=?,media_expires_at=? WHERE id=?").bind(key,'a'.repeat(64),Date.now()-10000,id).run();
    expect((await call(`/media/${id}.mp4?token=${'a'.repeat(64)}`)).status).toBe(404);
    await maintenance({...configured(),BUFFER_API_KEY:undefined});
    expect(await env.MEDIA.head(key)).toBeNull();
    expect(await env.MEDIA.head('arabic-meme-autoposter/orphan.mp4')).toBeNull();
    expect(await env.MEDIA.head('unrelated.mp4')).not.toBeNull();
    expect((await job(id)).state).toBe('attention');
  });
});

describe('Buffer discovery', () => {
  it('handles concrete GraphQL rejection types and preserves uncertainty for server errors', async () => {
    const fetcher = vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({data:{createPost:{__typename:'InvalidInputError',message:'bad video'}}}));
    await expect(new BufferClient(configured()).publish('ig-channel','instagram','test','https://worker.example/video')).rejects.toThrow('buffer_create_rejected');
    fetcher.mockResolvedValue(Response.json({data:{createPost:{__typename:'UnexpectedError',message:'possible partial failure'}}}));
    await expect(new BufferClient(configured()).publish('ig-channel','instagram','test','https://worker.example/video')).rejects.toThrow('buffer_create_unknown');
  });
  it('setup verifies the Meta account and subscribes it with form fields', async () => {
    const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
      if(String(input).includes('/me?')) return Response.json({id:'222',user_id:'222',username:'memes'});
      if(String(input).includes('/subscribed_apps')) {
        expect(init?.body).toBe('subscribed_fields=messages');
        expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
        return Response.json({success:true});
      }
      const body = JSON.parse(String(init?.body));
      return body.query.includes('account') ? Response.json({data:{account:{organizations:[{id:'org'}]}}}) : Response.json({data:{channels}});
    });
    const response = await call('/admin/setup',{method:'POST',headers:{Authorization:'Bearer test-admin'}},{...configured(),META_ACCESS_TOKEN:'fake-meta'});
    expect(response.status).toBe(200);
    expect((await response.json() as {metaSubscribed:boolean}).metaSubscribed).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('discovers organizations and exactly one Instagram and TikTok automatically', async () => {
    vi.spyOn(globalThis,'fetch').mockImplementation(async (_input,init) => {
      const body = JSON.parse(String(init?.body));
      return body.query.includes('account') ? Response.json({data:{account:{organizations:[{id:'org'}]}}}) : Response.json({data:{channels}});
    });
    expect((await new BufferClient(configured()).discoverChannels()).map(c=>c.service)).toEqual(['instagram','tiktok']);
  });
  it('rejects ambiguity and channels requiring reminders', async () => {
    const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(async (_input,init) => {
      const body = JSON.parse(String(init?.body));
      return body.query.includes('account') ? Response.json({data:{account:{organizations:[{id:'org'}]}}}) : Response.json({data:{channels:[...channels,channels[0]]}});
    });
    await expect(new BufferClient(configured()).discoverChannels()).rejects.toThrow('ambiguous');
    fetcher.mockImplementation(async (_input,init) => {
      const body = JSON.parse(String(init?.body));
      return body.query.includes('account') ? Response.json({data:{account:{organizations:[{id:'org'}]}}}) : Response.json({data:{channels:channels.map(c=>({...c,metadata:{defaultToReminders:true}}))}});
    });
    await expect(new BufferClient(configured()).discoverChannels()).rejects.toThrow('not_automatic');
  });
});
