# Thread coordination and inspection

## Cloud threads

```sh
room-cli cloud status --json
room-cli thread spawn --project PROJECT --machine cloud --provider codex \
  --model MODEL --request-id UNIQUE_ID --prompt "Task"
```

- Supports Codex and Pi, inspection, plain-text follow-ups, stop, title changes, pinning, and archive/restore.
- `tell` queues Cloud messages automatically. Local messages still steer by default. Explicit unsupported modes fail; no fallback to Local.
- Stop pauses the Cloud queue. To resume, list it with `room-cli thread queue list THREAD`, then send its first message with `room-cli thread queue send THREAD MESSAGE_ID`.
- Read `room-cli cloud status --json` before optional Cloud operations. Steering, compaction, attachments, message editing (`rewind`), and queue editing/cancellation depend on the connected core and harness capabilities. Forks are not enabled. Cloud automations run on a schedule while this computer is off: `room-cli loop create --cloud --thread THREAD [--new-thread|--same-thread] [--script-file PATH]` (see the `automations` skill). Change effort with `thread update THREAD --reasoning-level LEVEL`; change the model or agent in place with `thread update THREAD [--provider PROVIDER] --model MODEL`; read both with `thread show`. `--parent-thread` with a Cloud parent starts a linked child in its own sandbox, with a copy of the parent's code. A Local parent's Cloud child (`--parent-self --machine cloud --provider PROVIDER --model MODEL`) gets its own sandbox and messages the parent when it finishes; it starts from GitHub, so push first and pass `--base-branch BRANCH`. A capability flag is not proof that an operation completed.
- Phone: the user opens cloudroom.dev/m, signs in with their Cloudroom account, and adds the app to the Home Screen. With this computer off, the phone still shows and runs Cloud threads, but starting a new thread needs it.
- Retry an unconfirmed start, Local or Cloud, with the same `--request-id` (an unanswered spawn prints it). For a rejected start, use `room-cli cloud retry-start THREAD`. Do not blindly resend uncertain work.
- A Cloud thread paused on a full disk: run `room-cli cloud clear-disk THREAD`. It deletes package caches and Git-ignored dependency and build folders; code, `.env` files and chats stay. Its waiting message then sends by itself. An archived thread can't be cleared or reached with `vm run`: Cloudroom copies its sandbox to R2, then deletes it on its own. Unarchiving it keeps that disk in use.
- To fix or set up the VM or a Cloud thread's sandbox, or move files, configs, and logins to it, use `room-cli vm run|pull|push`, with `--thread ID` for a sandbox (see the command index).
- Cloud agents get Core's `room-cli`: the same commands and flags, for their own thread, children, and automations. They reach this computer with `room-cli mac run|pull|push`, only while "Let cloud agents access this computer" is on. They can rename, archive, move, or change the effort of their own thread with `room-cli thread update --self --title TITLE`, `room-cli thread archive --self`, `room-cli thread move --self --project PROJECT`, and `room-cli thread update --self --reasoning-level LEVEL`, start children in their own sandbox with `room-cli thread spawn`, and stop or archive them with `room-cli thread stop|archive CHILD_ID`. These commands control Cloud threads through the GUI backend while it is running.

## Coordinating Work

- Use one clear owner per task.
- Spawn independent tasks separately when parallel work is useful.
- Let threads work after spawning. Do not poll with shell sleeps, repeated log
  reads, or repeated status reads.
- Use `room-cli thread wait <thread-id>` to wait for a status or event. It defaults
  to `idle` for up to 20 minutes; this does not prove queued work completed.
  Check the queue and correlate the final output with the requested task;
  pass `--status` or `--event` for a different target, and `--timeout
<seconds>` when you need a shorter or longer budget.
- After spawning several children, run `room-cli thread wait --children`. It
  blocks until every child is done, failed, or needs input, and prints one line
  per child. It times out after 9 minutes; run it again to keep waiting. A child
  that needs input prints the `thread interactions show` command that says how
  to answer; a `thread tell` only queues behind the question.
- Use `room-cli thread tell <thread-id> "..."` when requirements change, a blocker
  needs clarification, or follow-up work is needed.
- Add `--plan` to `room-cli thread spawn` or `room-cli thread tell` to send the prompt as
  the provider's structured `/plan` action: the agent proposes a plan for
  approval before executing when supported by the provider. Plain `/plan ...` text is
  not recognized and reaches the provider as literal text. Review the proposed
  plan with `room-cli thread interactions`; `room-cli thread cancel-plan` leaves Plan mode
  early. The SDK equivalent is `input: [createBuiltinPlanCommandTextInput(text)]`
  (exported by `@cloudroom/sdk`) on `threads.spawn` / `threads.send`.
- Use `room-cli thread edit-message <thread-id> --message "..."` to replace and rerun
  the latest eligible user message in a supporting provider thread. Pass
  `--expected-request-sequence <sequence>` to select an earlier message. Failed
  and incomplete turns are eligible; submitting against a running thread stops
  and settles its current turn first. Opening edit mode in the app is
  non-destructive; history changes only when the edit is submitted successfully,
  and workspace changes remain. When an agent edits another thread, the CLI
  carries its `ROOM_THREAD_ID` so the replacement runs under agent permission
  policy.
- Add `--send-at <when>` to `room-cli thread spawn` or `room-cli thread tell` to schedule
  the dispatch instead of attempting it now. `<when>` is an ISO 8601 timestamp
  (`2026-08-25T09:00`, local when no offset is given) or a duration from now
  (`30s`, `10m`, `2h`, `7d`); a time in the past and a bare date are both
  rejected. A scheduled spawn creates the thread `pending` with no turn and no
  environment work — no worktree and no setup script run until it is due — and a
  scheduled tell neither sends nor runs. Both report `delivery: "queued"` and
  dispatch on the sweep after the requested time. The SDK equivalent is `sendAt`
  (epoch ms) on `threads.spawn` / `threads.send`.
- `room-cli thread queue list` shows a Sender for agent threads and system notices.
  SDK queue rows and `--json` include `initiator` and nullable `senderThreadId`.
- A send that cannot run right now does not fail: it joins the thread's queue
  with a typed reason. `--json` reports `delivery: "queued"` plus
  the complete `queuedMessage` row, so a script can inspect its `id`,
  `waitingOn`, and `sendAt` without guessing. `queuedMessage.waitingOn.kind` is
  one of `time`, `thread-busy`, `turn-starting`, `provisioning`, `host-offline`,
  `interaction`, or `plugin` (which also carries `pluginId` and a human reason).
- Inspect and act on queued dispatches with `room-cli thread queue list [<thread-id>]
[--wait-holder plugin:<plugin-id>]`, `room-cli thread queue send <thread-id>
<message-id>` (send it now, bypassing every plugin wait and its schedule), and
  `room-cli thread queue delete <thread-id> <message-id>` (discard it). Omitting the
  thread lists every queued row in the workspace. The list shows `Waiting on`
  and `Send at` columns. Several queued rows on one thread are normal. The SDK
  equivalents are `threads.queue.list` (cross-thread) and
  `threads.queuedMessages.list/send/update/delete` (one thread).
- Stop pauses a Local thread's queue too, including a message that was waiting
  on a pending interaction the Stop cancelled. A stopped parent also holds its
  children's notices and `tell`s until the user messages it; a child whose
  `tell` is held must not resend it or `queue send` it.
  Only rows that `queue list` shows as `paused by Stop` (`pausedByStop: true`
  in JSON) are paused. Send one of those with `queue send` or discard it with
  `queue delete`; do not re-send it with `tell`, because the next turn resumes
  the queue and the paused copy would send too. A scheduled row (`time`) is
  never paused and sends itself at its time; `queue send` would send it now.
- If `room-cli thread stop` fails with `thread_stop_unconfirmed`, the agent may
  still be running. The thread stays `stopping`, its queue waits, and it
  settles by itself if the agent stops later. Running stop again asks the host
  again. Do not resend queued messages.
- `room-cli thread queue send <thread-id> <message-id> --mode steer` re-attempts the
  row as a steer with the same send-now behavior: it bypasses the row's schedule
  and plugin waits, while core waits still apply. During provisioning it reports
  that the row is still queued and leaves it waiting for the workspace.
- Queueing writes nothing to the timeline: a queued message reaches the thread
  log only once it dispatches. Ask the queue instead. In the app the same fact
  reaches the sidebar as a clock on any thread that holds queued work and is not
  running (the failure glyph instead if a drain attempt failed); a thread list
  entry carries it as `queuedWork: "none" | "waiting" | "failed"`.
- Use `room-cli thread count` when you need how many threads there are, never a list
  plus a row count: the count is a database aggregate, while `room-cli thread list`
  pages a bounded window and would miscount. Narrow with `--status
<pending|idle|starting|active|stopping|error>`, `--host`, `--provider`,
  `--project`, and `--parent <id|none>` (`none` counts only threads that have no
  parent at all; pass an id to count one thread's children). Archived, deleted,
  and hidden threads are excluded. Plain output is one number; `--by
host|provider|project` prints a count per group (a thread with none groups
  under `-`) and the total. The SDK equivalent is `threads.count({ status,
hostId, providerId, projectId, parentThreadId, groupBy })`.
- `room-cli thread tell` steers Local threads by default and queues Cloud messages.
  For Local threads, use `--mode queue` when the message is non-urgent and the
  agent can finish its current work first. Steer is especially important for a
  wrong direction, hard stop, or critical clarification.
  Example: `room-cli thread tell <thread-id> "Stop and use approach B" --mode steer`.
- If `tell` says Cloudroom did not confirm the message, it may already be sent:
  check `room-cli thread show`. For a Cloud thread it prints a request ID (also
  `requestId` in `--json`); to resend, repeat the same tell with `--request-id ID`
  so it is not added twice. Local threads have no such ID; never resend blindly.
  A resend with local `--file`/`--image` uploads them again under new paths, so it
  can fail with `request_conflict`: the message was already saved; don't resend it.
- Input sent while a turn is starting stays queued with
  `waitingOn.kind: "turn-starting"`. The `turn/started` event wakes it and
  steers it into that turn. Do not resend it.
- If the target thread is awaiting user interaction (an open question or
  approval), `room-cli thread tell` cannot interrupt it. The message joins the
  thread's queue with `waitingOn.kind: "interaction"` and dispatches once the
  interaction settles; the CLI prints that it is queued and why. That outcome is
  not a failure, so do not resend. For a hard stop use `room-cli thread stop
<thread-id>`; Stop pauses the message, so send it with `queue send`. `--json`
  reports `delivery` as `sent` or `queued`. If the thread fails while the
  message is queued (its provider exited), the message waits until somebody
  retries the thread.

## Inspecting Results

- Use `room-cli thread search <query> [--limit <1-50>]` for sidebar search. Use
  `history`, `read|unread`, and `section` for organization and recall. The
  `room-cli thread queue` group contains the queued-message operations. Queue updates
  use the listed version and accept repeatable `--file` and `--image` options;
  absolute file/image paths and `file:` URLs are uploaded from the CLI machine before the update.
- Use `room-cli thread list` to find threads, most recently updated first. Filter
  with `--project`, `--status`, `--provider`, `--machine local|cloud`, and
  `--pinned`; order with `--sort updated|created`. The table shows 50 threads
  and says when more exist; `--limit <n>` or `--all` changes that. `--json`
  prints every match as full records, so pipe it to a script. To read JSON,
  pick keys with `--fields id,title,status`: one compact row per thread. The
  SDK equivalent is `threads.list({ status, providerId, executionTarget,
pinned, sort, limit })`.
- Use `room-cli thread show <thread-id>` for status, parent, environment, pull request
  status, and result.
- When polling status, add `--no-pr`: it skips the GitHub pull request lookup, which
  can take up to 10 s, and JSON reports `pullRequest.status` as `skipped`.
- Use `room-cli thread show <thread-id> --git-diff` to review file changes.
- Use `room-cli thread log <thread-id>` to inspect the conversation. The default
  shows only the newest 20 user-message turns and ends with a notice when older
  history was omitted. For timeline text, `--limit <n>` accepts at most 100.
  `--all` prints the whole thread. Human formats use a consistent history
  snapshot and join paginated group contents. Appends remain outside that walk;
  rerun after a cursor-invalidated error from a history edit. JSON accepts any positive limit. It defaults
  to the oldest 100 raw events and warns when more exist. Page with
  `--after-seq <seq>` or pass `--all`.
  Grep the `--all` output, not the default page, when checking whether a
  thread ever received a message.
- Use `room-cli thread output <thread-id>` to read the latest final output, or
  `room-cli thread output --self` for the current thread.

For review or fix pipelines, get the environment ID from
`room-cli thread show <thread-id> --json`, then spawn the follow-up with
`--environment <environment-id>` so it sees the same files.

## Opening Threads And Files In The App

- Reference a Cloudroom thread in chat as `@thread:thr_abc123`, substituting its
  actual ID. Cloudroom renders the mention with the correct project-aware link; do not
  construct `/threads/...` or `/projects/.../threads/...` URLs manually.
- Use `room-cli thread open <path>` inside a Cloudroom thread to open a Markdown, HTML, or
  other workspace file for the user in the Cloudroom IDE's thread panel.
- Use `room-cli thread open <thread-id> --split right|down|left|top|replace` to open
  or focus a thread in the current app split layout. `replace` is the default;
  an already-open thread is focused. Edge splits create panes through the
  eighth pane; at eight panes, they replace the focused pane.
- A file path is optional when a thread ID is explicit:
  `room-cli thread open <thread-id> [path] [--split <placement>]`.
- Paths can be thread-relative workspace paths, or absolute paths inside the
  target thread workspace.
- Absolute paths under `ROOM_THREAD_STORAGE` open as thread-storage files for the
  current thread.
- Use `room-cli thread pane maximize|restore|toggle|spotlight|clear-spotlight
[thread-id]` to change a matching open pane in every connected Cloudroom app window.
  Inside a Cloudroom thread, omit the ID to use `ROOM_THREAD_ID`. The command reports
  how many connected clients received the ephemeral action. The SDK equivalent is
  `sdk.threads.paneAction({ threadId, action })`.
- Users can also toggle the focused pane from its header or with the configurable
  `pane.maximize.toggle` app command (default `Mod+Shift+E`).

## Files And Voice

- Use `room-cli file read|write|list|paths|mkdir|move|remove` for SDK-equivalent host
  file access. `--host` targets another machine; `--root` confines mutations.
- File write requires exactly one of `--content` and `--stdin`. File paths lists
  files and directories when neither selector is present. File list and file
  paths include dot-prefixed entries; `--no-hidden` skips them. Both skip
  `node_modules`, `.venv`, `.pnpm-store`, and root-relative `.claude/worktrees`
  by default. `--exclude <names...>` replaces that set; entries match basenames
  at any depth or exact root-relative paths using `/` separators.
- File remove supports `--recursive` and requires `--yes` without a terminal.
- Use `room-cli voice transcribe <file> [--type <mime>] [--prompt <text>]` without the
  app composer. The MIME type defaults to `audio/webm`.

## Long-Running Commands

- Use `room-cli terminal ...` for long-running commands the user may need to inspect
  or stop later: dev servers, watch tasks, REPLs, database consoles, and similar
  processes. The terminal is a real persistent PTY shown in the Cloudroom UI.
- `list` and `create` require exactly one explicit scope: `--thread <id>`,
  `--environment <id>`, or `--machine <id-or-name>` (`--host` is an alias).
  Thread-scoped terminals receive `ROOM_THREAD_ID`, `ROOM_PROJECT_ID`,
  `ROOM_ENVIRONMENT_ID`, and `ROOM_THREAD_STORAGE`; `room-cli status` and `--self`
  work without manual settings. Other terminal scopes have no current thread.
  Add `--cwd <path>` only to a machine scope. Machine targets resolve to an
  explicit host ID; terminal commands never silently fall back to primary.
- Start a server with
  `room-cli terminal create --thread <thread-id> --title "pnpm dev" --command "pnpm dev"`.
- `room-cli terminal start` is an alias for create. `room-cli terminal stop` is an alias
  for close.
- Use `room-cli terminal show`, `attach`, and `resize` for session inspection,
  interactive attachment, and PTY size changes. Use live help for their flags.
- All existing-session operations need only the terminal ID. Use
  `room-cli terminal wait <terminal-id> --contains "Local:" --timeout 120` to wait
  for readiness from new output. Pass `--from-start` only when matching existing
  scrollback is intentional.
- Use `room-cli terminal output <terminal-id> --json` to read bounded output, then
  continue with `--since-seq <nextSeq>` when polling. Use
  `room-cli terminal send <terminal-id> --text "..." --enter` for interactive input,
  `room-cli terminal rename <terminal-id> <title>` to rename, and
  `room-cli terminal close <terminal-id>` when the process is no longer needed.
- `room-cli terminal restart <terminal-id>` replaces the session with a shell in the
  same scope, size, and title. It does not replay the original launch command.

`room-cli thread update <id> --parent-thread <parent-id>` makes an existing thread a child; the parent then gets its turn updates. Clearing a thread's parent with `room-cli thread update --clear-parent-thread` inherits the former parent's section unless the update explicitly supplies a section. Unarchiving a child under an archived parent also releases it to top-level, unless `room-cli thread unarchive --keep-parent` keeps the link; under an open parent it stays a child. Children released by environment archiving also inherit their former parent's section.

Archiving a Local thread, 10 seconds later once Undo has passed, frees its idle agent session and stops what it left running outside the app: processes carrying its `ROOM_THREAD_ID`, such as a `nohup` dev server. Apps it opened are left alone. Cloud archive stops the whole sandbox.

## Moving, parents, and worktrees

`thread move` moves a Local or Cloud thread (or `--self`) to another project by ID or name. It keeps its chat; its next turn starts fresh in that project's folder, and the old folder stays. A running thread moves when its turn ends.

Make a thread a child with `room-cli thread update THREAD --parent-thread PARENT` (or `--self` as the child), or top-level with `--clear-parent-thread`. Unarchiving a child under an archived parent makes it top-level, so its parent stops getting its updates; unarchive the parent first. `room-cli thread unarchive THREAD --keep-parent` keeps the link anyway, but an archived parent gets none of its updates. Re-link a top-level child with `--parent-thread`. A Cloud thread sharing another thread's sandbox can only become top-level; one on a cloud VM can't change its parent. Parent changes and `unarchive` run from the desktop app or a Local thread; a Cloud thread's `room-cli` has neither.

To move a Local Claude Code or Codex thread into its own worktree, run `room-cli thread worktree`. The thread keeps its ID and chat and moves into a new Cloudroom-managed worktree from its current commit when its turn ends; Cloudroom deletes the worktree after archive. Other agents may share the checkout, so pass `--carry` with only the uncommitted files this thread changed, and `--allow-dirty` to leave the rest. Then end your turn, and from the next turn work only in the new worktree. To fork into a new thread instead, use `room-cli thread fork --new-environment worktree`. Never run `git worktree add` yourself; Cloudroom never cleans those folders up.

## Chat from a terminal

`room-cli thread chat THREAD` turns any terminal pane (Herdr, tmux, plain shell) into a chat with a Local or Cloud thread: live output, messages, `/approve`, `/deny`, `/stop`, and `/exit`. Start a new agent in the pane with:

```sh
room-cli thread chat "$(room-cli thread spawn --project PROJECT --prompt "Task" --json | jq -r .id)"
```

Inside Herdr, `chat` shows the thread as `cloudroom` with its idle, working, or blocked state, and Herdr reopens the chat after a restart. Answer agent questions in the app or with `room-cli thread interactions`.
