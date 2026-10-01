CREATE TABLE IF NOT EXISTS apify_budget (
  account_hash TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0 CHECK (runs BETWEEN 0 AND 500),
  reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
  highest_usage_microusd INTEGER NOT NULL DEFAULT 0 CHECK (highest_usage_microusd >= 0),
  ceiling_microusd INTEGER NOT NULL CHECK (ceiling_microusd BETWEEN 0 AND 4500000),
  account_limit_microusd INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  stop_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_hash, period_start)
);
