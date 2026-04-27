-- Initial schema for Power Predict D1 database.

CREATE TABLE users (
  id              INTEGER PRIMARY KEY,         -- Strava athlete id
  display_name    TEXT,
  access_token    TEXT,                         -- encrypted at rest (TODO)
  refresh_token   TEXT,
  token_expires_at INTEGER,
  created_at      INTEGER NOT NULL,
  last_sync_at    INTEGER
);

CREATE TABLE activities (
  id              INTEGER PRIMARY KEY,          -- Strava activity id
  user_id         INTEGER NOT NULL REFERENCES users(id),
  start_time      INTEGER NOT NULL,             -- unix seconds, UTC
  duration_s      INTEGER NOT NULL,
  distance_m      REAL,
  avg_power       REAL,
  normalized_power REAL,
  intensity_factor REAL,
  tss             REAL,
  has_power       INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL,                -- 'archive' | 'webhook' | 'api'
  ingested_at     INTEGER NOT NULL
);

CREATE INDEX idx_activities_user_time ON activities(user_id, start_time);

-- One row per (activity, duration_window). Stores best avg power for that
-- duration in that activity, plus a quality flag derived from intensity.
CREATE TABLE mmp_records (
  activity_id     INTEGER NOT NULL REFERENCES activities(id),
  duration_s      INTEGER NOT NULL,
  power_w         REAL NOT NULL,
  is_true_mmp     INTEGER NOT NULL DEFAULT 0,   -- effort-quality flag
  PRIMARY KEY (activity_id, duration_s)
);

-- Snapshot of fitted CP/W' parameters at a point in time (rolling window).
CREATE TABLE cp_fits (
  user_id         INTEGER NOT NULL REFERENCES users(id),
  fit_date        INTEGER NOT NULL,             -- unix seconds, UTC
  window_days     INTEGER NOT NULL,
  cp_w            REAL NOT NULL,
  w_prime_j       REAL NOT NULL,
  p_max_w         REAL,
  rmse            REAL,
  data_points     INTEGER NOT NULL,
  PRIMARY KEY (user_id, fit_date, window_days)
);
