CREATE TABLE cloudflare_usage_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  snapshot_json TEXT,
  refreshed_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT
);
INSERT INTO cloudflare_usage_state(id) VALUES(1);
CREATE TABLE cloudflare_usage_daily (
  day TEXT PRIMARY KEY,
  workers INTEGER NOT NULL,
  rows_read INTEGER NOT NULL,
  rows_written INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  stop_code TEXT
);
CREATE TABLE cloudflare_r2_daily (
  day TEXT PRIMARY KEY,
  base_a INTEGER NOT NULL,
  base_b INTEGER NOT NULL,
  reported_a INTEGER NOT NULL,
  reported_b INTEGER NOT NULL,
  own_a INTEGER NOT NULL DEFAULT 0,
  own_b INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE cloudflare_media_reservations (
  object_key TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL CHECK(bytes>0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX cloudflare_media_expiry ON cloudflare_media_reservations(expires_at);
