# Core command index

This index lists every command path that the core CLI registers. Read the task-specific reference before you use a command. Check live help for flags and defaults.

## cloud

- `room-cli cloud`
- `room-cli cloud status`
- `room-cli cloud check`
- `room-cli cloud sign-in`
- `room-cli cloud cancel`
- `room-cli cloud logout`
- `room-cli cloud codex`
- `room-cli cloud codex status`
- `room-cli cloud codex login`
- `room-cli cloud codex cancel`
- `room-cli cloud github`
- `room-cli cloud github status`
- `room-cli cloud github login`
- `room-cli cloud github cancel`
- `room-cli cloud cursor`
- `room-cli cloud cursor status`
- `room-cli cloud cursor login`
- `room-cli cloud cursor cancel`
- `room-cli cloud cursor key`
- `room-cli cloud pi`
- `room-cli cloud pi key`
- `room-cli cloud teleport THREAD [--check|--wait [--timeout SECONDS]|--status|--cancel|--to-local]`
- `room-cli cloud retry-start`
- `room-cli cloud thread-workspace`
- `room-cli cloud share THREAD [--status|--stop]`
- `room-cli cloud env list|set NAME|unset NAME`
- `room-cli cloud repo add|remove OWNER/NAME`
- `room-cli cloud setup set`
- `room-cli cloud auto-delete [30|90|180|365|never]`

`sign-in --project ID` prints the browser link for connecting the account's existing VM. `--website-url http://127.0.0.1:PORT` is for local website development. All commands accept `--json`. Logout removes this app's VM credentials, not remote jobs or local history. Existing cloud bindings block switching to another account/core. `retry-start` retries a rejected launch with its saved prompt and original request ID; it never reruns an existing cloud session.

`cloud env`, `repo`, and `setup` change Settings → Cloud environment for every new cloud sandbox. `env set NAME` and `setup set` read the value from stdin, never an argument; `env list` shows key names and the last 4 characters of long values, never the values. `auto-delete` shows or sets Settings → Auto-delete; `never` keeps unused cloud threads forever. Before installing a tool with `setup set`, read https://www.cloudroom.dev/docs/cloud-environment.md: tools must land on the agents' PATH, and `setup set` replaces the whole script, so keep its old lines.

`thread-workspace` reads the thread's live cloud directory, branch, and commit. An unavailable core never falls back to the local checkout.

## vm

- `room-cli vm`
- `room-cli vm run`
- `room-cli vm pull`
- `room-cli vm push`

`room-cli vm run 'COMMAND' [--thread ID] [--cwd DIR] [--stdin]`, `vm pull VM_PATH [LOCAL_PATH] [--thread ID]`, and `vm push LOCAL_PATH [VM_PATH] [--thread ID]` run commands and copy files as the agent account, in the agent home by default. `--thread ID` targets that Cloud thread's sandbox and wakes it; subagent threads share their parent's. Without it, they target the signed-in VM, and accounts without a VM must pass `--thread`. Find a thread's repository folder with `room-cli cloud thread-workspace ID`. `run` exits with the command's code. Copies are tar archives and follow `cp`: an existing folder or a path ending in `/` gets the copy inside it; any other path is its new name and must not exist yet; unlike `cp`, a `.` source copied into a folder lands as a subfolder named after it. Push sends big ones in pieces; pull is limited to 16 MiB compressed. `~` means the VM agent home.

## import

- `room-cli import`
- `room-cli import bb`
- `room-cli import claude-code [--days N] [--dry-run] [--json]`
- `room-cli import codex [--days N] [--dry-run] [--json]`
- `room-cli import pi [--days N] [--dry-run] [--json]`
- `room-cli import hermes [--days N] [--dry-run] [--json]`
- `room-cli import t3code [--days N] [--dry-run] [--json]`
- `room-cli import share LINK [--json]`

`import bb` copies every open BB thread into an idle Local thread with its full history, title, harness, and model. It forks each native session, so it sends no prompts and never changes BB. Re-running skips threads already imported.

`import claude-code`, `import codex`, `import pi`, `import hermes`, and `import t3code` copy this Mac's chats from the last N days (default 30) into idle Local threads. Each forks the native session on its first new message, so the agent keeps its memory; Hermes chats come over as text instead, as hidden context for a fresh session. T3 Code chats keep T3's titles; its Claude Code and Codex chats fork, and chats from other agents come over as text. The timeline shows user and agent messages. Cloudroom's own sessions, subagents, and already-imported chats are skipped. `--dry-run` lists them without importing. The same picker is in Settings → Import chats.

`cloud share` makes a read-only `cloudroom.dev/s/...` link to a thread's messages (no tool output or files, secrets removed), or updates its copy; `--stop` deletes it. `import share` copies a shared thread into a new Local thread whose agent starts by reading it.

## feedback

- `room-cli feedback`
- `room-cli report`

`room-cli feedback "MESSAGE"` sends David, Cloudroom's founder, a bug, friction, or idea (ADR 0158): what you did, what happened, and the exact error. Never include secrets, personal data, or the user's code. The app adds its version, OS, and thread details. It prints `{"sent":false}` while Settings → Send agent feedback is off. `room-cli report` is the old name and still works. It works the same in Cloud threads.

## status

- `room-cli status`

## settings

- `room-cli settings`
- `room-cli settings show`
- `room-cli settings ai-services`
- `room-cli settings general`
- `room-cli settings completed-turns`
- `room-cli settings experiment`
- `room-cli settings keyboard`
- `room-cli settings keyboard hints`
- `room-cli settings keyboard list`
- `room-cli settings keyboard set`
- `room-cli settings keyboard reset`
- `room-cli settings ui`
- `room-cli settings ui list`
- `room-cli settings ui get`
- `room-cli settings ui set`
- `room-cli settings ui reset`
- `room-cli settings usage`
- `room-cli settings version`
- `room-cli settings reload`

## project

- `room-cli project`
- `room-cli project source`
- `room-cli project source add`
- `room-cli project source update`
- `room-cli project source delete`
- `room-cli project attachment`
- `room-cli project attachment upload`
- `room-cli project attachment download`
- `room-cli project list`
- `room-cli project history`
- `room-cli project reorder`
- `room-cli project branches`
- `room-cli project paths`
- `room-cli project commands`
- `room-cli project files`
- `room-cli project content`
- `room-cli project create`
- `room-cli project show`
- `room-cli project update`
- `room-cli project delete`

`room-cli project show <id>` accepts `proj_personal` to inspect Personal.

## provider

- `room-cli provider`
- `room-cli provider list`
- `room-cli provider models`

## manager

- `room-cli manager`
- `room-cli manager hire`
- `room-cli manager list`
- `room-cli manager status`
- `room-cli manager delete`

## machine

- `room-cli machine`
- `room-cli machine providers`
- `room-cli machine enroll`
- `room-cli machine env`
- `room-cli machine env list`
- `room-cli machine env set`
- `room-cli machine env unset`
- `room-cli machine create`
- `room-cli machine list`
- `room-cli machine show`
- `room-cli machine join-code`
- `room-cli machine rename`
- `room-cli machine remove`
- `room-cli machine suspend`
- `room-cli machine resume`
- `room-cli machine reconcile`
- `room-cli machine retry-cleanup`
- `room-cli machine retry-update`
- `room-cli machine provider-cli`
- `room-cli machine provider-cli status`
- `room-cli machine provider-cli install`

`room-cli thread spawn --new-machine <provider-id>` creates a machine for a new
environment and requires `--environment-provider <id>`. For a composed option,
use `--environment-provider modal-sandbox` alone. `--machine-inputs <json>`
configures the machine with optional configured `preset` and `image` names;
`--environment-inputs <json>` configures the workspace. Neither carries secrets.

## updates

- `room-cli updates`
- `room-cli updates status`
- `room-cli updates apply`

## terminal

- `room-cli terminal`
- `room-cli terminal list`
- `room-cli terminal create`
- `room-cli terminal start`
- `room-cli terminal show`
- `room-cli terminal attach`
- `room-cli terminal send`
- `room-cli terminal resize`
- `room-cli terminal output`
- `room-cli terminal wait`
- `room-cli terminal rename`
- `room-cli terminal restart`
- `room-cli terminal close`
- `room-cli terminal stop`

## thread

- `room-cli thread`
- `room-cli thread wait`
- `room-cli thread spawn`
- `room-cli thread fork`
- `room-cli thread list`
- `room-cli thread show`
- `room-cli thread log`
- `room-cli thread output`
- `room-cli thread open`
- `room-cli thread pane`
- `room-cli thread section`
- `room-cli thread section list`
- `room-cli thread section create`
- `room-cli thread section rename`
- `room-cli thread section delete`
- `room-cli thread search`
- `room-cli thread history`
- `room-cli thread read`
- `room-cli thread unread`
- `room-cli thread reorder-pinned`
- `room-cli thread count`
- `room-cli thread queue`
- `room-cli thread queue list`
- `room-cli thread queue create`
- `room-cli thread queue update`
- `room-cli thread queue send`
- `room-cli thread queue delete`
- `room-cli thread queue reorder`
- `room-cli thread tabs`
- `room-cli thread tabs show`
- `room-cli thread tabs set`
- `room-cli thread update`
- `room-cli thread move`
- `room-cli thread archive`
- `room-cli thread unarchive`
- `room-cli thread pin`
- `room-cli thread unpin`
- `room-cli thread delete`
- `room-cli thread edit-message`
- `room-cli thread tell`
- `room-cli thread chat`
- `room-cli thread retry`
- `room-cli thread stop`
- `room-cli thread compact`
- `room-cli thread context`
- `room-cli thread clear`
- `room-cli thread cancel-plan`
- `room-cli thread clear-goal`
- `room-cli thread pause-goal`
- `room-cli thread resume-goal`
- `room-cli thread set-goal`
- `room-cli thread interactions`
- `room-cli thread interactions list`
- `room-cli thread interactions show`
- `room-cli thread interactions approve`
- `room-cli thread interactions grant`
- `room-cli thread interactions answer`
- `room-cli thread interactions respond`
- `room-cli thread interactions deny`

## environment

- `room-cli environment`
- `room-cli environment providers`
- `room-cli environment list`
- `room-cli environment delete`
- `room-cli environment show`
- `room-cli environment status`
- `room-cli environment branches`
- `room-cli environment paths`
- `room-cli environment diff`
- `room-cli environment diff-files`
- `room-cli environment diff-file`
- `room-cli environment diff-patch`
- `room-cli environment update`
- `room-cli environment commit`
- `room-cli environment archive-threads`
- `room-cli environment pull-request`
- `room-cli environment pull-request show`
- `room-cli environment pull-request ready`
- `room-cli environment pull-request draft`
- `room-cli environment pull-request merge`

## file

- `room-cli file`
- `room-cli file read`
- `room-cli file write`
- `room-cli file list`
- `room-cli file paths`
- `room-cli file mkdir`
- `room-cli file move`
- `room-cli file remove`

## theme

- `room-cli theme`
- `room-cli theme list`
- `room-cli theme set`
- `room-cli theme dir`
- `room-cli theme favicon`
- `room-cli theme favicon set`
- `room-cli theme favicon reset`
- `room-cli theme show`
- `room-cli theme reset`

## plugin

- `room-cli plugin`
- `room-cli plugin search`
- `room-cli plugin list`
- `room-cli plugin source`
- `room-cli plugin install`
- `room-cli plugin outdated`
- `room-cli plugin update`
- `room-cli plugin new`
- `room-cli plugin types`
- `room-cli plugin migrate`
- `room-cli plugin build`
- `room-cli plugin dev`
- `room-cli plugin reload`
- `room-cli plugin rpc`
- `room-cli plugin rpc list`
- `room-cli plugin rpc inspect`
- `room-cli plugin rpc call`
- `room-cli plugin enable`
- `room-cli plugin disable`
- `room-cli plugin safe-mode`
- `room-cli plugin config`
- `room-cli plugin token`
- `room-cli plugin run`
- `room-cli plugin logs`
- `room-cli plugin remove`

## marketplace

- `room-cli marketplace`
- `room-cli marketplace add`
- `room-cli marketplace list`
- `room-cli marketplace refresh`
- `room-cli marketplace remove`

## skill

- `room-cli skill`
- `room-cli skill list`
- `room-cli skill show`
- `room-cli skill files`
- `room-cli skill update`
- `room-cli skill delete`
- `room-cli skill search`
- `room-cli skill registry`
- `room-cli skill registry detail`
- `room-cli skill install`
- `room-cli skill cli-skills-status`
- `room-cli skill install-cli-skills`

## guide

- `room-cli guide`

## voice

- `room-cli voice`
- `room-cli voice transcribe`

## browser

- `room-cli browser`
- `room-cli browser instances`
- `room-cli browser tabs`
- `room-cli browser create`
- `room-cli browser acquire`
- `room-cli browser connection`
- `room-cli browser release`
- `room-cli browser reveal`
- `room-cli browser close`
- `room-cli browser capture`
- `room-cli browser watch`
- `room-cli browser import-sources`
- `room-cli browser import-cookies`

Machine lists and name/ID selectors include machines still being created. Machine creation is durable: `create --no-wait` returns the creating host ID. `machine show <host-id>` reads progress and `machine remove <host-id>` cancels it. SIGINT only stops following.

Machine environment: `room-cli machine env list`, `room-cli machine env set NAME`
(value from stdin), and `room-cli machine env unset NAME`; all accept `--json`.

Standalone `room-cli machine create` machines remain until explicitly removed.
