PRAGMA foreign_keys = ON;

CREATE TABLE heartbeat_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  heartbeat_enabled INTEGER NOT NULL DEFAULT 0 CHECK (heartbeat_enabled IN (0, 1)),
  push_enabled INTEGER NOT NULL DEFAULT 0 CHECK (push_enabled IN (0, 1)),
  life_events_enabled INTEGER NOT NULL DEFAULT 0 CHECK (life_events_enabled IN (0, 1)),
  last_scheduler_tick_at TEXT,
  last_official_wake_at TEXT,
  next_wake_at TEXT,
  last_bark_at TEXT,
  last_bark_event_id TEXT,
  awaiting_response_since TEXT,
  last_interaction_at TEXT,
  last_skip_reason TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO heartbeat_state (id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE wake_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'wake',
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  visible_text TEXT NOT NULL,
  model_context TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reserved', 'host_sent', 'claimed', 'completed', 'expired', 'failed')),
  created_at TEXT NOT NULL,
  eligible_until TEXT NOT NULL,
  reserved_at TEXT,
  reserved_by TEXT,
  lease_expires_at TEXT,
  host_sent_at TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX wake_events_pending_idx
  ON wake_events (status, created_at);

CREATE TABLE heartbeat_runs (
  id TEXT PRIMARY KEY,
  wake_event_id TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  decision TEXT,
  decision_reason TEXT,
  skip_reason TEXT,
  next_wake_at TEXT,
  bark_event_id TEXT,
  error TEXT,
  FOREIGN KEY (wake_event_id) REFERENCES wake_events(id)
);

CREATE TABLE bark_deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'live')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  target_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('simulated', 'sent', 'failed', 'blocked')),
  provider_status INTEGER,
  provider_message TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (run_id) REFERENCES heartbeat_runs(id)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  subject_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id)
);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id)
);

CREATE TABLE source_grants (
  source TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  revoked_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO source_grants (source, enabled, scopes_json, updated_at)
VALUES ('life-events', 0, '["events:read"]', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE usage_daily (
  day TEXT PRIMARY KEY,
  scheduler_ticks INTEGER NOT NULL DEFAULT 0,
  official_wakes INTEGER NOT NULL DEFAULT 0,
  mcp_calls INTEGER NOT NULL DEFAULT 0,
  bark_attempts INTEGER NOT NULL DEFAULT 0,
  bark_sent INTEGER NOT NULL DEFAULT 0,
  life_event_reads INTEGER NOT NULL DEFAULT 0,
  d1_writes_estimate INTEGER NOT NULL DEFAULT 0
);
