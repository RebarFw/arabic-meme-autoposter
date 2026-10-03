export interface Env {
  MEDIA: R2Bucket;
  DB: D1Database;
  BUFFER_API_KEY?: string;
  META_VERIFY_TOKEN?: string;
  META_APP_SECRET?: string;
  META_ACCESS_TOKEN?: string;
  OWNER_IG_SENDER_ID?: string;
  FRIEND_IG_SENDER_ID?: string;
  EXPECTED_INSTAGRAM_CHANNEL_ID?: string;
  EXPECTED_TIKTOK_CHANNEL_ID?: string;
  EXPECTED_INSTAGRAM_USERNAME?: string;
  EXPECTED_TIKTOK_USERNAME?: string;
  ADMIN_TOKEN?: string;
  DOWNLOADER_API_KEY?: string;
  CLOUDFLARE_USAGE_TOKEN?: string;
  CLOUDFLARE_USAGE_GUARD?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_DATABASE_ID?: string;
  DOWNLOADER_PROVIDER?: 'apify';
  DOWNLOADER_API_URL?: string;
  DOWNLOADER_MEDIA_HOSTS?: string;
  THIRD_PARTY_DOWNLOADER_PROVIDERS?: string;
  INGEST_MODE?: 'webhook' | 'polling';
  PUBLIC_BASE_URL?: string;
  META_API_VERSION: string;
  MAX_VIDEO_BYTES: string;
  MEDIA_TTL_SECONDS: string;
  ENABLE_OWNER_DM: string;
  ALLOW_PUBLIC_PAGE_DOWNLOADER: string;
  REPOST_PERMISSION_CONFIRMED: string;
}

export interface ReelSource {
  messageId: string;
  senderId: string;
  recipientId: string;
  timestamp: number;
  reelUrl?: string;
  attachmentUrl?: string;
  mediaId?: string;
  title?: string;
  kind: 'reel' | 'shared-post';
}

export interface Job {
  id: string;
  source_json: string | null;
  recipient_id: string;
  state: string;
  caption: string | null;
  object_key: string | null;
  media_token: string | null;
  media_expires_at: number | null;
  attempts: number;
  next_run_at: number;
  lease_token: string | null;
  lease_until: number;
  created_at: number;
  updated_at: number;
  error_code: string | null;
  notified: number;
}

export interface Channel {
  id: string;
  service: 'instagram' | 'tiktok';
  name: string;
  serviceId: string;
  organizationId: string;
  isDisconnected: boolean;
  isLocked: boolean;
  metadata?: { defaultToReminders?: boolean } | null;
}

export interface Delivery {
  job_id: string;
  service: 'instagram' | 'tiktok';
  channel_id: string;
  state: string;
  post_id: string | null;
  post_status: string | null;
  error_code: string | null;
  updated_at?: number;
}

export class AppError extends Error {
  constructor(public code: string, public retryable = false) { super(code); }
}

export function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'internal_error';
}

export function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  // Callers pass identifiers and fixed codes only: never raw URLs, payloads or errors.
  console.log(JSON.stringify({ event, ...fields }));
}
