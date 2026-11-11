// #1248 write bench. Not part of the normal suite: it needs a seeded disposable database. See README.md.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["test/perf/stream-writes/bench.ts"],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 0,
    hookTimeout: 0,
    silent: false,
    env: {
      BB_DATA_DIR: "/tmp/cloudroom-stream-writes-data",
      BB_SERVER_PORT: "49171",
      BB_HOST_DAEMON_PORT: "49172",
    },
  },
});
