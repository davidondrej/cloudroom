-- Cloudroom Connect relay on cloudroom.run (ADR 0184, ADR 0185). Cloudflare D1 database "cloudroom-connect".
-- What: one row per registered Mac, one-time codes, and signed-in phone sessions.
-- Apply: wrangler d1 migrations apply cloudroom-connect --remote (from gui/apps/connect).
-- Verify: wrangler d1 execute cloudroom-connect --remote --command "SELECT name FROM sqlite_master WHERE type='table'".

CREATE TABLE server (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  credential_hash TEXT NOT NULL UNIQUE,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, install_id)
);

-- target is NULL for the app itself, or a shared port.
CREATE TABLE code (
  code_hash TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES server(id) ON DELETE CASCADE,
  target TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX code_expires_at_idx ON code (expires_at);

CREATE TABLE session (
  token_hash TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES server(id) ON DELETE CASCADE,
  target TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX session_server_id_idx ON session (server_id);
