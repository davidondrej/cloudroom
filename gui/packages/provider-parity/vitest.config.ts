import { defineWorkspaceTestConfig } from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    name: "@cloudroom/provider-parity",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    maxConcurrency: 16,
  },
});
