import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    testTimeout: 20_000,
    setupFiles: ["./vitest.setup.ts"],
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "bb-plugin-tasks",
      include: ["**/*.test.{ts,tsx}"],
      exclude: ["node_modules/**"],
    }),
  },
});
