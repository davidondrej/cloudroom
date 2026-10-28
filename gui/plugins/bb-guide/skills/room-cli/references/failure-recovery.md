# Failure and interruption recovery

## Failures And Interruptions

- For failed threads, inspect `room-cli thread show <id> --json` and
  `room-cli thread log <id>` before deciding whether to retry, clarify, or update the
  user.
- Use `room-cli thread retry <thread-id>` to re-send a failed turn's original message
  verbatim. It re-submits the same input — it does not add a new user message to
  the timeline — and increments the attempt number (2 is the first retry). With
  no `--turn` it retries the most recent turn, the one whose failure put the
  thread in `error`; `--turn <requestId>` asserts which turn you mean and fails
  when the thread has moved on. It errors when the thread has not failed or
  `--turn` names a different turn (409 `no_failed_turn`), and when that turn
  already has a retry queued (`retry_already_queued`). Add `--send-at <when>` to
  queue the retry on the clock (same `<when>` grammar as `room-cli thread tell
--send-at`); without it the retry is attempted now and may still queue behind
  a busy thread or a plugin's dispatch hook. `--reason <text>` labels the queued
  row. The SDK equivalent is `sdk.threads.retry({ threadId, turnRequestId?,
sendAt?, reason? })`.
- A follow-up carries a thread's first prompt only if setup failed before the
  workspace was ready and the thread wasn't stopped. `room-cli thread retry`
  re-sends the most recent failed message (the original only if it never
  reached the agent). After Stop, or when unsure, re-send the task yourself; a
  carried first prompt is labeled for the agent, so a duplicate is harmless.
- For interrupted or stopped threads, inspect first. If the user stopped the
  thread, treat that as intentional unless they ask you to continue.
- Use `room-cli thread stop <id>` when a thread is stuck or no longer needed.
- `room-cli thread stop <id>` also releases an idle or stuck agent runtime and
  cancels pending automatic retries. The command is idempotent and preserves
  thread history.
- Use `room-cli thread compact <id>` to send the built-in `/compact` command to an idle or errored thread. Completion or failure appears in the timeline. Provider support varies; consult its skill and reported capabilities.
- Use `room-cli thread clear <id>` on an idle or failed thread to reset its active
  timeline and model context in place while keeping the same Cloudroom thread,
  workspace, durable event history, and sticky execution settings.
- Use `room-cli thread cancel-plan <id>` to exit an active Plan turn without
  optimistically clearing its banner. Use `room-cli thread clear-goal <id>` to clear
  a thread's durable Goal when supported by its provider. Both wait for provider confirmation.
- An agent can pause or finish its Codex Goal, never resume it. When a Goal is paused or blocked
  and the user wants it to continue, run `room-cli thread resume-goal <id>` (Local and Cloud).
