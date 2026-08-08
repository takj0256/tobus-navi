CREATE TABLE IF NOT EXISTS job_status (
  job_name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_objects INTEGER NOT NULL DEFAULT 0,
  profile_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
