-- Preserve existing delivery records while enabling one YouTube delivery per job.
CREATE TABLE deliveries_youtube (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  service TEXT NOT NULL CHECK(service IN ('instagram','tiktok','youtube')),
  channel_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  post_id TEXT,
  post_status TEXT,
  error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, service)
);
INSERT INTO deliveries_youtube(job_id, service, channel_id, state, post_id, post_status, error_code, updated_at)
  SELECT job_id, service, channel_id, state, post_id, post_status, error_code, updated_at FROM deliveries;
DROP TABLE deliveries;
ALTER TABLE deliveries_youtube RENAME TO deliveries;
