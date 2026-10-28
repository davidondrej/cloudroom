# Thread coordination and inspection

## Cloud limits

`room-cli thread tell` automatically queues Cloud messages. Local messages steer by default. Cloud supports follow-ups, inspection, stop, title changes, pinning, and archive/restore. Stop pauses the queue; `room-cli thread queue send THREAD FIRST_MESSAGE_ID` resumes in order. Inspect `room-cli cloud status --json`: steering, attachments, compaction, message editing (`rewind`), and queue editing/cancellation depend on the connected core and harness. Forks, scheduling, and session-model changes remain unavailable. Confirm actual outputs, not just advertised capabilities.

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
  on a pending interaction the Stop cancelled. `queue list` shows these rows as
  `paused by Stop` (`pausedByStop: true` in JSON). Send one with `queue send` or
  discard it with `queue delete`; do not re-send it with `tell`, because the
  next turn resumes the queue and the paused copy would send too.
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
- Use `room-cli thread show <thread-id>` for status, parent, environment, pull request
  status, and result.
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
