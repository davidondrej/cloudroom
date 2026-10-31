# Run Cloudroom on Ubuntu 24.04

This developer alpha runs Codex or Pi through an HTTP API. No Cloudroom account or GUI is required. Start with Codex below; [Pi configuration](harnesses.md#configure) uses the same service and API.

Use a **fresh VM for one trusted user**, with sudo access, systemd, cgroup v2, and space for your repositories and tools. Disk warnings start at 5 GB available; there is no fixed agent allowance or additional reserve. The installer does not configure quotas or change `/etc/fstab`. Containers and other Linux distributions are outside this guide.

Agents run without approval prompts and share their account's files. Do not give that account sudo or access to a Docker socket.

## Quick install

On an x86_64 or arm64 machine (a VPS, a home server, or a spare laptop), one script does most of the manual setup below, using the newest CI-tested release instead of a source build:

```sh
curl -fsSL https://cloudroom.dev/install.sh -o install.sh
sudo bash install.sh
```

It checks the download's checksum, installs Node.js 24 if it is missing, creates both accounts, writes `/etc/cloudroom/core.env` with a new token, and starts the service. It never prints the token. History stays on this machine ([saved history](#3-saved-history)). When it finishes, it prints the remaining step: sign in to a harness. Use `--version X.Y.Z` to pick a release. It refuses to run over an existing installation.

To build from source instead, follow the manual steps below.

## 1. Install tools and build

Run these commands in an SSH terminal on the VM, as your administrator account:

```sh
sudo apt-get update
sudo apt-get install -y build-essential curl git ca-certificates pkg-config python3 openssl
```

Install [current stable Rust](https://rustup.rs/) and [Node.js 24](https://nodejs.org/en/download). Node and npm must be installed system-wide, under `/usr/local/bin` or `/usr/bin`, not only in your administrator's nvm directory.

```sh
git clone https://github.com/davidondrej/cloudroom.git
cd cloudroom/core
cargo build --locked --release --jobs 2
sudo npm install --global --prefix /usr/local @openai/codex@0.154.0
```

Run the remaining commands from `core/`. Codex 0.154.0 is the previously tested version; newer harness versions may change their protocols.

## 2. Create the service and agent accounts

The service keeps credentials and history separate from agent work. These commands are for a new installation:

```sh
sudo useradd --system --user-group --create-home --home-dir /var/lib/cloudroom --shell /usr/sbin/nologin cloudroom
sudo useradd --create-home --user-group --shell /bin/bash cloudroom-agent
sudo chmod 700 /var/lib/cloudroom /home/cloudroom-agent
sudo install -d -m 700 -o cloudroom -g cloudroom /var/lib/cloudroom/history
sudo install -d -m 750 -o root -g cloudroom /etc/cloudroom
sudo install -d -m 755 /usr/local/lib/cloudroom
sudo install -d -m 700 -o cloudroom-agent -g cloudroom-agent /code
sudo install -m 755 target/release/cloudroom /usr/local/lib/cloudroom/cloudroom
sudo install -m 755 install/configure.py /usr/local/lib/cloudroom/configure.py
sudo install -m 644 install/cloudroom.service /etc/systemd/system/cloudroom.service
sudo install -d -m 700 -o cloudroom-agent -g cloudroom-agent /code/example
sudo -u cloudroom-agent -H git -C /code/example init
sudo -u cloudroom-agent -H /usr/local/bin/codex login --device-auth
```

Complete the login in your browser. If device login is unavailable for your account, use [Codex's supported login methods](https://developers.openai.com/codex/auth/) under the same `cloudroom-agent` account. Do not put inference credentials in the service environment.

### Retire standalone shell agents

Keep Codex/Pi setup under the agent account. SSH remains for administration; tasks go through the core API. After shell-owned agents exit, run `sudo python3 install/agent-home.py --shell-user YOUR_SSH_USER` to preview, then repeat with `--apply`.

This preserves the old setup in a root-private archive, copies only missing supported settings, and blocks the administrator's normal Codex/Pi commands and default auth writes. Core logins, processes and histories stay untouched. Conflicts and symlinked settings remain archived for review; do not restore stale tokens automatically. `--check` detects competing shell setup without deleting it. This is an operational guard, not a sandbox against a VM administrator.

Recreated files under a previously retired home are archived separately, never used as runtime credentials. Unmarked conflicting setup fails closed.

## 3. Saved history

Core records every session in its journal on this machine (`CLOUDROOM_STATE_DIR`) before anything else happens. Self-hosted, that journal is the history: set `CLOUDROOM_LOCAL_HISTORY=1` and back the directory up yourself (ADR 0237). No database is needed.

Cloudroom's managed sandboxes also save history off the machine: Core sends it to `CLOUDROOM_API_URL`, our website, which stores it as gzip files in object storage. Any server that answers the same five calls can stand in for it; `tests/fake_api.py` is a minimal one. Core refuses to start without one of the two settings, so a managed machine never silently keeps history only on its disk.

## 4. Configure the service

Generate a token directly into a protected file, then edit it:

```sh
sudo sh -c 'umask 077; set -C; printf "CLOUDROOM_TOKEN=%s\n" "$(openssl rand -hex 32)" > /etc/cloudroom/core.env'
sudoedit /etc/cloudroom/core.env
```

Keep the generated `CLOUDROOM_TOKEN` line. Add the following, replacing the model ID.

```ini
CLOUDROOM_LISTEN=127.0.0.1:9840
CLOUDROOM_STORE=self-hosted
CLOUDROOM_LOCAL_HISTORY=1
CLOUDROOM_STATE_DIR=/var/lib/cloudroom/history
CLOUDROOM_ACCOUNT_HOME=/home/cloudroom-agent
CLOUDROOM_REPOSITORY=/code/example
CLOUDROOM_CODEX_BINARY=/usr/local/bin/codex
CLOUDROOM_CODEX_HOME=/home/cloudroom-agent/.codex
CLOUDROOM_CODEX_MODEL=REPLACE_WITH_A_MODEL_YOUR_ACCOUNT_SUPPORTS
```

The service unit already sets `CLOUDROOM_STORAGE_POLICY=/etc/cloudroom/storage.json`. Keep the token out of Git, prompts, and agent-owned files.

```sh
sudo chown cloudroom:cloudroom /etc/cloudroom/core.env
sudo chmod 600 /etc/cloudroom/core.env
sudo python3 install/configure.py --storage-only /etc/cloudroom
sudo systemctl daemon-reload
sudo systemctl enable --now cloudroom.service
```

Do not bypass failed protection setup with `CLOUDROOM_UNPROTECTED_TEST_MODE`. See [disk setup and existing-VM upgrades](storage.md#provisioning).

## 5. Run your first task

Keep using the administrator's SSH terminal. This helper reads the token without placing it in curl's command-line arguments:

```sh
api() {
  sudo awk -F= '/^CLOUDROOM_TOKEN=/{print "header = \"Authorization: Bearer " $2 "\""}' /etc/cloudroom/core.env |
    curl --config - --silent --show-error --fail-with-body "$@"
}
api http://127.0.0.1:9840/v1/ready
api --json '{"request_id":"quickstart","harness":"codex"}' http://127.0.0.1:9840/v1/sessions
api http://127.0.0.1:9840/v1/sessions/cr_quickstart
```

Readiness should return `{"ready":true}`. Session creation is asynchronous: repeat the last command until `session.state` is `idle`, then send a task:

```sh
api --json '{"request_id":"hello","text":"Create hello.txt containing Hello from Cloudroom."}' \
  http://127.0.0.1:9840/v1/sessions/cr_quickstart/prompts
api --no-buffer http://127.0.0.1:9840/v1/sessions/cr_quickstart/stream
```

HTTP 202 means the request was accepted, not completed. Watch for the `hello` receipt to become `completed`. Ctrl+C or disconnecting SSH only closes your view; the service keeps working.

Reconnect, define `api` again, and read the saved events or send another message:

```sh
api http://127.0.0.1:9840/v1/sessions/cr_quickstart/events
sudo -u cloudroom-agent cat /code/example/hello.txt
api --json '{"request_id":"followup","text":"Read hello.txt and tell me what it contains."}' \
  http://127.0.0.1:9840/v1/sessions/cr_quickstart/prompts
```

Follow-ups sent while the agent is busy queue on the VM. Reuse a request ID only to retry the same command; use a new ID for new work. Event pages contain at most 256 records; request `?after=LAST_SEQUENCE` for the next page. The stream also accepts that cursor.

When finished, release the session's agent slot without deleting its history:

```sh
api --json '{"request_id":"close-quickstart"}' http://127.0.0.1:9840/v1/sessions/cr_quickstart/close
```

## Use your repository and connect an app

- Start sessions in [cloud folders](#cloud-folders) without cloning or copying first. Requests without a workspace keep using `CLOUDROOM_REPOSITORY` (or the configured agent home). Existing sessions retain their recorded directory.
- The API serves plaintext HTTP and defaults to the VM's loopback address. For remote apps, use [Tailscale](#reach-it-from-your-other-devices), or an HTTPS reverse proxy that supports SSE without buffering and forwards `Authorization`. Keep port 9840 private; never send bearer tokens over public HTTP.
- Restarting the core interrupts running work. [Session lifecycle](session-lifecycle.md) explains recovery and uncertain outcomes. History saved externally survives VM loss; files in your workspace and pending history uploads do not have that guarantee.

### Non-loopback backends and upgrades

A proxy or hosting gateway outside the VM's loopback interface may need a non-loopback `CLOUDROOM_LISTEN`. Set `CLOUDROOM_ALLOW_NON_LOOPBACK_HTTP=1` in the protected service environment only after restricting backend access to that proxy over a protected connection. This applies to private IPs and IPv6 too. The setting permits plaintext HTTP; it does not enable TLS, configure a firewall, or verify the proxy. Storage protection is separate, and unprotected test mode remains loopback-only.

**Before upgrading an existing non-loopback installation**, review its HTTPS and backend access controls, then add this setting to its existing `core.env`. Without it, the new binary refuses startup. Loopback installations need no change. For fresh installations, `configure.py` copies an explicitly supplied value of `1`; retries never add it to or overwrite existing configuration.

## Reach it from your other devices

[Tailscale](https://tailscale.com) gives Core an HTTPS address inside your private network: no domain, no open ports, and no proxy to configure.

1. Install Tailscale on this machine and on your laptop, signed in to the same account: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`.
2. In the Tailscale admin console, under **DNS**, turn on MagicDNS and HTTPS certificates.
3. Run `sudo tailscale serve --bg 9840`. Core keeps listening on localhost.
4. `tailscale serve status` shows your Core's URL, like `https://my-server.tail1234.ts.net`. Only your devices can reach it, and every request still needs the token.

Never use `tailscale funnel` for Core: it opens the API to the whole internet.

## Connect the desktop app

In the [Cloudroom app](https://www.cloudroom.dev/download) (v83 or newer), open **Settings → Cloudroom account → Connect your own Core**. Enter the HTTPS URL and the token from `sudo grep ^CLOUDROOM_TOKEN= /etc/cloudroom/core.env`. No Cloudroom account is needed. Cloud threads then run on this machine and share its files.

## Upgrade

Pick a `core-v` version from the [releases](https://github.com/davidondrej/cloudroom/releases), then:

```sh
v=X.Y.Z; a=$(uname -m)
curl -fsSLO https://github.com/davidondrej/cloudroom/releases/download/core-v$v/cloudroom-core-$v-linux-$a.tar.gz
mkdir core-$v && tar -xzf cloudroom-core-$v-linux-$a.tar.gz -C core-$v
sudo python3 core-$v/install/update.py upgrade "$PWD/core-$v"
sudo cat /var/lib/cloudroom-update/state.json
```

The script waits until agents are idle, backs up the old core, swaps it, checks every session, and rolls back on failure. Your settings, logins, and history stay. `"result": "updated"` means done; `waiting` means agents were busy, so run it again later. It never downgrades.

## If something fails

```sh
sudo journalctl -u cloudroom.service -n 50 --no-pager
api http://127.0.0.1:9840/v1/health
sudo -u cloudroom-agent -H /usr/local/bin/codex login status
```

A failed readiness check usually means the journal or disk protection needs attention. A failed agent start may mean login or model configuration. There is no fixed limit on open harness sessions; actual concurrency depends on available VM resources. Keep logs private when asking for help.

## Machines without systemd

Run `install/sandbox-start.sh` as root, detached, on every boot. It parses (never sources) `image.env` and `/etc/cloudroom/core.env`, creates the agents' cgroup, runs Core as `cloudroom` with only the capabilities it needs, and restarts it after a crash. Containers without cgroups run Core in [container mode](storage.md#containers). A second start is a no-op. The log is `/var/log/cloudroom/core.log`. With `"agent_sudo": true` in `storage.json`, agents keep sudo on that machine. Before a stop, `POST /v1/drain {"hold":true}` refuses new work and reports whether anything still runs; `{"hold":false}` reopens it.

## Cloud folders

Send `"workspace":"PROJECT_ID"` and optional `"workspace_name":"project-name"` with `POST /v1/sessions`. The core creates an empty directory under `/code` and starts the harness. Repeated workspace IDs reuse their recorded directory; name collisions never overwrite another folder. No Git repository, local source folder, archive upload, or sync worker is required. The agent can clone a repository or install dependencies after starting. Send `"workspace":"root"` to start in `/code` itself, outside any project folder.

`GET /v1/workspaces/PROJECT_ID` returns the mapping; `GET /v1/sessions/SESSION_ID/workspace` returns the actual directory and Git metadata, which may be null. `/code` belongs to the unprivileged agent; the installer prepares it. Existing folders, nested mappings, session IDs, and history remain intact. No new environment variable or SQL migration is required.

The capability is `direct_workspaces: true`. Archive import, preparation, and activation endpoints are removed. Old project-sync requests are rejected, including reads, so an empty cloud folder cannot trigger local deletions.

## Skills and login sync

Run `python3 src/sync/client.py configure LOCAL_SYNC_DIR --connection PRIVATE_CONNECTION_JSON` on the Mac or Linux. The private JSON contains the existing core `url`, `token`, and optional `gateToken`; use mode 0600. This installs an independent background job for skills, supported settings, and Codex login only: a LaunchAgent on macOS, a systemd user service on Linux. Python 3.11+ is needed for Codex TOML settings. `status` reports state; `stop` removes the job. Other systems, such as Windows, can configure with `--no-start`, then supervise `run` themselves. Do not start your own `run` for a folder that the app or `configure` already started; setup then fails with "Another sync helper is still running".

Project files, unpublished Git changes, and project `.env` files no longer sync. Use Git or explicit message attachments. Conflicting skill/settings changes are preserved; offline changes catch up. `POST /v1/sync` handles device registration/status, file operations remain under `/v1/sync/{id}`, and `GET /v1/settings` is read-only.

On upgrade, stop old repository-sync workers before releasing pending starts. Reconfiguring the helper removes repository roots and aliases without deleting original files, old baselines, or recovery copies. Review queued prompts before restarting the core: previously waiting sessions can now start. Verify with `python3 tests/workspaces.py` and `python3 tests/sync_e2e.py`.
