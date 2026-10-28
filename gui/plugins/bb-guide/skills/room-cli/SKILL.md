---
name: room-cli
description: 'Inspect and control Cloudroom Local and Cloud threads, projects, settings, plugins, and the cloud VM with room-cli. Use for Cloudroom CLI tasks, not official BB.'
---

# Cloudroom CLI

Use `room-cli` for Cloudroom, not official BB's `bb`. Never inspect, message, or launch other threads unless the user asks.

## Check context first

```sh
room-cli status --json
```

Confirm the server URL and project/thread before acting. Standalone `room-cli` targets the installed Cloudroom backend at `http://127.0.0.1:39886`, not the cloud VM. Official BB remains separate.

Cloudroom supplies `ROOM_SERVER_URL`, `ROOM_HOST_DAEMON_PORT`, `ROOM_CLI`, `ROOM_DATA_DIR`, and thread context to Local agents and thread-scoped terminals automatically. Machine-only and environment-only terminals have no current thread. `room-cli` ignores the corresponding `BB_*` settings. Use `ROOM_*` overrides only for an intentional target change; never reuse thread IDs from another instance. `"$ROOM_CLI"` selects the current runtime's executable directly in a POSIX shell.

Examples here use POSIX shell syntax. On Windows the agent shell is usually PowerShell: run bare `room-cli`, read an environment variable as `$env:NAME` (`"$env:ROOM_THREAD_ID"`), separate commands with `;` instead of `&&`, and continue a line with a backtick instead of a backslash.

## Common commands

```sh
room-cli project list --json
room-cli thread list --project PROJECT --json
room-cli thread show THREAD --json
room-cli thread log THREAD
room-cli thread output THREAD
room-cli thread tell THREAD "Continue with this task"
room-cli thread stop THREAD
room-cli thread update THREAD --title "New title"
room-cli thread move THREAD --project PROJECT
room-cli thread archive THREAD
```

`thread move` moves a Local or Cloud thread (or `--self`) to another project by ID or name. It keeps its chat; its next turn starts fresh in that project's folder, and the old folder stays. A running thread moves when its turn ends.

Make a thread a child with `room-cli thread update THREAD --parent-thread PARENT` (or `--self` as the child), or top-level with `--clear-parent-thread`. Unarchiving a child under an archived parent makes it top-level, so its parent stops getting its updates; unarchive the parent first. `room-cli thread unarchive THREAD --keep-parent` keeps the link anyway, but an archived parent gets none of its updates. Re-link a top-level child with `--parent-thread`. A Cloud thread sharing another thread's sandbox can only become top-level; one on a cloud VM can't change its parent. Parent changes and `unarchive` run from the Mac app or a Local thread; a Cloud thread's `room-cli` has neither.

To move a Local thread into its own worktree, run `room-cli thread worktree`. It forks the thread, with its history, into a Cloudroom-managed worktree from its current commit, which Cloudroom deletes after archive. Never run `git worktree add` yourself; Cloudroom never cleans those folders up. Commit your changes first; then stop and tell the user to continue in the new thread.

"Open" or "active" threads means threads with `archivedAt: null`. An archived thread is never open or active, whatever its `status` says. `thread list` shows open threads only; `--archived` shows only archived ones, and `--include-archived` shows both.

`--self` uses `ROOM_THREAD_ID` where supported. Thread IDs select Local or Cloud execution; connection settings still point to the same GUI backend.

## Use Cloudroom from a terminal

`room-cli thread chat THREAD` turns any terminal pane (Herdr, tmux, plain shell) into a chat with a Local or Cloud thread: live output, messages, `/approve`, `/deny`, `/stop`, and `/exit`. Start a new agent in the pane with:

```sh
room-cli thread chat "$(room-cli thread spawn --project PROJECT --prompt "Task" --json | jq -r .id)"
```

Inside Herdr, `chat` shows the thread as `cloudroom` with its idle, working, or blocked state, and Herdr reopens the chat after a restart. Answer agent questions in the app or with `room-cli thread interactions`.

## Cloud threads

```sh
room-cli cloud status --json
room-cli thread spawn --project PROJECT --machine cloud --provider codex \
  --model MODEL --request-id UNIQUE_ID --prompt "Task"
```

- Supports Codex and Pi, inspection, plain-text follow-ups, stop, title changes, pinning, and archive/restore.
- `tell` queues Cloud messages automatically. Local messages still steer by default. Explicit unsupported modes fail; no fallback to Local.
- Stop pauses the Cloud queue. To resume, list it with `room-cli thread queue list THREAD`, then send its first message with `room-cli thread queue send THREAD MESSAGE_ID`.
- Read `room-cli cloud status --json` before optional Cloud operations. Steering, compaction, attachments, message editing (`rewind`), and queue editing/cancellation depend on the connected core and harness capabilities. Forks are not enabled. Cloud automations run on a schedule while the Mac is off: `room-cli loop create --cloud --thread THREAD [--new-thread|--same-thread] [--script-file PATH]` (see the `automations` skill). Change effort with `thread update THREAD --reasoning-level LEVEL`; change the model or agent in place with `thread update THREAD [--provider PROVIDER] --model MODEL`; read both with `thread show`. `--parent-thread` with a Cloud parent starts a linked child in its own sandbox, with a copy of the parent's code. A Local parent's Cloud child (`--parent-self --machine cloud --provider PROVIDER --model MODEL`) gets its own sandbox and messages the parent when it finishes; it starts from GitHub, so push first and pass `--base-branch BRANCH`. A capability flag is not proof that an operation completed.
- Retry an unconfirmed start with the same `--request-id`. For a rejected start, use `room-cli cloud retry-start THREAD`. Do not blindly resend uncertain work.
- To fix or set up the VM or a Cloud thread's sandbox, or move files, configs, and logins to it, use `room-cli vm run|pull|push`, with `--thread ID` for a sandbox (see the command index).
- Cloud agents get a smaller `room-cli` from Core, for their own thread, children, and automations. They reach this Mac with `room-cli mac run|pull|push`, only while "Let cloud agents access this computer" is on. They can rename, archive, move, or change the effort of their own thread with `room-cli thread update --self --title TITLE`, `room-cli thread archive --self`, `room-cli thread move --self --project PROJECT`, and `room-cli thread update --self --reasoning-level LEVEL`, start children in their own sandbox with `room-cli thread spawn`, and stop or archive them with `room-cli thread stop|archive CHILD_ID`. These commands control Cloud threads through the GUI backend while it is running.

## Verify results and Local setup

`thread wait --status idle` only checks a status. Queued work may still be waiting. Check the queue and correlate the requested task with its actual output; after compaction, verify a follow-up completes, and after an attachment upload, verify the agent can read its content.

Before a Local launch, inspect `room-cli machine provider-cli status MACHINE --json`. A cached model list does not prove the executable is installed or logged in. If Claude is installed but reports `Not logged in`, ask the user to run `claude` and `/login`; do not collect credentials or install another copy.

## References

Use `room-cli --help`, `room-cli GROUP --help`, or `room-cli guide CHAPTER` for current options. Read only the relevant reference:

- [Command index](references/command-index.md): all core command paths.
- [Thread creation](references/thread-creation.md): projects, machines, Local launches and forks.
- [Thread operation](references/thread-operation.md): inspection, messaging, queues, files, terminals.
- [Failure recovery](references/failure-recovery.md): failed/stopped Local threads and provider controls.
- [Configuration](references/configuration.md) and [app settings](references/app-settings.md): settings and environment setup.
- [Plugins](references/plugins.md): plugin management; each plugin owns its command instructions.
- [Theme commands](references/theme-commands.md) and [theming](references/theming.md): appearance.

Resolve IDs before mutation. Prefer JSON for scripts. Confirm actual results and report the ID the user needs. Never claim a queued message has completed.
