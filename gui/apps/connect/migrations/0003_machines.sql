-- Cloudroom Connect: remote hosts, the machines that run threads for one of your Macs (ADR 0238).
-- A machine is a server row whose owner_server_id is that Mac. Its handle carries its port shares; its credential reaches the Mac.
-- Apply: wrangler d1 migrations apply cloudroom-connect --remote (from gui/apps/connect).
ALTER TABLE server ADD COLUMN owner_server_id TEXT REFERENCES server(id) ON DELETE CASCADE;
CREATE INDEX server_owner_server_id_idx ON server (owner_server_id);
