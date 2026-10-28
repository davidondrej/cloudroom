# Dashboard API

`GET /v1/dashboard` uses the same per-VM bearer token as the session API. It reads the existing session registry and cached resource sample; it does not query the database, control agents, or collect separate history. Poll every five seconds over the deployment's authenticated HTTPS endpoint.

```json
{
  "version": 1,
  "sampledAt": 1780000000000,
  "runtime": { "ready": true, "configured": true, "version": "0.1.0" },
  "appConnectivity": "unknown",
  "resources": { "cpu": 12.5, "memory": 30, "disk": 20 },
  "resourceBytes": { "memoryUsedBytes": 4800000000, "memoryTotalBytes": 16000000000, "diskAvailableBytes": 80000000000, "diskTotalBytes": 100000000000 },
  "diskThresholds": { "warningBytes": 5000000000, "pauseBytes": 2000000000 },
  "agents": { "working": 0, "queued": 0, "waiting": 1, "failed": 0, "background": 0 },
  "storage": {
    "enabled": true, "level": "normal", "reason": "disk_capacity",
    "workspace_available_bytes": 80000000000, "history_available_bytes": 80000000000,
    "workspace_total_bytes": 100000000000, "history_total_bytes": 100000000000,
    "sampled_at": 1780000000000
  },
  "onboarding": { "localConnected": null, "offlineTaskVerified": null },
  "capabilities": { "settings": false, "updates": false },
  "sessionCount": 1,
  "sessions": [{
    "id": "cr_example", "title": "Codex session", "repository": "example",
    "harness": "codex", "model": null, "state": "waiting",
    "activity": "waiting", "lastActivity": 1780000000000
  }]
}
```

- Timestamps are Unix milliseconds. Resource readings and `sampledAt` are null before measurement. Samples refresh approximately every ten seconds; reads do not refresh their timestamp. Disk means the configured repository filesystem. Its percentage is `used / (used + available)`, excluding Linux-reserved blocks; no available space means 100%.
- `storage` is the same cached safety snapshot returned by `/v1/health`, independent of model discovery. Its level is `normal`, `low_space`, or `blocked`; reasons distinguish `disk_capacity`, `measurement_unavailable`, and `unprotected_test_mode`. Byte counts and `sampled_at` are null until a valid measurement, and after measurement failure. Clients should display available GB and the actual reason; older cores without this field have unknown storage details. See [disk policy](storage.md) for unchanged thresholds.
- `runtime.ready` means the core is running and storage permits execution. `runtime.configured` means at least 1 harness is configured. Neither verifies inference login or app onboarding. An installed core can run without repositories or harness accounts; new sessions return 409 until agent setup exists.
- Authenticated `GET /v1/ready` returns `{ "ready": true }` with 200 only while storage permits work and both history tables are reachable. Otherwise it returns 503. It creates no test records and does not require agent setup. Unlike the dashboard, this deployment check queries the database.
- Sessions are the latest 1,000 entries in this core's local registry, ordered by last recorded activity. `sessionCount` is the full local count. Saved-only database history and unrelated app/native processes are not included.
- Starting/resuming sessions are `queued`; running/interrupting/closing are `working`; idle or storage-paused sessions are `waiting`; closed sessions are `stopped`; lost/failed processes are `failed`. Unrecognized states stay `unknown`. `background` counts live sessions with more processes than their harness had at launch, such as a download or build, not counting the computer-use screen, its apps, or the browser-harness daemon; `/v1/drain` refuses with `background_jobs` while it is above zero. An idle session is not assumed to be a completed task; its latest failed prompt stays `failed` and an uncertain prompt outcome stays `unknown`.
- Titles are deliberately generic, never derived from prompts. Only repository basenames are returned. Model names come from recorded native identity; missing values remain null. New records retain `timestamp_ms` inside the existing text record format; older records remain readable and unknown historical times stay null. No SQL migration is needed.
- Never return receipts, prompts, transcript text, native paths, process arguments, or credentials. This endpoint is a read-only summary, not session replay.
- Settings and updates are unsupported in this slice. Clients must not call update endpoints without an explicit `capabilities.updates: true`; unsupported settings controls remain disabled. Missing capabilities mean unsupported, not enabled.

## Metric history

Core no longer serves `GET /v1/metrics`: Cores don't read the database (ADR 0232). Cloudroom's website charts machines from their uploaded `resources` diagnostics with the same query, in `cloudroom_metrics`: 30-second, 5-minute, 30-minute or 3-hour buckets for 1h, 24h, 7d or 30d, with CPU/memory averages and peaks, last bytes and agent counts, and `gap` over 30 seconds.

- Live dashboard readings retain the percentage-only `resources` contract. Optional `resourceBytes` adds absolute capacity; `agents` supplies current full-registry counts; `terminals` gives `open` (running shells) and `lastActivity` (latest terminal input or output), which keeps a sandbox awake; `diskThresholds` exposes the actual configured warning/pause boundaries (null without disk protection). Older cores omit these fields.

Verify with `python3 tests/core_fixture.py` after building. It checks authentication, bounded results, resource sampling, old records, and secret exclusion. Run the consuming app against the real core as well as its fixtures.
