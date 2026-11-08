import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";

const FAKE_CODEX_APP_SERVER_PATH = fileURLToPath(
  new URL("./fake-codex-app-server.mjs", import.meta.url),
);

export const FULL_ACCESS_SESSION_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

export function stubFakeCodexAppServer(scriptPath?: string): void {
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify(
      scriptPath === undefined
        ? [FAKE_CODEX_APP_SERVER_PATH]
        : [FAKE_CODEX_APP_SERVER_PATH, scriptPath],
    ),
  );
}

export function expectFakeCodexAppServersExited(
  processLogPath: string,
  expectedCount: number,
): void {
  const steps = readFileSync(processLogPath, "utf8").split("\n");
  const spawns = steps.filter((line) => line.startsWith("spawn:"));
  expect(spawns).toHaveLength(expectedCount);
  for (const line of spawns) {
    const pid = Number(line.split(":")[1]);
    expect(() => process.kill(pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  }
  // Windows force-terminates the process tree; the child's SIGTERM handler
  // cannot log its exit. Keep the graceful-shutdown assertion on POSIX.
  if (process.platform !== "win32") {
    expect(steps.filter((line) => line.startsWith("exit:"))).toHaveLength(
      expectedCount,
    );
  }
}
