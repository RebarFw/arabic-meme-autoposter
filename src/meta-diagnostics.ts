import { limitedBytes, normalizeMetaAppSecret } from './security';
import { AppError, type Env } from './types';
import { metaAccessToken } from './meta';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const identifier = (value: unknown): string | undefined => typeof value === 'string' && /^\d{1,40}$/.test(value) ? value : undefined;
const permissionName = (value: unknown): string | undefined => typeof value === 'string' && /^[a-z_]{1,100}$/.test(value) ? value : undefined;

// Meta error messages are useful for diagnosis, but must never return a credential
// that Meta might echo. Only this authenticated endpoint returns these details.
function safeText(env: Env, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = value;
  for (const secret of [env.META_ACCESS_TOKEN, env.META_APP_SECRET, env.ADMIN_TOKEN, env.BUFFER_API_KEY, env.META_VERIFY_TOKEN, env.OWNER_IG_SENDER_ID, env.FRIEND_IG_SENDER_ID, env.DOWNLOADER_API_KEY, env.CLOUDFLARE_USAGE_TOKEN]) {
    if (secret) {
      const normalized = secret.trim().replace(/^(["'])([A-Za-z0-9_-]+)\1$/, '$2');
      for (const value of [secret, normalized]) if (value) text = text.split(value).join('[redacted]').split(encodeURIComponent(value)).join('[redacted]');
    }
  }
  // eslint-disable-next-line no-control-regex -- Strip control characters from external error text.
  return text.replace(/https?:\/\/[^\s"<>]+/g, '[URL redacted]').replace(/[A-Za-z0-9_=-]{80,}/g, '[redacted]').replace(/[\x00-\x1f]/g, ' ').slice(0, 2000);
}

interface ApiResult {
  ok: boolean;
  httpStatus: number;
  body: ObjectValue;
  transport?: { contentType: string | null; contentLength: string | null; server: string | null };
  error?: { code?: number; subcode?: number; type?: string; message?: string; transient?: boolean; traceId?: string };
}

export async function inspect(env: Env, path: string, init: RequestInit = {}): Promise<ApiResult> {
  const token = metaAccessToken(env);
  if (!/^v\d+\.0$/.test(env.META_API_VERSION)) throw new AppError('invalid_meta_version');
  let response: Response;
  try {
    response = await fetch(`https://graph.instagram.com/${env.META_API_VERSION}/${path}`, {
      ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'MemeAutoposter/1.0', ...init.headers },
    });
  } catch (error) { return { ok: false, httpStatus: 0, body: {}, error: { message: error instanceof Error ? safeText(env, error.message) : 'Meta network request failed or timed out.' } }; }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { ok: false, httpStatus: response.status, body: {}, error: { message: 'Meta returned a redirect; credentials were not forwarded.' } };
  }
  let text: string;
  try { text = new TextDecoder().decode(await limitedBytes(response.body, 128_000)); }
  catch { return { ok: false, httpStatus: response.status, body: {}, error: { message: 'Meta returned an unreadable or oversized response.' } }; }
  let body: ObjectValue;
  try { body = object(JSON.parse(text)); }
  catch { return { ok: false, httpStatus: response.status, body: {}, transport: { contentType: safeText(env, response.headers.get('content-type')) ?? null, contentLength: safeText(env, response.headers.get('content-length')) ?? null, server: safeText(env, response.headers.get('server')) ?? null }, error: { message: safeText(env, text) || 'Meta returned an empty body.' } }; }
  const error = object(body.error);
  if (!response.ok || body.error) return { ok: false, httpStatus: response.status, body: {}, error: {
    code: typeof error.code === 'number' ? error.code : undefined,
    subcode: typeof error.error_subcode === 'number' ? error.error_subcode : undefined,
    type: safeText(env, error.type), message: safeText(env, error.message),
    transient: typeof error.is_transient === 'boolean' ? error.is_transient : undefined,
    traceId: safeText(env, error.fbtrace_id),
  } };
  return { ok: true, httpStatus: response.status, body };
}

export const evidence = (result: ApiResult) => ({ ok: result.ok, httpStatus: result.httpStatus, error: result.error, transport: result.transport });
function applications(env: Env, result: ApiResult) {
  if (!result.ok || !Array.isArray(result.body.data)) return [];
  return result.body.data.slice(0, 100).map(raw => {
    const app = object(raw);
    return { id: identifier(app.id), name: safeText(env, app.name), fields: Array.isArray(app.subscribed_fields) ? app.subscribed_fields.map(permissionName).filter((field): field is string => !!field) : [] };
  });
}

export async function diagnoseMeta(env: Env, subscribe = false) {
  try { metaAccessToken(env); }
  catch (error) {
    if (!(error instanceof AppError) || error.code !== 'invalid_meta_access_token_format') throw error;
    const raw = env.META_ACCESS_TOKEN!.trim();
    return { error: error.code, tokenFormatting: {
      startsWithInstagramPrefix: raw.startsWith('IGA'),
      looksLikeEnvironmentAssignment: /^META_ACCESS_TOKEN\s*=/.test(raw),
      instagramTokenCandidates: (raw.match(/IGA[A-Za-z0-9_-]{80,}/g) ?? []).length,
      nonTokenCharacterCodes: [...new Set(Array.from(raw).filter(char => !/[A-Za-z0-9_-]/.test(char)).map(char => 'U+' + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')))].slice(0, 20),
    } };
  }
  const [profile, messaging] = await Promise.all([
    inspect(env, 'me?fields=id,user_id,username'),
    // Instagram Login does not implement /me/permissions. This documented
    // read requires both business_basic and business_manage_messages. Request
    // IDs only, then discard them; never collect message contents for diagnosis.
    inspect(env, 'me/conversations?platform=instagram&fields=id&limit=1'),
  ]);
  const me = Array.isArray(profile.body.data) ? object(profile.body.data[0]) : profile.body;
  const accountId = identifier(me.user_id) ?? identifier(me.id);
  const messagingAuthorized = messaging.ok && Array.isArray(messaging.body.data);
  const sampledConversations = messagingAuthorized ? Math.min((messaging.body.data as unknown[]).length, 1) : 0;
  const nextPage = object(messaging.body.paging).next;
  const conversationAccess = {
    requestAuthorized: messagingAuthorized,
    state: !messagingAuthorized ? 'unavailable' : sampledConversations ? 'available' : 'empty',
    sampledConversations,
    hasNextPage: messagingAuthorized && typeof nextPage === 'string' && nextPage.trim().length > 0,
  };
  const required = {
    instagram_business_basic: (profile.ok && accountId) || messagingAuthorized ? 'verified_by_api' : 'unknown',
    instagram_business_manage_messages: messagingAuthorized ? sampledConversations ? 'verified_by_api' : 'request_authorized' : 'unknown',
  };
  const before = accountId ? await inspect(env, `${accountId}/subscribed_apps`) : undefined;
  let creation: ApiResult | undefined;
  let after: ApiResult | undefined;
  if (subscribe && profile.ok && accountId) {
    // Preserve any fields already selected for the connected app.
    const fields = [...new Set(['messages', ...applications(env, before!).flatMap(app => app.fields)])];
    creation = await inspect(env, `${accountId}/subscribed_apps`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ subscribed_fields: fields.join(',') }).toString(),
    });
    after = await inspect(env, `${accountId}/subscribed_apps`);
  }
  const created = !!creation?.ok && creation.body.success === true;
  return {
    apiHost: 'graph.instagram.com', apiVersion: env.META_API_VERSION,
    appSecretFormatting: { configured: !!env.META_APP_SECRET, rawLength: env.META_APP_SECRET?.length ?? 0, normalizedLength: normalizeMetaAppSecret(env.META_APP_SECRET ?? '').length, isHex32: /^[a-f0-9]{32}$/i.test(normalizeMetaAppSecret(env.META_APP_SECRET ?? '')) },
    account: { ...evidence(profile), id: accountId, appScopedId: identifier(me.id), username: safeText(env, me.username) },
    permissions: { required, scopesEnumerated: false, basis: 'Profile and Conversations API request evidence; an empty response does not verify DM visibility. Scope strings are not enumerated.', messaging: evidence(messaging) },
    conversationAccess,
    subscriptionBefore: before ? { ...evidence(before), apps: applications(env, before) } : undefined,
    subscriptionCreate: creation ? { ...evidence(creation), success: created } : undefined,
    subscriptionAfter: after ? { ...evidence(after), apps: applications(env, after) } : undefined,
    appMode: 'Not read from this Instagram user token; no app mode was changed.',
    appReview: profile.ok && messagingAuthorized ? sampledConversations ? 'The tested API requests succeeded and returned conversation data. Real message access, webhook delivery and app mode require separate evidence.' : 'The Conversations API request succeeded but returned no conversations. An empty result does not establish App Review or sender-role requirements.' : created ? 'Not blocking this account subscription request. Webhook delivery still needs a separate test.' : 'No App Review or live-mode conclusion without supporting Meta API evidence.',
    webhook: `${env.PUBLIC_BASE_URL}/webhooks/instagram`,
  };
}
