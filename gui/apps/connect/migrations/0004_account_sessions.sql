-- Cloudroom Connect: phones sign in with the Cloudroom account at app.cloudroom.run (ADR 0268).
-- An account session has user_id set; its server_id is the Mac the phone has picked, and switching Macs changes it.
-- Port-share codes and the sessions they start carry the account too, so "Sign out all phones" ends them.
-- Apply: wrangler d1 migrations apply cloudroom-connect --remote (from gui/apps/connect).
-- Verify: wrangler d1 execute cloudroom-connect --remote --command "SELECT name FROM pragma_table_info('session')".
ALTER TABLE session ADD COLUMN user_id TEXT;
CREATE INDEX session_user_id_idx ON session (user_id);
ALTER TABLE code ADD COLUMN user_id TEXT;
