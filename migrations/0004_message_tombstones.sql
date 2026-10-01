CREATE TABLE message_tombstones (
  message_hash TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX message_tombstones_job ON message_tombstones(job_id);
