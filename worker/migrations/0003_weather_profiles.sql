CREATE TABLE IF NOT EXISTS weather_current (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  weather_class TEXT NOT NULL,
  temperature_band TEXT NOT NULL,
  temperature_c REAL NOT NULL,
  apparent_temperature_c REAL,
  precipitation_mm REAL NOT NULL DEFAULT 0,
  snowfall_cm REAL NOT NULL DEFAULT 0,
  weather_code INTEGER NOT NULL DEFAULT 0,
  wind_speed_kmh REAL
);

CREATE TABLE IF NOT EXISTS weather_profiles (
  scope TEXT NOT NULL,
  route_id TEXT NOT NULL,
  direction_id TEXT NOT NULL DEFAULT '',
  weather_class TEXT NOT NULL,
  temperature_band TEXT NOT NULL,
  adjustment_ratio REAL NOT NULL,
  median_ratio REAL NOT NULL,
  p25_ratio REAL NOT NULL,
  p75_ratio REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  confidence REAL NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (scope, route_id, direction_id, weather_class, temperature_band)
);

CREATE INDEX IF NOT EXISTS weather_profiles_condition
  ON weather_profiles(weather_class, temperature_band, route_id, direction_id);
