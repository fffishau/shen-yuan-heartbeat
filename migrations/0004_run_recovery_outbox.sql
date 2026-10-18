PRAGMA foreign_keys = OFF;

CREATE TABLE heartbeat_runs_new (
  id TEXT PRIMARY KEY,
  wake_event_id TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'expired')),
  started_at TEXT NOT NULL,
  lease_expires_at TEXT,
  completed_at TEXT,
  decision TEXT,
  decision_reason TEXT,
  skip_reason TEXT,
  next_wake_at TEXT,
  bark_event_id TEXT,
  error TEXT,
  idempotency_key TEXT,
  commit_token TEXT,
  FOREIGN KEY (wake_event_id) REFERENCES wake_events(id)
);

INSERT INTO heartbeat_runs_new
  (id, wake_event_id, source, status, started_at, completed_at, decision,
   decision_reason, skip_reason, next_wake_at, bark_event_id, error,
   idempotency_key)
SELECT id, wake_event_id, source, status, started_at, completed_at, decision,
       decision_reason, skip_reason, next_wake_at, bark_event_id, error,
       idempotency_key
FROM heartbeat_runs;

-- Older code could create more than one started run for the same wake. Keep the
-- newest candidate active so the partial unique index can be installed safely;
-- the scheduler will lease-expire that remaining legacy run on its next tick.
INSERT OR IGNORE INTO audit_log
  (id, at, actor, action, outcome, subject_id, details_json)
SELECT 'audit_migration_duplicate_' || old.id,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       'migration', 'heartbeat.expire', 'warning', old.id,
       '{"reason":"migration_duplicate_active_run"}'
FROM heartbeat_runs_new AS old
WHERE old.status = 'started' AND old.wake_event_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM heartbeat_runs_new AS newer
    WHERE newer.status = 'started'
      AND newer.wake_event_id = old.wake_event_id
      AND (
        newer.started_at > old.started_at OR
        (newer.started_at = old.started_at AND newer.id > old.id)
      )
  );

UPDATE heartbeat_runs_new AS old
SET status = 'expired',
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    error = 'migration_duplicate_active_run'
WHERE old.status = 'started' AND old.wake_event_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM heartbeat_runs_new AS newer
    WHERE newer.status = 'started'
      AND newer.wake_event_id = old.wake_event_id
      AND (
        newer.started_at > old.started_at OR
        (newer.started_at = old.started_at AND newer.id > old.id)
      )
  );

CREATE TABLE bark_deliveries_new (
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
  FOREIGN KEY (run_id) REFERENCES heartbeat_runs_new(id)
);

INSERT INTO bark_deliveries_new
SELECT * FROM bark_deliveries;

DROP TABLE bark_deliveries;
DROP TABLE heartbeat_runs;
ALTER TABLE heartbeat_runs_new RENAME TO heartbeat_runs;
ALTER TABLE bark_deliveries_new RENAME TO bark_deliveries;

CREATE UNIQUE INDEX heartbeat_runs_idempotency_idx
  ON heartbeat_runs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX heartbeat_runs_active_wake_idx
  ON heartbeat_runs (wake_event_id)
  WHERE wake_event_id IS NOT NULL AND status = 'started';

CREATE INDEX heartbeat_runs_expiry_idx
  ON heartbeat_runs (status, lease_expires_at);

CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'live')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  target_url TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'sending', 'sent', 'simulated', 'failed', 'blocked', 'uncertain')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_expires_at TEXT,
  lease_token TEXT,
  last_attempt_at TEXT,
  provider_status INTEGER,
  provider_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (run_id) REFERENCES heartbeat_runs(id)
);

CREATE INDEX notification_outbox_dispatch_idx
  ON notification_outbox (status, available_at, created_at);

PRAGMA foreign_keys = ON;
