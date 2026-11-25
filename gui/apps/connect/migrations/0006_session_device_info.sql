-- Cloudroom Connect: device metadata, share-parent linkage, and two-phase revocation tombstones for remote sessions.
-- Apply: wrangler d1 migrations apply cloudroom-connect --remote (from gui/apps/connect).
-- Verify: wrangler d1 execute cloudroom-connect --remote --command "SELECT name FROM pragma_table_info('session')".
ALTER TABLE session ADD COLUMN id TEXT;
ALTER TABLE session ADD COLUMN label TEXT;
ALTER TABLE session ADD COLUMN last_seen_at INTEGER;
ALTER TABLE session ADD COLUMN parent_session_id TEXT;
ALTER TABLE session ADD COLUMN revoked_at INTEGER;
ALTER TABLE session ADD COLUMN closed_at INTEGER;
CREATE INDEX session_id_idx ON session (id);
CREATE INDEX session_parent_session_id_idx ON session (parent_session_id);
ALTER TABLE code ADD COLUMN parent_session_id TEXT;
