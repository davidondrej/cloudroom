-- Cloudroom Connect: users' own VPSs (ADR 0319). A VPS is a server row with kind 'vps', owned by an account, not a Mac.
-- Its ports are its sandboxes' Cores and its service's API, which check their own tokens, so the relay only carries them.
-- Macs and remote hosts keep kind NULL. Apply before deploying the Worker that reads it.
-- Apply: wrangler d1 migrations apply cloudroom-connect --remote (from gui/apps/connect).
-- Verify: wrangler d1 execute cloudroom-connect --remote --command "SELECT name FROM pragma_table_info('server') WHERE name = 'kind'".
ALTER TABLE server ADD COLUMN kind TEXT;
