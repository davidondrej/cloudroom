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

`--self` uses `ROOM_THREAD_ID` where supported. Thread IDs select Local or Cloud execution; connection settings still point to the same GUI backend.

On Windows (PowerShell), or to point `room-cli` at another backend, first read "Shell and environment variables" in [configuration](references/configuration.md).

## Top workflows

### See what is going on

```sh
room-cli project list --json
room-cli thread list --project PROJECT --status active
room-cli thread list --pinned --fields id,title,status
room-cli thread show THREAD --json
room-cli thread log THREAD      # what it did
room-cli thread output THREAD   # its last reply
```

Keep `thread list` small. Filter first: `--project`, `--status`, `--provider`, `--machine local|cloud`, `--pinned`. The table shows the 50 most recently updated threads; `--limit N` or `--all` changes that. `--json` prints every match as full records, about 1.5 KB per thread: pipe it to `jq`, never read it. To read JSON, pick keys with `--fields id,title,status`.

"Open" or "active" threads means threads with `archivedAt: null`. An archived thread is never open or active, whatever its `status` says. `thread list` shows open threads only; `--archived` shows only archived ones, and `--include-archived` shows both.

### Run subagents: fan out, wait, collect, archive

```bash
room-cli thread spawn --parent-self --prompt "Task A"   # once per task
room-cli thread wait --children   # blocks until all are done, failed, or need input
room-cli thread output CHILD
room-cli thread archive CHILD_A CHILD_B
```

`wait --children` gives up after 9 minutes (100 seconds in a Cloud thread) and exits 2: give the shell call a 10-minute timeout and run it again.

### Message or stop a thread

```sh
room-cli thread tell THREAD "Continue with this task"
room-cli thread tell THREAD --message-file notes.md   # a long message
room-cli thread stop THREAD
room-cli thread queue list THREAD                     # messages still waiting
```

A Local message steers the running turn. A Cloud message queues. `thread wait --status idle` only checks a status. Queued work may still be waiting. Check the queue and correlate the requested task with its actual output; after compaction, verify a follow-up completes, and after an attachment upload, verify the agent can read its content.

### Unblock a thread that needs input

```sh
room-cli thread interactions list THREAD
room-cli thread interactions show INTERACTION THREAD
```

`show` prints the question or approval and the exact command that answers it. `thread wait --children` prints this `show` command for each child that needs input.

### Start a Cloud thread

```sh
room-cli cloud status --json
room-cli thread spawn --project PROJECT --machine cloud --provider codex \
  --model MODEL --request-id UNIQUE_ID --prompt "Task"
```

- Retry an unconfirmed start, Local or Cloud, with the same `--request-id` (an unanswered spawn prints it). For a rejected start, use `room-cli cloud retry-start THREAD`. Do not blindly resend uncertain work.
- A Local parent's Cloud child (`--parent-self --machine cloud --provider PROVIDER --model MODEL`) starts from GitHub, so push first and pass `--base-branch BRANCH`. It messages the parent when it finishes.
- Queues, a full disk, the phone, `room-cli vm`, and what Cloud agents can do themselves: "Cloud threads" in [thread operation](references/thread-operation.md).

### Schedule work

A loop runs a prompt or script on a schedule, Local or Cloud: `room-cli loop --help` and the `automations` skill.

### Tidy up

```sh
room-cli thread update THREAD --title "New title"
room-cli thread move THREAD --project PROJECT
room-cli thread archive THREAD_A THREAD_B
```

Moves, parent links, unarchive, worktrees, and chat from a terminal: "Moving, parents, and worktrees" in [thread operation](references/thread-operation.md).

## Before a Local launch

Inspect `room-cli machine provider-cli status MACHINE --json`. A cached model list does not prove the executable is installed or logged in. If Claude is installed but reports `Not logged in`, ask the user to run `claude` and `/login`; do not collect credentials or install another copy.

## Skills the list leaves out

These stay off the skill list to keep it short. Read the file when the task calls for it; each sits next to this skill's folder.

- Build or change a Cloudroom plugin: `../plugin-authoring/SKILL.md`.
- Create or improve a skill: `../skill-creator/SKILL.md`.
- Commands that plugins add: `../plugin-commands/SKILL.md`, or `room-cli --help`.
- Share a local server to the user's phone or another device: `room-cli connect --help`.

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
