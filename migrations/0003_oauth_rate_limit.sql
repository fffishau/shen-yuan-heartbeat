CREATE TABLE oauth_auth_attempts (
  id TEXT PRIMARY KEY,
  attempt_key TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1))
);

CREATE INDEX oauth_auth_attempts_window_idx
  ON oauth_auth_attempts (attempt_key, attempted_at);
