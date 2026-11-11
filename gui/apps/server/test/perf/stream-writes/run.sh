#!/usr/bin/env bash
# #1248 write bench. Replays a fixed streaming trace into a disposable seeded database and prints the bytes SQLite
# wrote. Never point it at a real user database.
#
#   bash apps/server/test/perf/stream-writes/run.sh                  # local and Cloud, 1 and 5 agents
#   RUNS="cloud:1" BENCH_CLOUD_BATCH_MS=0 bash .../run.sh            # one run, with the old one-commit-per-record path
set -euo pipefail
cd "$(dirname "$0")/../../.."   # apps/server

ROOT=/tmp/stream-writes
SEED=$ROOT/seed/bb.db
RUNS=${RUNS:-"local:1 local:5 cloud:1 cloud:5"}
SUFFIX=${SUFFIX:-}
mkdir -p "$ROOT/results"

if [ ! -f "$SEED" ]; then
  (cd ../.. && NODE_ENV=development node --conditions=source --import tsx packages/scripts/src/commands/seed-perf-db.ts \
    --data-dir "$ROOT/seed" --events "${SEED_EVENTS:-1600000}" --threads 6000 --projects 30 --reset)
fi

for run in $RUNS; do
  scenario=${run%%:*} agents=${run##*:}
  label=$scenario-$agents$SUFFIX
  work=$ROOT/work-$label.db
  rm -f "$work" "$work-wal" "$work-shm"
  cp --reflink=auto "$SEED" "$work"
  BENCH_DB=$work BENCH_SCENARIO=$scenario BENCH_AGENTS=$agents BENCH_LABEL=$label BENCH_OUT=$ROOT/results/$label.json \
    npx vitest run --config test/perf/stream-writes/vitest.config.ts 2>&1 | grep -E '^RESULT|FAIL|Error' || true
  rm -f "$work" "$work-wal" "$work-shm"
done
