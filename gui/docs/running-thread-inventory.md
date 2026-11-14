# Running thread inventory

Proof-first checks for the desktop and plugin inventory. Fixtures are synthetic; no live account is used.

## Before the change

From `gui/`:

```sh
pnpm --filter @cloudroom/server exec vitest run --config vitest.config.ts test/public/running-thread-inventory.test.ts --maxWorkers=1
pnpm --filter @cloudroom/app exec vitest run --config vitest.config.ts src/lib/plugin-sidebar-threads.test.ts --maxWorkers=1
```

Server: three failures. The bootstrap has no runningThreads (`expected undefined` for 60 hidden running rows and observed execution); CloudSync never adopts the orphan (`expected null not to be null`).
Plugin: one failure, twelve passes. The mapped thread has no execution observation.

## Contract to prove

- The shared bootstrap includes every locally known running thread, including hidden roots/children and hidden projects, without pagination. Archived/deleted threads remain excluded.
- An orphan Cloud child is adopted and preserves its remote parent link before that parent exists locally; remote projects need no checkout. Adoption does not grant execution ownership.
- Core observations have explicit provenance and time. Configured defaults and an awake sandbox are never observations of running work or settings. Historical projection cannot rewrite live observations.
- The built-in Running section and plugin share the inventory. Collapse and ordinary visibility cannot remove its rows; children can be grouped per parent. Missing model/effort remain null.
- Cache changes preserve the running inventory and discard settled/removed rows; the disk placeholder does not advertise cached work as live.

Core child-list repair and account-wide website inventory are separate changes.

## Plugin contract

`experimental_useSidebarThreads()` now returns optional additive fields (older hosts omit them):

```ts
const { threads, runningThreads, childrenByParentId } = experimental_useSidebarThreads();
// threads: normal navigation union running inventory, deduplicated by id
// runningThreads: same rows as the always-expanded built-in Running section
// childrenByParentId[parentId]: delivered children, even when the parent is absent
```

Each thread's optional `execution` has `status`, `source`, `freshness`, `observedAt`, `receivedAt`, `model`, and `effort`. Timestamps are Unix milliseconds or null. `source` and the timestamps describe the execution-state observation. `last-known` is deliberately not a claim of continuous liveness. A legacy/local thread without that evidence has unknown freshness and null timestamps.

Observed settings come only from explicit Core native identity, model fallback, and reasoning records for the current session. Configured next-turn defaults and website sandbox availability are not used as observations. Settings may therefore be null, including on Local threads without an observation source. Session switches clear old settings; reconnect snapshots establish state while earlier records can still supply explicit settings. Display-only historical replay never updates live observations.

The running inventory includes starting, active, stopping, and active background agents/commands/workflows. Ordinary navigation retains its own visibility and lifecycle rules. A cached disk placeholder does not populate the Running section. The feature uses existing internal metadata storage, with no schema migration or new dependency.

## Validation and limits

- Initial proof commit: `b57c306e`, with the three server failures and one plugin mapping failure above.
- A later model-fallback case also failed first: expected `observed-fallback`, received `observed-model`; the same API proof passes after recording the explicit fallback.
- Server public API/parenting/project/defaults/stream/model-fallback checks: 65 passed, including orphan adoption and an explicit unparent before the deferred parent arrives.
- App inventory/plugin/cache/realtime checks: 140 passed. Domain: 218 passed. Plugin SDK: 287 passed, two existing skipped cases.
- Build/typecheck command from `gui/README.md`: 55 tasks passed (app, server, desktop and dependencies).
- App workflow's config tests: 130 passed, one existing skipped case.
- Full DB suite: 496 passed and 21 migration cases failed with duplicate `parked_at`. All 21 reproduce on untouched upstream `3208e790` (36 other migration cases pass there); this branch changes no schema or migration.
- README scripts/config command is **not green**: scripts has five failures (missing `ci.yml`, `gui-versions.yml`, SDK-version checker, and a stale provider-literal baseline). The same five failures reproduce on untouched upstream `3208e790`; 23 other tests in those two files pass there. These unrelated checks were not weakened or repaired here.
- Synthetic browser story inspected at 390×844 and 1440×900; both have no horizontal overflow. This is component QA, not an installed-account observation.

Core child-list repair (A) and the website's account-wide inventory (C) are not implemented here. The public website query remains unavailable; this feature cannot discover rows the website never sends to the desktop. Explicitly deleted projects/threads are not restored. Adoption does not give an orphan execution ownership; source-less project mappings do not make this install a launch/loop's home.
