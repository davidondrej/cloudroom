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
