ALTER TABLE heartbeat_runs ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX heartbeat_runs_idempotency_idx
  ON heartbeat_runs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
