import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameFault = vi.hoisted(() => ({
  calls: 0,
  code: "",
  clock: 0,
  external: false,
  failures: 0,
  handoffs: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const rename: typeof fs.rename = async (...args) => {
    renameFault.calls += 1;
    if (renameFault.failures-- > 0) {
      if (renameFault.external) {
        renameFault.external = false;
        writeFileSync(args[1], '["cursor-added"]');
      }
      throw Object.assign(new Error("rename"), { code: renameFault.code });
    }
    return fs.rename(...args);
  };
  // Each waiter check sees a new lock holder one simulated second later.
  const stat = (async (...args: Parameters<typeof fs.stat>) => {
    const stats = await fs.stat(...args);
    if (renameFault.handoffs === 0 || !String(args[0]).endsWith(".bb-lock")) {
      return stats;
    }
    if ((renameFault.handoffs += 1) > 30) {
      throw new Error("still waiting");
    }
    renameFault.clock += 1_000;
    return Object.assign(stats, { mtimeMs: renameFault.clock });
  }) as typeof fs.stat;
  return { ...fs, rename, stat };
});
import {
  approveCursorSessionMcpServer,
  buildCursorMcpApprovalIdentifier,
  revokeCursorSessionMcpServer,
} from "./cursor-mcp-approval.js";
import type { AcpMcpServerConfig } from "./tool-proxy-mcp.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function mcpConfig(threadId = "thread-1"): AcpMcpServerConfig {
  return {
    name: "bb-bridge",
    command: "/usr/local/bin/node",
    args: ["/app/bridge.js", "--mcp-stdio"],
    env: [
      { name: "BB_TOKEN", value: "secret" },
      { name: "BB_THREAD", value: threadId },
    ],
  };
}

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform ?? {});
  vi.restoreAllMocks();
  Object.assign(renameFault, {
    calls: 0,
    external: false,
    failures: 0,
    handoffs: 0,
  });
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Cursor ACP session MCP approvals", () => {
  it("matches Cursor's approval fingerprint for a normalized stdio server", () => {
    expect(
      buildCursorMcpApprovalIdentifier({
        config: mcpConfig(),
        projectRoot: "/workspace/project",
      }),
    ).toBe("bb-bridge-d4709a3db84ddb48");
  });

  it("does not touch Cursor data for other ACP agents", async () => {
    const cursorDataDir = makeTempDir("bb-cursor-data-");
    const workspace = makeTempDir("bb-cursor-workspace-");

    await expect(
      approveCursorSessionMcpServer({
        agentCommand: "opencode",
        config: mcpConfig(),
        cwd: workspace,
        env: { CURSOR_DATA_DIR: cursorDataDir },
      }),
    ).resolves.toBeUndefined();
    expect(() => readFileSync(join(cursorDataDir, "projects"))).toThrow();
  });

  it("preserves unrelated approvals and removes its session approval on release", async () => {
    const cursorDataDir = makeTempDir("bb-cursor-data-");
    const workspace = makeTempDir("bb-cursor-workspace-");
    const env = { CURSOR_DATA_DIR: cursorDataDir };
    const first = await approveCursorSessionMcpServer({
      agentCommand: "/opt/cursor/cursor-agent",
      config: mcpConfig(),
      cwd: workspace,
      env,
    });
    if (!first) {
      throw new Error("Cursor approval was not installed");
    }
    await revokeCursorSessionMcpServer(first);
    writeFileSync(first.path, '["user-approved-server"]\n', "utf8");

    const approvals = await Promise.all([
      approveCursorSessionMcpServer({
        agentCommand: "cursor-agent",
        config: mcpConfig("thread-a"),
        cwd: workspace,
        env,
      }),
      approveCursorSessionMcpServer({
        agentCommand: "cursor-agent.exe",
        config: mcpConfig("thread-b"),
        cwd: workspace,
        env,
      }),
    ]);
    expect(approvals.every(Boolean)).toBe(true);
    const installed = approvals.flatMap((approval) =>
      approval ? [approval] : [],
    );
    const stored = JSON.parse(readFileSync(first.path, "utf8")) as string[];
    expect(stored[0]).toBe("user-approved-server");
    expect(stored.slice(1).sort()).toEqual(
      installed.map((approval) => approval.approval).sort(),
    );

    await Promise.all(installed.map(revokeCursorSessionMcpServer));
    expect(JSON.parse(readFileSync(first.path, "utf8")) as unknown).toEqual([
      "user-approved-server",
    ]);
    expect(() => readFileSync(`${first.path}.bb-lock`)).toThrow();
  });

  it("does not remove an approval Cursor already had", async () => {
    const cursorDataDir = makeTempDir("bb-cursor-data-");
    const workspace = makeTempDir("bb-cursor-workspace-");
    const env = { CURSOR_DATA_DIR: cursorDataDir };
    const installed = await approveCursorSessionMcpServer({
      agentCommand: "cursor-agent",
      config: mcpConfig(),
      cwd: workspace,
      env,
    });
    if (!installed) {
      throw new Error("Cursor approval was not installed");
    }
    await revokeCursorSessionMcpServer(installed);
    writeFileSync(installed.path, JSON.stringify([installed.approval]), "utf8");

    const existing = await approveCursorSessionMcpServer({
      agentCommand: "cursor-agent",
      config: mcpConfig(),
      cwd: workspace,
      env,
    });
    expect(existing?.installedByBb).toBe(false);
    if (existing) {
      await revokeCursorSessionMcpServer(existing);
    }
    expect(JSON.parse(readFileSync(installed.path, "utf8")) as unknown).toEqual(
      [installed.approval],
    );
  });

  it.each([
    ["win32", "EPERM", 7, 1, false, 8, 1],
    ["win32", "EBUSY", 8, 1, false, 8, 0],
    ["win32", "ENOSPC", 1, 1, false, 1, 0],
    ["linux", "EPERM", 1, 1, false, 1, 0],
    ["win32", "EPERM", 1, 1, true, 2, 1],
    ["win32", "EBUSY", 40, 6, false, 41, 1],
  ])(
    "on %s after %s x%i with %i writers (external %s) renames %i times, saves %i",
    async (platform, code, failures, writers, external, renames, saved) => {
      const cursorDataDir = makeTempDir("bb-cursor-data-");
      const cwd = makeTempDir("bb-cursor-workspace-");
      Object.defineProperty(process, "platform", { value: platform });
      Object.assign(renameFault, { code, external, failures });
      const results = await Promise.allSettled(
        Array.from({ length: writers }, (_, index) =>
          approveCursorSessionMcpServer({
            agentCommand: "cursor-agent.exe",
            config: mcpConfig(`thread-${index}`),
            cwd,
            env: { CURSOR_DATA_DIR: cursorDataDir },
          }),
        ),
      );
      const installed = results.flatMap((result) =>
        result.status === "fulfilled" && result.value ? [result.value] : [],
      );
      expect(installed).toHaveLength(saved);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ code });
        }
      }
      expect(renameFault.calls).toBe(renames);
      const [project = ""] = readdirSync(join(cursorDataDir, "projects"));
      const dir = join(cursorDataDir, "projects", project);
      const files = saved > 0 || external ? ["mcp-approvals.json"] : [];
      expect(readdirSync(dir)).toEqual(files);
      if (files.length > 0) {
        expect(
          JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8")),
        ).toEqual([
          ...(external ? ["cursor-added"] : []),
          ...installed.map(({ approval }) => approval),
        ]);
      }
    },
    10_000,
  );

  it.each([
    ["linux", 5],
    ["win32", 15],
  ])(
    "on %s a waiter behind endless lock hand-offs gives up after %i s",
    async (platform, seconds) => {
      const env = { CURSOR_DATA_DIR: makeTempDir("bb-cursor-data-") };
      const args = {
        agentCommand: "cursor-agent.exe",
        config: mcpConfig(),
        cwd: makeTempDir("bb-cursor-workspace-"),
        env,
      };
      const seed = await approveCursorSessionMcpServer(args);
      mkdirSync(`${seed?.path}.bb-lock`);
      Object.defineProperty(process, "platform", { value: platform });
      Object.assign(renameFault, { clock: Date.now(), handoffs: 1 });
      vi.spyOn(Date, "now").mockImplementation(() => renameFault.clock);
      await expect(approveCursorSessionMcpServer(args)).rejects.toThrow(
        "Timed out updating Cursor MCP approvals",
      );
      expect(renameFault.handoffs - 1).toBe(seconds);
    },
  );
});
