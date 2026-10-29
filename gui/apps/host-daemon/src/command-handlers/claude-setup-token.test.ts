import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeSetupToken } from "./claude-setup-token.js";

const TOKEN = `sk-ant-oat01-${"A".repeat(40)}`;
// No % signs: the Windows fake's `cmd /c` expands them. Like Claude, it starts the
// opener as its own `cmd`, whose command line the opener saves.
const LINK = "https://claude.com/cai/oauth/authorize?code=true&state=fake";
const folders: string[] = [];

// A `claude` that asks for the browser, prints its token, and exits at once:
// the token must still be readable after the process is gone.
function fakeClaude(): string {
  const folder = mkdtempSync(join(tmpdir(), "fake-claude-"));
  folders.push(folder);
  if (process.platform === "win32") {
    const file = join(folder, "claude.cmd");
    writeFileSync(
      file,
      `@echo off\r\ncmd /d /s /c ^""%BROWSER%" "${LINK}"^"\r\necho Your OAuth token (valid for 1 year):\r\necho ${TOKEN}\r\necho Store this token securely.\r\n`,
    );
    return file;
  }
  const file = join(folder, "claude");
  writeFileSync(
    file,
    `#!/bin/sh\n"$BROWSER" '${LINK}'\nprintf 'Your OAuth token (valid for 1 year):\\n\\n${TOKEN}\\n\\nStore this token securely.\\n'\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

afterEach(async () => {
  await claudeSetupToken({ type: "claude.setup_token", action: "cancel", runId: "test" });
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("claude.setup_token", () => {
  it("hands back Claude's link and token, never the token on screen, then forgets the run", async () => {
    const started = await claudeSetupToken({
      type: "claude.setup_token",
      action: "start",
      runId: "test",
      binary: fakeClaude(),
    });
    expect(started.state).not.toBe("missing");
    const done = await vi.waitFor(
      async () => {
        const result = await claudeSetupToken({ type: "claude.setup_token", action: "read", runId: "test" });
        expect(result.state).toBe("exited");
        expect(result.token).toBe(TOKEN);
        return result;
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(done.url).toBe(LINK);
    expect(done.screen.join("\n")).toContain("Store this token securely.");
    expect(done.screen.join("\n")).not.toContain("sk-ant-oat");
    await claudeSetupToken({ type: "claude.setup_token", action: "cancel", runId: "test" });
    expect(
      await claudeSetupToken({ type: "claude.setup_token", action: "read", runId: "test" }),
    ).toEqual({ state: "missing", url: null, token: null, screen: [] });
  });

  it.skipIf(process.platform === "win32")("hands back a running Claude's token only once two reads agree", async () => {
    const folder = mkdtempSync(join(tmpdir(), "fake-claude-"));
    folders.push(folder);
    const file = join(folder, "claude");
    writeFileSync(file, `#!/bin/sh\nprintf '${TOKEN}\\n'\nsleep 30\n`);
    chmodSync(file, 0o755);
    await claudeSetupToken({ type: "claude.setup_token", action: "start", runId: "test", binary: file });
    const reads: { onScreen: boolean; token: string | null }[] = [];
    const done = await vi.waitFor(
      async () => {
        const result = await claudeSetupToken({ type: "claude.setup_token", action: "read", runId: "test" });
        reads.push({ onScreen: result.screen.includes("[token]"), token: result.token });
        expect(result.token).toBe(TOKEN);
        return result;
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(done.state).toBe("running");
    expect(reads.find((read) => read.onScreen)).toEqual({ onScreen: true, token: null });
  });

  it("refuses to start without a binary", async () => {
    await expect(
      claudeSetupToken({ type: "claude.setup_token", action: "start", runId: "test" }),
    ).rejects.toThrow(/binary/);
  });
});
