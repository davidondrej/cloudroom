-- Cloudroom Connect: each Mac's computer name, shown when you switch between your Macs.
-- Apply: wrangler d1 migrations apply cloudroom-connect --remote (from gui/apps/connect).
ALTER TABLE server ADD COLUMN name TEXT;
