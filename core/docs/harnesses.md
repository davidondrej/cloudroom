# Harness adapters

Cloudroom owns processes, durable requests/queues, recording, replay and recovery. Harnesses own their agent loop, tools, inference, retries and compaction. Runtime's shared process driver handles bounded stdio, shutdown and Linux containment; each adapter owns its protocol and native history.

## Configure

Existing Codex environment variables still work. `CLOUDROOM_HARNESS` selects the default (`codex` when omitted). Configure the required adapters:

- Codex: `CLOUDROOM_CODEX_BINARY`, `CLOUDROOM_CODEX_HOME`, `CLOUDROOM_CODEX_MODEL`.
- Pi: `CLOUDROOM_PI_BINARY`, `CLOUDROOM_PI_HOME`, `CLOUDROOM_PI_MODEL`, `CLOUDROOM_PI_PROVIDER`.
- `CLOUDROOM_MODEL` remains the fallback when an adapter-specific model is omitted.
- `CLOUDROOM_ACCOUNT_HOME` and the prepared repository remain shared account/workspace settings.

Example Pi-only configuration (in addition to the existing database, token, repository and storage settings):

```sh
CLOUDROOM_HARNESS=pi
CLOUDROOM_PI_BINARY=/usr/local/bin/pi
CLOUDROOM_PI_HOME=/home/cloudroom-agent/.pi/agent
CLOUDROOM_PI_PROVIDER=openai-codex
CLOUDROOM_PI_MODEL=gpt-6-astra
```

Use the official `@earendil-works/pi-coding-agent` **0.85.1 or newer** (images ship 1.0.0), with its supported Node runtime on `/usr/local/bin:/usr/bin:/bin`. Provision the harness and its account credentials separately; the core does not install packages or perform login. Adapter startup verifies the resolved model/provider, native identity, and bundled context extension. Protocol compatibility must be tested before upgrading Pi.

Memory and CPUs (`agent_env` in `src/runtime/linux.rs`): in a container with no swap, the kernel kills the biggest process when memory runs out, often the agent, and `nproc`, Node's `os.cpus()` and Python's `os.cpu_count()` count every host CPU, so tools start a worker per host CPU. Every harness gets `BASH_ENV` (and `CLAUDE_ENV_FILE`, which Claude Code's command shells source instead), so each command it runs, and everything that command starts, is killed first (`oom_score_adj` 500); the harness and Core keep 0. With a cgroup CPU quota it also gets `OMP_NUM_THREADS` and `PYTHON_CPU_COUNT` set to the quota, a Node preload that trims `os.cpus()`, and a `sitecustomize` that brings `PYTHON_CPU_COUNT` to Python before 3.13, then runs the one it hides. Core writes the helpers to `/run/cloudroom/agent` at start. A user's own value wins; `NODE_OPTIONS` and `PYTHONPATH` keep it after Core's.

Pi runs through `--mode rpc`; it is not embedded or forked. Startup networking/telemetry are disabled through Pi's process flags. Existing Pi settings/resources and explicit project-trust decisions still apply. Prepare trusted packages before service startup. The account directory is separate from Cloudroom's protected state directory. Every configured harness home must share the monitored filesystem with the workspace. Neither API/database tokens nor administrative environment variables are inherited by either harness. Pi credentials are available to that agent account; this is not isolation of inference credentials from its own tools.

## Claude Code

`src/runtime/claude.rs` integrates the native CLI through stream JSON, without an SDK bridge. Core discovers `CLOUDROOM_ACCOUNT_HOME/.local/bin/claude`, then `/usr/local/bin/claude`, when the account's `.claude` directory exists. Prepare both before restarting core. No Claude-specific service variables are needed. Core resolves the executable path at startup: restart it safely after upgrading the CLI to use the new binary and model catalog. Opus 5.5 requires Claude Code **2.1.280+**. The default model is `sonnet`; session creation can select another native model. Core also accepts exact models Claude's catalog omits, such as `claude-opus-5-5[1m]`, at any effort the catalog lists; Claude reports an unknown model itself. `CLOUDROOM_HARNESS=claude-code` selects Claude as the default harness.

### Native subscription login

Use **Connect Claude** with Cloud selected. Approve Anthropic's browser sign-in, then enter its one-time authorization code in the connection panel—not chat. Core forwards that code to the native CLI; Claude exchanges it and stores/renews credentials on the VM. Tokens never pass through the GUI or core API. Do not copy Mac credentials.

The `claude_auth` capability exposes authenticated `GET /v1/accounts/claude` and `POST /v1/accounts/claude/{login,cancel,complete}`. Mutations take `request_id`; `complete` also takes `code` and OAuth `state`. Duplicate starts reuse the pending flow; cancellation targets its ID. The isolated, tool-free CLI process expires after ten minutes and produces no conversation records. Tested with Claude **2.1.280**. Upgrade core and GUI together.

Terminal fallback: run `claude auth login` and `claude auth status` as the configured agent account (`sudo -iu cloudroom-agent`), never root or the protected core account.

Create sessions with `"harness":"claude-code"`. Missing login returns `claude_auth_required` before acceptance; verification failures return `claude_auth_unavailable`. The GUI retains the task and offers **Retry start** after native login. This is login guidance, not an embedded OAuth flow or a live subscription-limit check.

Steering writes the message into the running turn, as Local's Claude does; a steer that misses its turn runs as Claude's own turn. The adapter disables Fast mode, structured questions and hidden native subagents. The one exception is a forked skill (such as `/code-review`): its subagent runs inside the Skill call, and only the call's result reaches the conversation. Delegation uses Cloudroom child sessions through an in-process MCP transport. Hooks/plugins load normally. Startup and context notices use native non-query messages, not inference. Rewind forks conversation history without restoring files; native paths and checkpoints remain adapter-owned.

### Selected skills

Structured prompt `content` can carry skill mentions with UTF-16 `start`/`end` offsets and a `resource` containing `kind: "command"`, `source: "skill"`, `name`, and `origin: "user" | "project"`. Its text blocks, joined with newlines, must match `text`. The Claude harness advertises `skill_mentions: true`; GUI clients must not drop these mentions when using an older core.

Before each send, core loads the selected user/project `SKILL.md` bodies on the execution machine under the agent's file permissions. Tags work anywhere and repeated selections load once. Saved requests stay unchanged. Missing, ambiguous, oversized or unsupported native-feature skills fail before delivery. Bodies are literal instructions, not a replacement for native argument, shell, hook or fork execution; use an untagged leading slash command for those features and namespaced plugin skills.

### Verification boundary

Local probes against Claude Code **2.1.278** verified guarded startup, context-only notices, missing-login failures, exact-identity resume, conversation forks and acknowledged shutdown. HTTP checks used disposable PostgreSQL and logged-out native execution; a separate wire fixture verified child coordination, compaction, Stop and queued continuation. These are not real-inference evidence. Logged-in Linux/GUI acceptance and template activation remain required before claiming deployment readiness. Upgrades must preserve the checked lifecycle, cancellation and hook capabilities.

## Cloud Codex sign-in

The core advertises `codex_auth` and exposes authenticated `GET /v1/accounts/codex`, `POST /v1/accounts/codex/login`, and `POST /v1/accounts/codex/cancel`. Mutations accept `{ "request_id": "unique-id" }`; reuse it after an uncertain response. Cancellation targets that login attempt only.

The core uses Codex's official device-code flow in the configured runtime user's home. Enable device-code login in ChatGPT security settings if OpenAI requires it. The app receives only account status and the temporary verification URL/code, never OAuth tokens. Login traffic is excluded from conversation and diagnostic records. A live account/usage check verifies ChatGPT access; limits and network errors stay distinct from missing authentication. Active Codex work blocks login changes.

New Codex starts without authentication return `codex_auth_required` before acceptance. Clients keep the prompt and offer sign-in, then retry the same start ID. Already accepted work and running sessions are unchanged. Expired login attempts can be restarted; interruption never replays a task.

With `codex_auth_import`, authenticated `POST /v1/accounts/codex/import` accepts a file-backed ChatGPT login (64 KiB maximum). It creates `auth.json` only when absent, under the runtime user with mode `0600`, then verifies the account. Existing files, active work, and pending browser sign-ins are preserved. Retries never replace a login; tokens never enter responses or history.

The desktop helper attempts this import before showing sign-in or starting Codex, and discovers logins added after pairing. `CODEX_HOME` is remembered; Keychain-only, missing, or unusable local logins fall back to **Connect Codex**. Import is not continuous credential sync or account switching. Old `auth-codex` sync requests still receive HTTP 410. Upgrade core and desktop together; existing cloud logins remain intact. Each native Codex manages renewal; cross-machine refresh conflicts still require live verification.

## Cloud Pi logins

Only after the user agrees in first-run setup, the Mac sync helper copies Pi providers from `~/.pi/agent/auth.json` (or `PI_CODING_AGENT_DIR`) that the VM lacks. It runs every sync cycle and before each Cloud Pi start, and resends only when a Mac Pi file changes. VM logins always win. `!command` and `$VAR` keys are resolved on the Mac first, because the VM cannot run Mac secret managers or see Mac shell variables; unresolved keys are skipped.

With `pi_setup`, the helper also copies custom providers from `models.json` (Mac wins per provider; VM-only providers stay), syncs `extensions/`, and sends the `packages` list from `settings.json`. `POST /v1/accounts/pi/setup` saves the providers and runs `pi install` in the background for remote packages the VM lacks. Local-path packages stay on the Mac.

`GET /v1/accounts/pi` lists provider names, never secrets. `POST /v1/accounts/pi/import` adds valid missing providers. `POST /v1/accounts/pi/key` with `{"provider","key"}` saves or replaces one API key; the CLI is `room-cli cloud pi key PROVIDER`, reading the key from stdin. Copied OAuth logins refresh separately on each machine, so one side may need to sign in again.

### Continue after a usage limit

A Codex or Pi turn that fails on a subscription usage limit is recorded as `usage_limited`. A limited account may sign in with another ChatGPT account. After a successful sign-in, import, or authenticated `POST /v1/accounts/codex/switched` (for logins installed outside the core), the core verifies the account. If it is usable, the core restarts each quota-stopped session's harness so it loads the new login, then sends `keep working`. The response lists `continued` session IDs. Manually stopped, busy, or queued sessions are left alone; nothing is resent twice. Other idle Codex sessions keep their loaded login until their next restart.

## API and compatibility

Select a configured harness when creating a session:

```json
{"request_id":"my-session","harness":"pi"}
```

All other session, prompt, interrupt, close, events and SSE endpoints are shared. Session creation accepts a model override and a reasoning level for either harness. Pi maps `none` to `off`, verifies the model supports the requested level, and checks that Pi applied it; unsupported levels fail rather than being silently changed. Capabilities include each harness's default inference provider. Pi advertises `provider_selection: true`; creation accepts an optional `provider` override authenticated in its private Pi home. Omitting it preserves the configured default. Harness selection, model, reasoning and provider are saved with acceptance; changing deployment defaults does not change an existing session's selected model. Explicitly selecting another harness with the same creation request ID conflicts. Legacy receipts without harness metadata mean Codex. Original stored records are not rewritten, and legacy Codex `data.value` is reconstructed on reads inside the adapter boundary.

Codex reasoning is validated against its native `model/list` catalog, not a fixed Cloudroom list. `/v1/capabilities` exposes `harnesses[].models` with each model's `reasoning_levels`; a null catalog means discovery failed, not unsupported models. Discovery creates no Codex thread or turn and is cached for 60 seconds. Pi exposes its adapter's `reasoning_levels`; its model-specific check still happens during startup. Existing accepted requests are deduplicated before model revalidation.

Launch rejections include stable codes such as `invalid_reasoning_effort`, `invalid_model`, and `request_conflict`. `storage_blocked`, `service_stopping`, and `model_catalog_unavailable` are temporary. Clients should classify codes, not assume every HTTP 409 is permanent, and never display arbitrary remote error bodies.

Session responses include `harness`, `provider`, `capabilities` and an adapter-owned `native_cursor`. `current_turn` and `native_offset` remain for legacy Codex readers; they are not portable request/capture identifiers. Follow `current_request` and receipts for execution. Pi emits common text/thinking deltas and item/tool events; `tool_snapshot` replaces previous partial tool output rather than appending it. Raw native frames and native session records are preserved.

## Command Guard

New Codex, Pi and Claude runs include a small shell-command guard by default. Disable it
for a session with `command_guard_enabled: false` in `POST /v1/sessions`; this
choice survives resume and passes to Cloudroom-managed Pi and Claude children. The guard
runs on the execution machine without the GUI. It never edits personal hooks or
trusts unrelated Codex hooks. It never blocks a harness from starting, and a
guard error allows the command.

Rules cover root/home deletion, disk wipes, hosted repository deletion, and fork
bombs. Blocks return a named reason to the agent. This is regex-based accident
prevention, not a sandbox or protection against arbitrary scripts and tools.
Codex hooks were verified with 0.155.1; Pi uses the version above. Core Codex
startup also requires the system Node runtime already used by Pi. Missing Node
fails startup rather than silently dropping the guard.

`src/runtime/command-guard.mjs` owns the shared rules and hook source. Keep its
GUI copy, `gui/packages/plugin-sdk/src/internal/command-guard-runtime.mjs`,
byte-identical when preparing a release.

## Cursor implementation preview

The core discovers `cursor-agent` in the agent account's `.local/bin` or `/usr/local/bin`, with an existing `.cursor` home. Use `harness: "cursor"` in the API; the GUI provider remains `acp-cursor`. No new Cloudroom service environment variables are required. After upgrading core and the GUI, use **Settings → Cloudroom → Cursor → Manage connection**, or `room-cli cloud cursor login --request-id ID` followed by `room-cli cloud cursor status`. Browser login runs on the VM, with `NO_OPEN_BROWSER=1` confined to the Cursor login child. Credentials stay in the shared native account home.

The authenticated account API exposes `GET /v1/accounts/cursor` and `POST /v1/accounts/cursor/{login,cancel,key}`. Mutations use `{ "request_id": "ID" }`; `/key` additionally takes `api_key`. Mutations return HTTP 202. An active login is reused, cancellation targets its request ID, and missing authentication rejects session creation before acceptance. Keys are verified with `--list-models` (`status` ignores API keys), saved privately as `.cursor/cloudroom-api-key`, and supplied through `CURSOR_API_KEY` only to Cursor children. The GUI clears its password field after submission; CLI key input uses `room-cli cloud cursor key` through stdin, never a key argument. Neither login links nor keys enter conversation records or sync. Close live Cursor sessions before changing their login.

Cursor runs in print mode. Cursor's ACP mode only runs each model at its default reasoning, so the core's built-in driver (`src/runtime/cursor_print.rs`) speaks the small ACP subset the adapter uses and runs one `cursor-agent -p --output-format stream-json --resume CHAT --model VARIANT` per prompt. It shares the process driver, durable queue and history. Steering and Stop end the running prompt, including its shell tools, and the chat resumes with the next message. Prompt dispatch is not completion.

`cursor_models.rs` groups `--list-models` into model families with reasoning levels, named like the GUI picker (`auto` is `default`; the `cursor-` prefix is dropped). Capabilities advertise them, and launch resolves the family and level to the exact variant, e.g. `gpt-5.6-sol` + `xhigh` → `gpt-5.6-sol-xhigh`. Reasoning remains fixed for a session. Fast is per turn, like Codex: a `fast` service tier runs the variant's `-fast` twin when Cursor offers one, otherwise the normal variant. Images are sent as file paths, which Cursor's headless mode documents for images; its agent opens them with its read tool (tested live with seven models). Manual compaction, rewind, independent subagent controls and context-only notices are not advertised.

Cursor runs without Command Guard: its tested versions do not run native safety hooks for Cloudroom, so `command_guard_enabled` has no effect on Cursor sessions.

Chats live at `.cursor/chats/<md5 of the working folder>/<chat ID>`. The adapter records bounded native SQLite snapshot chunks, including metadata and WAL-backed data. The Python helper uses SQLite backup with query-only SQL; read/write opening permits required WAL sidecars after Cursor exits. `cursor-history.py restore ROOT CWD` accepts one complete snapshot's native JSONL on stdin, checks its digest, writes it under `ROOT/<md5 of CWD>`, and never replaces an existing session. It restores native history, not workspace files or credentials.

Initial sync discovery includes Cursor skills, global rules and the `notifications`, `hints`, and `suggestNextPrompt` preferences. Existing paired roots are preserved. Credentials, session stores, hooks, plugins and MCP configuration do not sync.

## OpenCode

Core discovers `opencode` in the agent account's `.local/bin` or `/usr/local/bin`, with an existing `.local/share/opencode` data folder, and runs `opencode acp` through the shared ACP adapter. Use `harness: "opencode"` in the API; the GUI provider is `acp-opencode`. No Cloudroom service variables are needed. OpenCode 1 (npm `opencode-ai`) and OpenCode 2 (npm `@opencode/cli`) both work; both install `opencode`. OpenCode 2's `acp` starts a private server child, which Core's workload containment stops with the harness. Core sets `OPENCODE_CONFIG_CONTENT` to turn off the question tool (it ends OpenCode 2 turns over ACP) and auto-update.

Models are OpenCode's `provider/model` values. Launch selects the model, then the reasoning effort the same way Local threads do (`low` falls back to `minimal`, `max` to `xhigh`); a model without that effort keeps OpenCode's default. Reasoning stays fixed for the session. Sessions live in OpenCode's `opencode.db`; resume uses ACP `session/load`. Images are sent as file paths. Compaction, rewind, Fast, subagents and context-only notices are not advertised.

Sign in with `opencode auth login` as the agent account. OpenCode 1 keeps logins in `.local/share/opencode/auth.json`; OpenCode 2 keeps them in `opencode.db` and moves them with `opencode auth export` and `opencode auth import`. Cloudroom's hosted sandboxes copy the user's Mac logins either way. Free `opencode/*` models need no login. Tested on Linux with OpenCode 1.18.34 and 2.0.22: start, effort selection, a shell tool call, a question prompt, and resume after a Core restart.

## OpenClaw

`openclaw acp` only bridges to OpenClaw's Gateway, which runs the agent and keeps its sessions. Core discovers `openclaw` in the agent account's `.openclaw/bin`, `.local/bin`, or `/usr/local/bin`, with an existing `.openclaw` folder. Use `harness: "openclaw"` in the API; the GUI provider is `acp-openclaw`. No Cloudroom service variables are needed. The Gateway needs Node 24.16+ or 26.1+; the sandbox image gives OpenClaw its own Node 24.

The first OpenClaw session starts one Gateway as a contained, disk-guarded writer: loopback only, a port and token from Core (`OPENCLAW_GATEWAY_PORT`, `OPENCLAW_GATEWAY_TOKEN`; nothing is written to OpenClaw's config), chat apps off, no update checks. Later sessions share it; Core stops it on shutdown. A cold Gateway takes about 15 s and about 1.3 GB of memory. Before each turn Core restarts a Gateway that stopped (a sandbox stops it before sleeping) or whose Cloud environment changed, unless another OpenClaw turn is running. It keeps the port and token, and waits for the session's bridge to reconnect, which takes about 10 s. Commands that OpenClaw's tools run (`room-cli thread`, `room-cli secret`) come from the Gateway's processes, so Core gives them to the OpenClaw session running a turn, or with several, to the one whose folder they run in.

Each new session is created first with `openclaw gateway call sessions.create`: key `agent:main:cloudroom-<uuid>`, the cloud folder as its working directory, full permissions (ADR 0045), and the chosen model and effort (`none` is OpenClaw's `off`; a model without that effort keeps its default). ACP then opens it with `session/resume` by that key, which is also the native ID, so resume never replays history. The folder's `AGENTS.md` loads as project context. Models are OpenClaw's `provider/model`. A new message cancels the running turn and resends. A session whose model resolves to a Claude plan (`claude-cli`) is deleted and refused (ADR 0265). OpenClaw ends a turn whose model has no login without a word, so Core fails it with a login hint. Compaction, rewind, Fast, subagents, context-only notices, and Command Guard are not advertised.

Hosted sandboxes copy the Mac's OpenClaw sign-ins and API keys (its state databases and `.env`) and its default model and providers, never Claude plans or plan tokens (ADR 0265). Before sleep the sandbox stops the Gateway and wipes every copy: both databases, `models.json`, and the Codex runtime's login. Memory, persona, and chat apps stay on the Mac. Tested on Linux with OpenClaw 2026.10.3 and a fake model: start, a tool call in the cloud folder, steer, interrupt, restart and resume, a tool's `room-cli` call, recovery after the Gateway stopped, a changed Cloud environment, an imported API key, and the no-login failure.

## Queue, completion and recovery

There is one durable Cloudroom queue. Pi's memory-only steering/follow-up queue is not used for that backlog. RPC acknowledgement means acceptance, not completion. Pi requests settle only after its full run, including internal retries and compaction; an additional state check guards premature settled signals. Handled extension commands with no agent run are reconciled separately. Interrupt intent is correlated to the active request even when Pi aborts inside a tool without emitting a new assistant message. Interrupt clears Pi's internal continuations first, but preserves Cloudroom's durable future requests.

New Pi sessions use an exclusively created empty file that Pi initializes itself. Startup confirms its header and syncs it before admitting prompts. Resume checks exact identity, workspace, model/provider and supported session version; it never creates a missing file or silently migrates/replaces a conversation. Pi capture resumes by entry ID and the exact recorded boundary, rather than treating a persisted Codex byte offset as portable. Missing/corrupt native history leaves Cloudroom history readable and fails that session's recovery, not unrelated sessions. Uncertain dispatched work is never resent.

A process-generation check rejects old replies/events, and targeted controls are checked again at dispatch. Existing workload reconciliation, bounded recovery and storage gating apply to both adapters.

## Notices, dialogs and shutdown

The Pi adapter supplies one small, bundled extension for context-only notices. It uses Pi's public extension API and never implements a queue or agent loop. `storage_warning_delivery.confirmed` means accepted by the harness, not that the model has consumed it. During active tools, Pi can defer insertion to a safe turn boundary. Kernel disk enforcement does not depend on model cooperation.

Interactive extension dialogs are currently unsupported: the adapter records cancellation and responds `cancelled: true`, never approval. The capability is explicit. Terminal-only extensions do not become remote UI automatically. Images, steering, model-changing commands and arbitrary native RPC forwarding are not added to the HTTP API by this slice.

Pi close clears native queues, cancels direct bash and active work, waits for acknowledgements, then closes stdin and captures remaining history. Both adapters share the bounded escalation and cgroup cleanup path. Forced/uncertain exits are not reported as clean closes. Linux containment, not Unix process groups alone, covers detached descendants. Unprotected test mode provides no descendant-containment guarantee.

## Verify

```sh
cargo fmt --check
CARGO_BUILD_JOBS=1 cargo clippy --locked --all-targets -- -D warnings
CARGO_BUILD_JOBS=1 cargo test --locked --all-targets
CARGO_BUILD_JOBS=1 cargo build --locked
python3 tests/core_fixture.py
python3 tests/pi_http.py
python3 tests/cursor_http.py # uses tests/fake_api.py for start-gating checks
python3 tests/pi_e2e.py
# Disposable Linux + configured native credentials (tests/fake_api.py stands in for the website):
python3 tests/core_e2e.py --fixture
python3 tests/core_e2e.py
python3 tests/core_e2e.py --harness pi
# Prepared disposable Linux VM and test accounts only:
sudo python3 tests/storage_e2e.py --disposable --mixed
```

`pi_e2e.py` uses disposable files, the real Pi CLI and existing valid account credentials. It tests HTTP execution, interruption, queued continuation, native recording and restart with the database unavailable. It refuses near-expired copied OAuth credentials instead of refreshing them behind the user's back. Linux cgroup/disk enforcement and real PostgreSQL upload require their separate Linux tests; a local pass does not establish deployment readiness. No schema migration is introduced by the adapter change.
