# Stream write bench (#1248)

Measures how many bytes SQLite writes to disk while agents stream. Not part of the normal test suite.

## Run

From `gui/`, with dependencies installed:

```sh
bash apps/server/test/perf/stream-writes/run.sh
```

- The first run seeds a disposable 2.1 GB database (1.6M events) under `/tmp/stream-writes/`. This takes about 3 minutes.
- Every run works on a fresh copy and deletes it. The bench refuses any database outside `/tmp/stream-writes/`.
- Results print as `RESULT {...}` lines and go to `/tmp/stream-writes/results/*.json`, with the written pages per index.
- To measure an older commit, copy this folder there. `bench.ts` falls back to the old saving rule.

## What it does

- **Trace:** each agent runs Codex-like turns for 60 seconds: reasoning, commands, patches and replies, with 30 text pieces a second. The content and the timing are fixed, so two runs replay the same input.
- **Local:** the real daemon event sink posts to the real `POST /internal/session/events` route, on a fake clock. A POST takes 5 ms on that clock.
- **Cloud:** Core records go through the real `recordSaving` and `projectRecords`. The bench stands in for the stream loop's timer.
- **Bytes:** every WAL frame SQLite writes, plus every page a checkpoint copies to the main file, with one checkpoint per 1000 frames as in the app. This is counted, not sampled. It matches the bytes the process passed to `write()` to within 0.001%.
- **Same result:** a run fails if a save fails, or if the stored Cloud text differs from the text sent. `contentHash` covers what the app would show. It must be equal before and after a change.

## Results (2026-11-10, Linux, 2.1 GB database)

"Before" is `main` at `101838636`, which already saves Cloud tokens together every 100 ms (#1362).

| Workload        | Before KB/s | After KB/s | Change | Commits       | Event rows    |
| --------------- | ----------- | ---------- | ------ | ------------- | ------------- |
| Local, 1 chat   | 998         | 241        | −76%   | 730 → 216     | same view     |
| Local, 5 agents | 5,329       | 1,364      | −74%   | 1,507 → 418   | same view     |
| Cloud, 1 chat   | 799–874     | 269        | −68%   | 619 → 280     | 1,427 → 277   |
| Cloud, 5 agents | 4,516       | 1,418      | −69%   | 3,169 → 1,419 | 7,126 → 1,409 |

- Local rows are for a daemon POST that takes 5 ms (`BENCH_POST_MS`). At 15 ms, 5 agents wrote 6,312 KB/s before and 1,314 after. Before, events that arrived during a POST went out straight after it, so a slow POST meant more POSTs.
- "Before" varies by about 5% between runs, because random event IDs hit random index pages. "After" does not vary.
- Before #1362, one Cloud chat wrote 1,279 KB/s (one commit for every record).
- Local event rows are pruned while the chat runs, so their count says little. The shown content is equal.

Where the saving comes from, one Cloud chat, each step added to the one before:

| Step                                                   | KB/s |
| ------------------------------------------------------ | ---- |
| `main`                                                 | ~850 |
| Join the text pieces of one item into one row per save | 498  |
| Time-ordered event IDs (Local gains more: 540 → 460)   | 501  |
| Save every 250 ms, not every 100 ms                    | 269  |

## What is left

One save still writes about 12 pages (50 KB), whatever it holds: one page each for the events table, its 6 full
indexes, the pointer map and the Cloud cursor. The rate is now about 4 saves a second for a chat that streams
without a pause. To go lower, save less often or drop indexes. Both need a decision: a longer wait shows text
later, and an index change needs a migration of a multi-GB table.

## Limits

- Measured on Linux. macOS counts logical writes the same way, but it was not measured there.
- 30 pieces a second without a pause is a worst case. Real chats pause for tools and for the user.
- The Cloud run calls `projectRecords` as the stream loop does, but not the loop itself. `cloudroom-pi.test.ts` covers the loop.
