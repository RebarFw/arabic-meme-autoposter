import { metaRequest, parseMessages } from './meta';
import { reelUrl } from './security';
import { AppError, type Env, type ReelSource } from './types';

export type ApiObject = Record<string, unknown>;
export const apiObject = (value: unknown): ApiObject => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiObject : {};
export const apiId = (value: unknown): string | undefined => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value) ? value : undefined;
export const apiTimestamp = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN;
export const apiItems = (value: unknown): ApiObject[] => {
  const data = Array.isArray(value) ? value : apiObject(value).data;
  return Array.isArray(data) ? data.slice(0, 20).map(apiObject) : [];
};

export async function apiConversations(env: Env, owner?: string): Promise<ApiObject[]> {
  if (owner && !/^\d{1,40}$/.test(owner)) throw new AppError('invalid_owner_id');
  const query = new URLSearchParams({ platform: 'instagram', fields: 'id,updated_time', limit: '10', ...(owner ? { user_id: owner } : {}) });
  const result = await metaRequest<ApiObject>(env, 'me/conversations?' + query.toString());
  if (!Array.isArray(result.data)) throw new AppError('invalid_conversation_list');
  return result.data.slice(0, 10).map(apiObject).filter(item => !!apiId(item.id));
}

export async function apiMessageList(env: Env, conversationId: string): Promise<ApiObject[]> {
  const result = await metaRequest<ApiObject>(env, `${encodeURIComponent(conversationId)}?fields=messages.limit(20){id,created_time}`);
  if (!Array.isArray(apiObject(result.messages).data)) throw new AppError('invalid_message_list');
  return apiItems(result.messages).filter(item => !!apiId(item.id));
}

export async function apiMessage(env: Env, messageId: string, shares = false): Promise<ApiObject> {
  const fields = 'id,created_time,from,to,message' + (shares ? ',shares{link,type,url,id,name}' : '');
  return metaRequest<ApiObject>(env, `${encodeURIComponent(messageId)}?fields=${fields}`);
}

export function parseApiMessage(message: ApiObject, owner: string | string[], recipients: string[], since: number, now = Date.now()): ReelSource[] {
  const allowlist = Array.isArray(owner) ? owner : [owner];
  const sender = apiObject(message.from);
  const recipient = apiItems(message.to).find(item => typeof item.id === 'string' && recipients.includes(item.id));
  const timestamp = apiTimestamp(message.created_time);
  if (typeof sender.id !== 'string' || !allowlist.includes(sender.id) || !recipient || !apiId(message.id) || !Number.isFinite(timestamp) || timestamp < since || timestamp > now + 300_000) return [];
  // Instagram Login's actual Reel response uses shares.data[].link even
  // when the generic Message reference's url/type fields are omitted.
  const attachments = apiItems(message.shares).filter(share => ['post', 'reel', 'ig_post', 'ig_reel'].includes(String(share.type)) || (!share.type && !!reelUrl(share.link))).flatMap(share => {
    const link = reelUrl(share.link);
    const type = share.type === 'post' ? 'ig_post' : share.type ?? 'reel';
    const payload = { url: share.url ?? link, ig_post_media_id: share.id, title: share.name };
    return [{ type, payload }, ...(link && share.url ? [{ type: 'share', payload: { ...payload, url: link } }] : [])];
  });
  const parsed = parseMessages({ object: 'instagram', entry: [{ id: recipient.id, messaging: [{
    sender: { id: sender.id }, recipient: { id: recipient.id }, timestamp,
    message: { mid: message.id, text: message.message, attachments },
  }] }] }, owner, recipients, now);
  // Use the professional account ID across both ingress methods, even when
  // Meta returns an alternative app-scoped recipient ID.
  return parsed.map(source => ({ ...source, recipientId: recipients[0]! }));
}
