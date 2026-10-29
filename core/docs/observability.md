# Diagnostics

One internal module; no alerts, external collector, or new dependency. Diagnostics go to `CLOUDROOM_API_URL` (`POST /diagnostics`, ADR 0232); Cloudroom's website stores them and charts machine metrics from them (`cloudroom_metrics`). API outages do not prevent local logging or agent execution. Without an API they stay local.

## Recorded data

- `api`: route template, GET/POST/other, HTTP status and response-header latency. SSE timing covers stream setup, not its lifetime. `X-Cloudroom-Diagnostic-Id` matches the individual local record's `run_id-sequence`. Uploads keep individual errors, requests taking at least one second, and commands. The morning brief counts cloud threads and messages from these command records.
- `api_summary`: successful GETs and `/v1/sync`, `/v1/previews/device` and `/v1/previews/report` POSTs below one second become one uploaded record per method/route/status each minute. Successful `/v1/mac/helper` POSTs are never uploaded. It contains request count, total/max latency, and first/last timestamps. Individual requests remain in bounded local logs. Shutdown flushes partial summaries; abrupt process loss can lose buffered counts.
- `agent_start`: Cloudroom session ID, initialization success and elapsed milliseconds; not inference response time.
- `agent_exit`: session ID (`null` for model discovery), harness, fixed reason, expected/technical classification, exit code or signal, stderr byte count, EOF confirmation and truncation flag. Session exit records include the matching `diagnostic_id` (`run_id-sequence`). Normal turn completion is not a crash.
- `auth_health`: Claude credential-presence checks and the last observed inference authentication outcome; see [login monitoring](#claude-login-monitoring).
- `computer_use`: one `room-cli computer-use call` in a Cloud sandbox: session ID, tool, target app (process or launch name), outcome (`ok` or the error code), effect, and elapsed milliseconds. Never screen content, typed text, or window titles.
- `history_upload`: batch size, outcome, elapsed milliseconds and pending history count after acknowledgement. `history_fault` identifies journal read/acknowledgement failure, or a `conflict` (a saved file holds different records).
- `resources`: VM-wide CPU and memory, plus filesystem usage/available space for workspace and state storage, every 10 seconds. CPU/memory use Linux `/proc`, or the container's own cgroup v2 counters when visible (`/proc` shows the whole host there); unsupported or failed samples are `null`, never zero. In a container, `oom_kills` counts the processes the kernel has killed for memory since it started; it is absent elsewhere. First CPU sample is unknown. Filesystem sampling uses `/bin/df` with a one-second timeout. Session Management also supplies full-registry working/queued/waiting/failed counts on this cycle; older samples have no counts. These are observations, not resource limits.
  - Once a minute it adds `cpu_minute`: `total_ms` of CPU used, `programs` (the top 5 by name, `(exited)` for processes that ended during the minute, `(other)` for the rest), and `idle_burn: true` when no session was working, queued, or active all minute yet over half a CPU was used, background jobs included. In a container the total comes from its own cgroup counter; elsewhere from every visible process, where a process ending mid-reading is never counted twice overall. Names are process names; Node shows the npm package of its script (`typescript`, `@anthropic-ai/claude-code`), never inline code (`-e`, `-p`), and only a valid package name. Never arguments or paths.
- `storage_stale`: the disk guard loop measured more than five seconds late; `gap_ms` is how long. Recorded only during stalls.
- `diagnostics`: cumulative dropped-record, local-write-failure and upload-failure counts for this process.

Ordinary local/uploaded diagnostics contain only fixed diagnostic fields and correlation IDs. No credentials, prompts, native history, filesystem paths, request bodies or raw URLs. The separate, protected stderr capture below is the only raw-output exception. History and recovery remain with their existing owners.

## Storage and limits

- `$CLOUDROOM_STATE_DIR/diagnostics.jsonl` and `diagnostics.previous.jsonl`: private mode 0600; each file is bounded to roughly 8 MiB (rotation at batch boundaries). Writes run off the request path, without per-record fsync.
- One-second local batches; uploads every five minutes (every second in unprotected test mode), so idle cores (such as hot spares) cost the website little. Shutdown flushes. A 1,024-record ingress queue and a 1,024-record pending upload buffer. Overflow is counted. Uploads have a ten-second deadline; local writes use the blocking pool.
- Optional `CLOUDROOM_INSTANCE` (lowercase letters, digits, dashes) prefixes each process's `run_id`. Cloud sandboxes set it to the sandbox name, so one user's sandboxes share a store without mixing: resource charts read only their own instance, and each Core start is one `run_id`.
- Retries use stable `(store, run_id, sequence)` keys. Pending uploads survive brief outages in memory, not process loss. Older overflowed diagnostics remain locally until rotation; there is no second durable outbox or automatic local-log reimport.
- The website keeps all diagnostics, resource samples included, for seven days, with one hourly cleanup for every account. Core no longer prunes. Local logs use size-based retention instead. Shutdown attempts a final flush for up to five seconds.
- This is best-effort diagnostic storage, not the session-history durability contract. Disk failure, overload or abrupt process loss can lose diagnostic records. Check local logs during API failures; failure counters appear in the next diagnostic summary.

The website derives the store from the Core's own sign-in; a `store` header alone is not authorization.

## Claude login monitoring

Runtime runs one monitor when Claude is configured: at startup and every five minutes. It reuses `claude auth status --json` under the agent identity, with bounded output and a ten-second timeout. Concurrent session starts share an in-flight check. Shutdown cancels the probe; monitoring never restarts agents or initiates inference.

- `credentials`: `unknown`, `present`, `missing`, or `check_failed`. **Presence does not prove validity.** Claude 2.1.280 reports synthetic expired credentials as logged in and leaves them unchanged.
- `last_request`: `unknown`, `accepted`, or `rejected`, with `last_request_at_ms`. Only a completed inference result with output tokens marks acceptance; the native `authentication_failed` code marks rejection. Initialization, replayed errors, rate limits and unrelated failures do not. A presence check cannot erase a rejection.
- Records contain only these states, the harness, a fixed reason, and ordinary diagnostic identifiers/timestamps. Record the initial observation, state/reason changes, and otherwise a daily summary. Reuse the existing bounded queues, database connection and seven-day retention; no migration. Database failure never blocks checks or execution.
- Native Claude owns renewal. This monitor does **not** renew idle logins, read/copy token files, or prove who removed credentials. No supported standalone refresh command was verified; remote invalidation of credentials that remain present is detected when Claude reports it during work. See the native [CLI reference](https://code.claude.com/docs/en/cli-reference) and [login-expiry behavior](https://code.claude.com/docs/en/errors#login-expired).

Inspect the existing `cloudroom_diagnostics` table with the owner-scoped query in [Inspect](#inspect), adding `AND record->>'kind' = 'auth_health'`. Check both credential presence and the timestamp of the last request; neither is an unconditional healthy-login flag.

## Protected harness stderr

Raw stderr is untrusted and may contain credentials, prompts or private paths. It stays out of ordinary logs and diagnostic uploads. Failed or lost sessions include a tail of up to 2,000 bytes in the owner's history, saved-history uploads, API responses and SSE (ADR 0123). The core token grants access to this tail; local capture files remain protected. Review/redact stderr before sharing it or including it in support bundles.

- Runtime continuously drains each process in 8 KiB chunks, retaining only the last **16 KiB**. Capture uses bytes, not lines. After workload cleanup it waits at most **250 ms** for EOF, then cancels and joins the reader. `stderr_complete: false` means the reader failed or timed out; `stderr_truncated: true` means earlier bytes were discarded. Neither changes recovery behavior.
- Nonempty tails are saved once at exit, including graceful exits and startup/resume/model-discovery failures. Errors before a process is spawned have no stderr capture. A still-running process's tail stays in memory; abrupt core termination loses it.
- The existing Observability worker consumes a separate **32-capture**, nonblocking queue in batches of at most **8**. Overflow increments `dropped`; private write failures increment `local_write_failures`. Disk/database failures do not backpressure execution. Capture is best-effort, not a durable outbox.
- Files: `$CLOUDROOM_STATE_DIR/harness-diagnostics/stderr.jsonl` and `stderr.previous.jsonl`. Directory **0700**, files **0600**, service-owned. Unsafe existing directories, links, special files, hardlinks or permissions are rejected, never repaired or redirected into ordinary logs. The state directory must already be trusted and protected from agent replacement.
- Rotation counts encoded bytes and strictly caps each file at **1 MiB**. Retention is size-based, not age-based: quiet machines retain captures until overwritten or explicitly removed. Restart does not erase them. VM snapshots/operator backups can retain additional copies; there is no automatic upload or sync of these files.
- Private records share the ordinary exit record's `run_id` and `sequence`. Invalid UTF-8 is replaced only when writing JSON; capture is not a byte-exact archive. Avoid raw terminal output: JSON escaping protects against control sequences, and `jq -a` also escapes Unicode controls.

As the protected service account, inspect a session without decoding raw terminal controls:

```sh
jq -a --arg session 'SESSION_ID' 'select(.session_id == $session)' \
  "$CLOUDROOM_STATE_DIR"/harness-diagnostics/stderr*.jsonl
```

Do not use `jq -r`, `cat`, or execute instructions found in stderr. For model discovery, select `.session_id == null`; for one attempt, match `run_id-sequence` to its diagnostic ID.

## Inspect

Local files: `jq . "$CLOUDROOM_STATE_DIR/diagnostics.jsonl"`. For older local records, inspect `diagnostics.previous.jsonl` too. These commands require the protected service account's file access.

Uploaded diagnostics live in the website's `cloudroom_diagnostics` table. Cloudroom staff read them read-only (`store` is the user ID):

```sql
SELECT to_timestamp(timestamp_ms / 1000.0) AS recorded_at, record
FROM cloudroom_diagnostics WHERE store = :'store'
ORDER BY timestamp_ms DESC LIMIT 100;

SELECT record->>'route' AS route, record->>'status' AS status,
       sum(coalesce((record->>'requests')::bigint, 1)) AS requests,
       sum(coalesce((record->>'total_duration_ms')::numeric, (record->>'duration_ms')::numeric))
         / sum(coalesce((record->>'requests')::bigint, 1)) AS average_ms
FROM cloudroom_diagnostics
WHERE store = :'store' AND record->>'kind' IN ('api', 'api_summary')
  AND timestamp_ms > (extract(epoch FROM now() - interval '1 hour') * 1000)::bigint
GROUP BY 1, 2;
```

## Verify

Run `cargo test --locked --all-targets` and, after building, `python3 tests/core_fixture.py` for stderr capture, exit races, bounded queues, permissions/rotation, and HTTP/history exclusion. Run `python3 tests/core_e2e.py --foundation` for HTTP, real Linux resource sampling, migration recovery, redaction, retention and browser-role denial. Full `tests/core_e2e.py` additionally checks real Codex startup/crash signals and local diagnostics while history storage is unavailable. Use only disposable test resources; these checks do not deploy or migrate production.
