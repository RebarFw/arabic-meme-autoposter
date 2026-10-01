CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  source_json TEXT,
  recipient_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  caption TEXT,
  object_key TEXT,
  media_token TEXT,
  media_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  error_code TEXT,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX jobs_due ON jobs(state, next_run_at, lease_until);
CREATE INDEX jobs_media_expiry ON jobs(media_expires_at);
CREATE TABLE deliveries (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  service TEXT NOT NULL CHECK(service IN ('instagram','tiktok')),
  channel_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  post_id TEXT,
  post_status TEXT,
  error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, service)
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
