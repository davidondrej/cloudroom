# Thread, project, environment, and machine creation

For Cloud, use `room-cli thread spawn --project PROJECT --machine cloud --provider codex --model MODEL --request-id UNIQUE_ID --prompt "Task"` (or `--provider claude-code`/`pi`). Cloud requires `--provider` and `--model`; it never picks a provider for you. Reuse the request ID after an unconfirmed submission. `--parent-thread` with a Cloud parent starts a linked child in the parent's sandbox and folder; Core messages the parent when it finishes. A Local parent's Cloud child gets its own sandbox and the app messages the parent when it finishes. It starts from GitHub, not local files: push first and pass `--base-branch BRANCH`. Native-machine/worktree options and scheduling are not enabled; fork with `room-cli thread fork --machine cloud`. Attachment support depends on the connected core/harness; inspect `room-cli cloud status --json` and verify the agent reads the file. The native environment workflows below apply to Local threads.

## Spawning Threads

- In the Cloudroom fork, `--machine cloud --provider codex --model MODEL` uses
  the configured Rust core and prepared repository. `--machine local` selects
  the local machine. Cloud creation accepts `--request-id ID`; reuse it after
  an unconfirmed submission. Cloud uses full permissions, not native environment
  options or forks. Attachments and fast service tier require the corresponding
  connected-core/harness capability.

- Use `room-cli thread spawn --project <project-id> --prompt "..."` to create another
  thread. Pass the intended project explicitly; the CLI does not infer it from
  context variables. Omitted execution flags use remembered project defaults;
  without a remembered model, cloudroom resolves the selected provider and its reported
  default model on the target machine.
- Select a target with `--environment`, `--new-environment`, `--base-branch`,
  or `--machine`. Select execution with `--provider`, `--model`,
  `--reasoning-level`, `--service-tier`, and `--permission-mode`.
- List plugin-provisioned environment choices with `room-cli environment providers`. Add `--project <id>` and optionally `--machine <id>` to omit providers whose declared requirements are unmet. Without a machine, the project listing includes providers structurally eligible on any persistent machine. Git inspection and plugin availability run only for the selected provider and machine during thread creation. `--json` includes each provider's `description` and `icon`, its `requires` facts and its `inputs` JSON Schema or null.
  Pass the selected ID to `--environment-provider`. Add
  `--environment-inputs <json>` only when the provider's schema does not accept
  an empty object; otherwise the CLI supplies `{}` when the flag is omitted.
  `--machine` picks the existing machine.
- List machine providers with `room-cli machine providers`. Create a
  new provider machine with
  `room-cli thread spawn --new-machine <provider-id> --environment-provider <id>`.
  For Modal's composed environment, use `--environment-provider modal-sandbox`
  without machine selectors; `--machine-inputs <json>` configures that composed
  machine with optional configured names such as
  `{"preset":"Large","image":"Node 22"}`. These inputs are persisted and
  readable by plugins, so keep credentials in plugin settings and send only
  non-secret configuration or references.
- Omit `--base-branch` for Cloudroom's default. Explicit values are exact; use
  `origin/<branch>` for a remote ref. It applies to `--new-environment
worktree` only; a provider takes its branch through `--environment-inputs`.
- Spawn also accepts `--title`, `--origin-kind`, `--source-thread`,
  `--source-seq-end`, `--agent-context-seed`, and `--json`.
- Add repeatable `--file <path>` / `--image <path>` flags for structured prompt
  attachments, and `--section <id>` to add the new thread to a section.
  Both flags upload absolute paths and `file:` URLs from the CLI machine
  before sending and pass relative server-upload tokens through unchanged.
  Use an absolute path (for example, `--file "$PWD/report.pdf"`) for local files.
- Spawn creates a root thread unless you pass `--parent-thread`.
- To move a thread to another agent or model in place, use `room-cli thread update
  THREAD --provider PROVIDER --model MODEL` (ADR 0211). The next turn carries the
  conversation so far.
- Use `room-cli thread fork <source-thread-id>` to clone a provider session. The
  fork inherits the source conversation in its timeline. It creates an idle
  fork in the source environment by default; add `--prompt`, select an existing
  environment with `--environment`, or create a fresh personal workspace or
  worktree with `--new-environment personal|worktree`. `--base-branch` matches
  spawn for worktrees. `--machine local|cloud` forks across sides (Claude Code
  and Codex): the default is the source's side, or Local when environment flags
  are set. A Cloud fork gets its own sandbox with the source's code; a Local
  fork of a Cloud thread copies its conversation and code to this Mac. To fork
  into another harness, Local or Cloud, use `room-cli thread spawn --origin-kind
  fork --source-thread ID --provider P --model M --prompt TEXT`; it gets the
  conversation as hidden text instead of a native fork. A Cloud agent forks its
  own thread with Core's `room-cli thread fork`, into Cloud only. Anchor with
  `--source-seq-end` on a completed source turn (the clone and inherited
  timeline both end with the turn containing that sequence). Permission mode
  inherits the source thread unless explicitly overridden.
- Pass `--visibility hidden` for background/plugin workers that should remain
  out of sidebar organization without contributing unread/pending favicon
  attention. `room-cli thread list` excludes them by
  default; pass `--include-hidden` when a hidden worker must be discovered.
  Direct-ID lifecycle and messaging operations remain available. A root thread
  is visible by default; a child thread inherits its parent's visibility, so a
  hidden thread's subagents are hidden too. Pass `--visibility` to override the
  inherited value. A hidden child still reports its turns and blockers to its
  parent thread; only forks and side chats stay silent. Promote or hide an
  existing thread with `room-cli thread update <id> --visibility visible|hidden`.
- Stop a finished hidden worker with `room-cli thread stop <id>` to release its agent
  runtime promptly. Archive it first when it no longer belongs in active thread
  lists. Stop preserves the thread and supports a later resume.
- Add remote execution machines from Settings → Machines. Its one-line
  installer stores the machine's Cloudroom Connect credential locally and configures
  both the daemon protocol and agent-launched `room-cli` CLI to reach this Mac
  through cloudroom.run; removing the machine revokes it. It uses
  the server's exact `/install/bb-app.tgz` artifact and never falls back to npm. It installs under the enrollment's cloudroom data directory, without
  `sudo` or a global npm configuration, and enables daemon `--auto-update`.
  Newer protocol mismatches update that private install with a persisted
  exponential retry backoff from 5 seconds to 5 minutes, then let
  launchd/systemd restart the daemon. Auto-update never downgrades. To bypass a
  transient backoff, use `room-cli machine retry-update <id-or-name>`. Remove
  `--auto-update` from the service definition and reload it to opt out.
- Run `room-cli machine list` to see machine names, IDs, type, connection status, and
  last seen time (`--json` returns the raw host list). It shows persistent
  machines; pass `--all` to include the disposable sandboxes environment
  providers create per thread. Use `--machine <id-or-name>`
  (alias `--host`) on `room-cli thread spawn` to run in a personal or unmanaged
  workspace, or combine it with `--new-environment worktree`. Do not combine a
  machine selector with an existing environment ID, which already owns its
  machine.
- Each machine carries a permission limit (`maxPermissionMode`, default
  `full`): the highest permission mode a thread on that machine may run with.
  The server resolves any higher request down to it, and refuses a provider
  that supports no mode under it. Only the owner can change it, on the machine
  page at Settings → Machines → the machine — there is no CLI, SDK, or API
  surface that sets it, and machine credentials are refused — so read it from
  `room-cli machine list --json` or `room-cli machine show` and ask the user to change it
  in the app.
- `room-cli machine providers`, `show`, `join-code`, `rename`, `retry-update`,
  `suspend`, `resume`, `retry-cleanup`, and `remove` cover the Settings →
  Machines lifecycle. Use `room-cli machine provider-cli status|install` to inspect
  or install provider CLIs on a selected machine.
- `room-cli updates` runs the default `room-cli updates status` action. It aggregates Cloudroom and provider
  CLI update state across every machine — the CLI counterpart of Settings →
  Updates. `room-cli updates apply [--machine <id-or-name>]` runs every available
  provider CLI install/update sequentially; update bb-app itself with the
  printed upgrade command or the desktop relaunch.
- Use `room-cli project create --name <name> --root <path> --machine <id-or-name>`
  to bind a new project's local path to a connected enrolled machine. Use
  `--host` as an alias. Without a selector, the CLI asks its local host daemon.
- `room-cli project list` preserves the ordinary-project-only default. Pass
  `--include-personal` when the singleton personal project must be discoverable.
- Use `room-cli project source add <project-id> --machine <id-or-name> --path <path>`
  to register a path on another connected machine. It uses the same selector
  resolution and fallback as project create. Use `--clone` instead of `--path`
  to clone the project's remote there; `--remote-url` and `--target-path` are
  optional clone overrides.
- `room-cli project paths|files|content|commands` accept `--machine <id-or-name>`
  (`--host` alias) or `--environment <id>`, but not both. An environment uses
  its owning machine and workspace; an explicit machine uses that machine's
  project source; omitting both intentionally uses the primary machine source.
  `room-cli project content --json` returns UTF-8 text or base64 binary content with
  an explicit `contentEncoding`.
  Project/environment file and path searches honor Git ignore rules, retaining
  tracked and non-ignored untracked files, including hidden files. Non-Git
  workspaces use filesystem listing. `room-cli file list|paths` can inspect ignored
  files, subject to their exclusion options.
- Use `room-cli project attachment upload <project-id> --client-file <path>` when the
  bytes live on the CLI machine, including when the CLI and cloudroom server are on
  different hosts. It reads locally and sends multipart bytes through the
  configured `ROOM_SERVER_URL` (and its enrolled-machine authentication proxy),
  returning the stable server attachment DTO. Optional `--filename` and
  `--mime-type` override inferred metadata. Thread `--file` and `--image` perform this
  upload automatically for absolute paths and `file:` URLs; use the explicit
  command when a reusable attachment token is needed. Image MIME types are
  capped at 10MB and other files at 25MB, and image/heic or image/heif uploads
  become JPEG on macOS (rejected elsewhere). `room-cli project attachment
download <project-id> <attachment-path> --client-file <path>` writes existing
  attachment bytes on the CLI machine. There is no project-attachment list or
  per-file remove API.
- `room-cli project history|reorder` exposes project prompt recall and sidebar order.
- Use `room-cli project show|update|delete` for one project. Use `room-cli project source
update|delete` for one source. Use `room-cli project branches` for branch data.
- Direct environment inspection accepts any environment ID: use `room-cli environment
status|branches|paths|diff|diff-files|diff-file|diff-patch <id>` and `bb
environment pull-request show <id>`. Diff commands require an explicit target
  and the matching merge-base or commit flags; all support `--json`.
- `room-cli environment pull-request ready|draft|merge` manages pull-request state;
  `room-cli environment archive-threads` bulk-archives an environment's threads.
- Use `room-cli environment show|update|commit` for environment metadata
  and Git changes. Check live help before a commit or merge.
- Spawned child threads inherit permission from explicit flags, then the
  parent thread's last execution, then project defaults. The parent's mode is
  a hard ceiling: an explicit flag can lower it but never exceed it.
- Public permission modes are `accept-edits`, `auto`, and `full`.
  `accept-edits` keeps workspace sandboxing and asks the user to review
  escalations. `auto` keeps the same workspace sandbox while using the
  provider's automatic reviewer. `full` explicitly bypasses sandbox and
  approval protections. Plan mode remains separate. The product default is
  `auto` when no inherited or project default applies.
- Subagents inherit the parent's permission mode by default;
  `--permission-mode full` only takes effect when the parent itself runs full.
- Use `--parent-self` inside a thread to parent the new thread to the current
  thread.
- Use `--parent-thread <thread-id>` to choose another specific parent.
- A parent can live in a different project. Pass `--project <other-id>` with
  `--parent-self` to delegate work in another repository; the child still
  reports back to its parent and stays under its parent's permission ceiling.
- If provider or model choice matters, inspect options with `room-cli provider list`
  and `room-cli provider models <provider-id>`. Both accept `--machine <id-or-name>`
  (alias `--host`) or `--environment <id>` to inspect the machine where work
  will run; the selectors cannot be combined. With neither selector they
  intentionally inspect the primary machine. Model lists answer from the
  machine's last stored list while a background refresh runs, so a list can be
  hours old. A provider whose refresh keeps failing or timing out keeps
  answering from its last stored list. Check `room-cli machine provider-cli status MACHINE
--json` for installed executables. Installed does not mean authenticated; a Claude
  login error requires the user to run `claude` and `/login`.
- If Cursor's model list fails, Codex's looks stale after a CLI upgrade, or
  Pi's after a `models.json` edit,
  `room-cli provider models acp-cursor --restart` (or `codex`/`pi --restart`)
  restarts model discovery and reloads the list on the selected machine. It
  does not stop threads, reinstall the CLI, or change credentials.
- Top-level `customModels` in the same `config.json` registers extra picker
  models. Use a provider ID returned by the target host's catalog. Acceptance
  of unlisted models is provider-specific; consult that provider's skill.
  This list has no set/unset CLI surface. Edit the JSON and restart Cloudroom.
  The `streamerMode` General preference hides every entry from model lists.
- Top-level `sharedSkillRoots` uses the same relative `user` and `project`
  paths. cloudroom lists these skills as read-only. cloudroom injects them into each provider,
  so one physical skill collection can support Cloudroom and standalone provider CLIs.

Give spawned threads clear prompts: objective, constraints, expected deliverable,
validation to perform, and what to report back. Ask for outcome, changed files
or artifacts, validation performed, and blockers.

`room-cli environment show <id>` includes the core-owned lifecycle phase, retirement deadline, and teardown status/attempt/message. Archive or delete the last live thread to begin its provider's retirement grace; unarchive cancels pending retirement. Teardown failures retry automatically. Checkout policy keeps its directory indefinitely.

### Standalone machine creation

`room-cli machine create --provider <id> [--key <idempotency-key>] [--inputs <JSON>]
[--no-wait] [--json]` creates a machine without a thread. Omitted
inputs are null and must satisfy the provider schema; omitted key is generated
by the server. Supply a stable key to recover the same creation across retries.
Creation is durable. `--no-wait` returns the host ID; `room-cli machine show
<host-id>` inspects it and `room-cli machine remove <host-id>` cancels it. SIGINT
stops following and exits with status 130 while creation continues.

`room-cli machine show <id-or-name> --json` includes `providerDetails` inventory and
estimates when available. Suspend requires idle threads and no open terminals;
empty machines use the provider’s opt-in idle timeout. Resume waits for pending
suspension and leaves an already-active machine active.

### Local machine lifecycle

`install-machine.sh --start|--stop|--uninstall --host-id <id>` operates on that machine's local
installation. Optional `--server-url` and `--data-dir` assert its identity and
installation location; the installer's BB_DATA_DIR is also an assertion, never permission to
remove another installation. Uninstall checks ownership before stopping its
service, releasing its port reservation and deleting its private files.

### Private machine enrollment

Use `room-cli machine enroll --bootstrap-file <path>` or `--bootstrap-env <NAME>` on a machine that already has the CLI. Core prepares the versioned bundle; transport it through a private file or environment/stdin, never command arguments, logs, resource JSON, or a transcript. Enrollment refuses a different existing host/server identity and succeeds without another exchange when the same identity is already enrolled. The installer accepts `--bootstrap-env <NAME>` and invokes this command after installing bb. Machine state defaults to `~/.bb-machines/<server-host>`; an explicit `ROOM_DATA_DIR` must be isolated from the default BB instance. For remote non-login commands, discover `room-cli` on PATH and fall back to `~/.local/bin/cloudroom`.

Delivered enrollment bundles from v1 remain valid until their expiry. The CLI accepts both file and environment forms, upgrades the bundle to v2 headers locally, and persists legacy Connect redemption before enrollment so a retry reuses it. The installer upgrades v1 environment bundles before authenticated artifact downloads.

The core `manual` provider appears as Manual machine setup. `room-cli machine create --provider manual` waits for the enrollment command to become ready, prints it once, and follows; `--no-wait` returns the creating host ID. Commands are no longer available after enrollment or removal. Manual machines never suspend or retire automatically. Removal revokes access; run the original installer with `--uninstall --host-id <id>` on the target using its original data directory.

For paths a provider owns, cloudroom runs `.bb-env-setup.sh` after create and
`.bb-env-teardown.sh` before remove on that machine, with separate 15-minute
timeouts. Setup failure fails the launch with output in provisioning progress;
teardown script failure is logged and removal continues. Attaching a user-maintained project checkout or personal workspace skips both
hooks. A fresh core clone on a new machine is owned and runs the hooks. Providers do not run these
core hooks themselves.
Thread startup does not validate agent credentials, fingerprint the checkout, or install agent CLIs.

`room-cli machine list --json` includes lifecycle phase, progress, and any suspension or resume error.
Maintenance interrupts active turns and closes terminals before saving. Submit a
new continuation turn after restore; interrupted turns are never reported successful.

Resuming a machine restores its provider state without rerunning environment setup.

Personal file access: `room-cli project paths|files|content proj_personal` requires
an explicit `--environment <id>` belonging to Personal. Personal has no default
project source; the selected environment must be ready.
