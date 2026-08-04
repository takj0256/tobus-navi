CREATE TABLE IF NOT EXISTS profiles (
  segment_key TEXT NOT NULL,
  route_id TEXT NOT NULL,
  direction_id TEXT NOT NULL DEFAULT '',
  from_stop_id TEXT NOT NULL,
  to_stop_id TEXT NOT NULL,
  day_type TEXT NOT NULL,
  time_bin TEXT NOT NULL,
  profile_seconds REAL NOT NULL,
  median_seconds REAL NOT NULL,
  p25_seconds REAL NOT NULL,
  p75_seconds REAL NOT NULL,
  mad_seconds REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  confidence REAL NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (segment_key, day_type, time_bin)
);

CREATE TABLE IF NOT EXISTS corrections (
  segment_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  correction_ratio REAL NOT NULL,
  traffic_ratio REAL NOT NULL,
  confidence REAL NOT NULL,
  road_closed INTEGER NOT NULL DEFAULT 0,
  incident INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anomalies (
  event_id TEXT PRIMARY KEY,
  segment_key TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  actual_seconds REAL NOT NULL,
  expected_seconds REAL NOT NULL,
  delay_seconds REAL NOT NULL,
  ratio REAL NOT NULL,
  confirmed INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS anomalies_segment_time ON anomalies(segment_key, observed_at);

CREATE TABLE IF NOT EXISTS traffic_usage (
  month TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
