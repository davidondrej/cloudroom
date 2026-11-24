import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ensurePackagedUserShellPath } from "../src/desktop-shell-path.js";

it.skipIf(process.platform !== "darwin")(
  "bounds the PATH probe when interactive shell startup outlasts its timeout",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-shell-timeout-"));
    const previous = process.env.ZDOTDIR;
    try {
      writeFileSync(
        join(directory, ".zshrc"),
        "integer finish=$((SECONDS + 6))\nwhile (( SECONDS < finish )); do :; done\n",
      );
      process.env.ZDOTDIR = directory;
      const env = { PATH: "/usr/bin:/bin" };
      const started = performance.now();
      const result = await ensurePackagedUserShellPath({
        env,
        isPackaged: true,
        platform: "darwin",
        logger: { warn() {} },
        timeoutMs: 2_000,
      });
      expect(performance.now() - started).toBeLessThan(3500);
      expect(result).toEqual({ kind: "unchanged", reason: "shell-error" });
      expect(env.PATH).toBe("/usr/bin:/bin");
    } finally {
      if (previous === undefined) delete process.env.ZDOTDIR;
      else process.env.ZDOTDIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

async function probeWithShell(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "bb-shell-probe-"));
  try {
    const shell = join(directory, "shell");
    writeFileSync(shell, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: shell };
    const started = performance.now();
    const result = await ensurePackagedUserShellPath({
      env,
      isPackaged: true,
      platform: "linux",
      logger: { warn() {} },
    });
    return { env, result, ms: performance.now() - started };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")(
  "returns at shell exit when a background job keeps the output pipe open",
  async () => {
    const { env, result, ms } = await probeWithShell("sleep 5 &\nprintf '%s' /held/bin");
    expect(ms).toBeLessThan(2_000);
    expect(result).toEqual({ kind: "updated", path: "/held/bin" });
    expect(env.PATH).toBe("/held/bin");
  },
  10_000,
);

it.skipIf(process.platform === "win32")(
  "keeps the inherited PATH when the shell prints more than the output cap",
  async () => {
    const { env, result } = await probeWithShell("head -c 2000000 /dev/zero | tr '\\0' a");
    expect(result).toEqual({ kind: "unchanged", reason: "shell-error" });
    expect(env.PATH).toBe("/usr/bin:/bin");
  },
  10_000,
);
