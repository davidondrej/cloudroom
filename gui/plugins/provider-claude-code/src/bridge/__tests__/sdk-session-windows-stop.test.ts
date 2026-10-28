import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SdkSession } from "../sdk-session.js";

// A stand-in for Claude Code under the real SDK: it starts a long-lived tool
// process, then exits as soon as its stdin closes, the way Claude does. The
// tool is detached, as Git Bash's children are: otherwise libuv's job object
// would end it with the fake. On Windows it keeps running unless the stop ends
// the tree before Claude's stdin closes.
const FAKE_CLAUDE = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const tool = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { detached: true, stdio: "ignore" });
tool.unref();
writeFileSync(process.env.TOOL_PID_FILE, String(tool.pid));
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

it.skipIf(process.platform !== "win32").each(["stop", "closeGracefully"] as const)(
  "a Windows %s ends Claude's tool processes before closing its stdin",
  async (how) => {
    const root = mkdtempSync(join(tmpdir(), "claude-stop-"));
    roots.push(root);
    const fake = join(root, "fake-claude.mjs");
    const pidFile = join(root, "tool.pid");
    writeFileSync(fake, FAKE_CLAUDE);
    const session = new SdkSession(
      {
        cwd: root,
        systemPrompt: "test",
        pathToClaudeCodeExecutable: fake,
        env: { ...process.env, TOOL_PID_FILE: pidFile },
      },
      () => {},
      () => {},
    );
    session.start();
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
    const toolPid = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(toolPid)).toBe(true);

    if (how === "stop") await session.stop();
    else await session.closeGracefully(5_000);

    await waitFor(() => !isAlive(toolPid), 5_000).catch(() => {});
    const leftover = isAlive(toolPid);
    if (leftover) process.kill(toolPid);
    expect(leftover).toBe(false);
  },
  30_000,
);
