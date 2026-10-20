# Localhost cloud previews

An agent starts an HTTP development server, runs `room-cli preview PORT`, and posts the returned URL. No GUI button, public hosting route, or inference integration is needed. Local threads continue using ordinary localhost servers.

## Commands

```sh
room-cli preview 3000
room-cli preview status 3000
room-cli preview status
room-cli preview close 3000
```

Commands return JSON. Only `state: "ready"` includes a current laptop URL, such as `http://p3000-1234abcd.localhost:3000`. The local port can differ when occupied. Registration retries reuse the preview; close/reopen creates a new generation. Close removes registration and disconnects the dedicated preview SSH connections, never the development server. Other previews reconnect automatically. The agent owns the server's lifecycle.

The open command waits briefly for the helper, then returns pending rather than blocking cloud work. Readiness expires after 15 seconds without a helper report. Readiness checks the browser-facing local proxy through SSH to an HTTP server, not merely the SSH process. It does not mean the application passed its tests.

## Machines without inbound SSH

Write `previews/setup.json` with `"tunnel": true` and no SSH fields. Pairing then returns `{"tunnel":true}`. The helper opens each preview connection as `GET /v1/previews/PORT/tunnel?device=ID` with `Upgrade: websocket` and the core bearer token; cores before 0.1.35 answer that with `400`, so the helper retries with `Upgrade: cloudroom-tunnel`. This handshake and every control request carry `User-Agent: Cloudroom-Helper`, because proxies such as Cloudflare refuse urllib's default. A User-Agent the caller supplies replaces it; on both paths header names match case-insensitively and the last value wins, as in urllib. Either name opens the same raw tunnel, with no WebSocket frames: the `websocket` name only gets it through proxies that relay nothing else. Core rechecks the device, the registration, and the agent's listener, answers `101`, and joins the connection to `127.0.0.1:PORT`. Closing a preview or revoking the device ends its tunnels. Mac access uses the same pairing.

## Ownership

- `src/preview/mod.rs`: registry, agent-only Unix socket, authenticated HTTP API, public SSH-key authorization, and CLI. Runs inside the existing core service. Registry writes stay in the protected state directory; no SQL.
- `src/preview/client.py`: independent Mac helper. Reuses authenticated HTTPS, prepares managed SSH metadata automatically, owns forwarding/local listeners, and reports actual URLs. Closing the GUI does not stop it. Sign-out stops it and revokes access on every reachable core; an unreachable VM or sandbox never blocks sign-out. Desktop updates pause it without losing pairing.
- `install/previews.py`: operator-only setup of the dedicated forwarding account and SSH policy. Existing VM upgrades require an explicit operator setup; ordinary `configure.py` retries do not change SSH.
- `src/preview/cloud-preview/SKILL.md`: instructions for agents. The installer copies it into supported harness skill directories without overwriting existing files.

## Installation

Requires the existing Linux core, OpenSSH server/client, curl, and Python 3.11+. No extra application dependency or separate cloud service.

As the VM operator, install `install/previews.py` beside the compiled core and install the updated core systemd unit. Then run it with the actual protected `CLOUDROOM_STATE_DIR`:

```sh
sudo python3 /usr/local/lib/cloudroom/previews.py /var/lib/cloudroom/history
```

The script installs only the preview account's SSH policy and a root-owned `/etc/ssh/cloudroom-preview-keys` entry point. This works when the provider owns `/usr/local/lib`; it does not change shared directory permissions. It validates SSH configuration before reloading SSH, without restarting the core. The updated core must subsequently start under the normal approved deployment process. `RuntimeDirectory=cloudroom` recreates its socket directory on boot. The public SSH host key is read at pairing time, not copied from a template's machine identity.

The helper retries missing/stale metadata without requiring another sign-in. Preparation failures do not block sign-in or cloud sessions.

Self-hosters set the reachable IP through authenticated `POST /v1/previews/host` with `{"host":"VM_IP"}`. SSH defaults to port 22. A different port belongs in the protected `previews/setup.json`.

The desktop bundles and configures the helper automatically when `capabilities.previews` is true. Without the GUI:

```sh
python3 src/preview/client.py configure /path/to/private-preview-state --connection /path/to/private-cloudroom.json
python3 src/preview/client.py status /path/to/private-preview-state
python3 src/preview/client.py pause /path/to/private-preview-state  # App update: keep pairing.
python3 src/preview/client.py stop /path/to/private-preview-state   # Sign-out: revoke SSH access.
```

The existing connection file contains `url`, `token`, and optional `gateToken`/account identity; it must be mode 0600. HTTPS is required except explicit loopback tests. Use `--allow-private-ssh` for an intentionally private self-hosted SSH IP. `--no-start` prepares files without launchd; `run DIRECTORY` runs the helper in the foreground. Never pass secret values in command arguments.

## API

All `/v1/previews` operations require the ordinary core bearer token:

- `GET /v1/previews`: registered previews and fresh status.
- `POST /v1/previews`: register `{"port":3000}`.
- `GET` / `DELETE /v1/previews/{port}`: inspect / close.
- `POST /v1/previews/device`: pair `device` (32 hex characters) and an Ed25519 `public_key`; return SSH connection metadata, never a private key.
- `DELETE /v1/previews/device/{id}`: revoke future SSH authentication for that device.
- `POST /v1/previews/report`: helper reports `device`, `port`, `generation`, nullable `local_port` and fixed nullable `error`.
- `POST /v1/previews/host`: operator/managed pairing sets the reachable SSH IP.

The narrow Unix socket exposes only registration/status/close. Kernel peer credentials restrict it to the configured agent UID; agents never receive the administrative bearer token. CLI `--socket PATH` is for isolated verification or deliberate alternative installation paths.

## Security and limits

- Only non-privileged ports whose IPv4-loopback destination is agent-owned can be registered. Exact binds take precedence over wildcard listeners; another address with the same port is not ownership proof. Core and SSH ports are excluded. SSH checks again when authorizing a connection.
- Dedicated keys stay on the Mac. SSH permits only registered IPv4-loopback destinations, no shell, sudo, reverse forwarding, agent forwarding, or Unix-socket forwarding on the VM. The authenticated core supplies the public host identity for strict SSH verification.
- The helper binds only local loopback. A private Unix socket separates raw SSH forwarding from the browser-facing HTTP proxy. Exact Host/Origin checks also apply to WebSocket upgrades. Preview hostnames are distinct from the core/control UI; control credentials never enter app requests.
- One paired Mac is supported, matching the current configuration-sync model. Disconnect its previews before pairing another. Ports are remembered across helper/tunnel restarts; if another app occupies one, request the newly reported URL.
- Same-origin HTTP, WebSocket and SSE are supported. Use the project's normal dev proxy for cross-origin backend calls. Chunked request uploads are rejected; browser uploads with Content-Length work. HTTPS-only development servers are not supported by this HTTP preview slice.
- Close/revoke remove authorization before terminating the dedicated preview account's SSH connections, including its root SSH authentication monitors. Linux pidfds avoid signaling reused PIDs. This uses the core unit's existing `CAP_KILL`, never a general sudo endpoint. Operator SSH and agent workloads are untouched. Failure is reported rather than claiming revocation succeeded. Broader hosted-account closure remains separate.
- A brief control-network failure does not drop healthy tunnels immediately; lost authorization closes them. A slow application does not serialize other previews' probes. Closed laptops cannot serve localhost; recovery resumes when the helper runs again.
- Hostile code on the same Mac account or the shared VM agent account is not isolated per agent. Port ownership checks are admission checks, not a sandbox around the application.

## Verification

Run `python3 tests/preview_client.py` for real HTTP/Unix-socket proxy regressions. It also drives the helper through a local TLS edge proxy that emulates the Cloudflare rule reported in #38 (it refuses urllib's default User-Agent), using a throwaway CA from `openssl`; no network beyond loopback. On a disposable Linux machine with OpenSSH and a built core, run `sudo python3 tests/previews_ssh.py --disposable`: it checks the agent CLI, destination ownership, restricted SSH and active revocation. It refuses machines with existing Cloudroom accounts. Both are wired into CI alongside Rust and existing checks.

Before rollout, verify browsers, real development-server live reload, streaming, uploads, occupied ports, reconnect and sign-out. macOS 26 supports `.localhost` in Safari; older supported systems need separate verification. A source build changes no production configuration.
