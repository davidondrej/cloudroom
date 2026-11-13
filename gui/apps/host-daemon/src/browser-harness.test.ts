import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installBrowserHarnessShim } from "./browser-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const supported =
  ["darwin", "linux"].includes(process.platform) &&
  ["arm64", "x64"].includes(process.arch);

// A first run of the shim with a fake `curl` that saves where it downloads to,
// waits `delay` seconds, then fails the checksum check, so nothing is fetched
// or run. A space in the data folder's path must not matter.
async function firstRun(delay: number) {
  const root = mkdtempSync(join(tmpdir(), "browser-harness-"));
  roots.push(root);
  const dataDir = join(root, "data folder");
  const temp = join(root, "temp");
  const fakeBin = join(root, "fake-bin");
  mkdirSync(temp);
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "curl"),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\nprintf %s "$out" > "$CURL_OUTPUT"\nsleep ${delay}\nprintf junk > "$out"\n`,
  );
  chmodSync(join(fakeBin, "curl"), 0o755);
  const bin = await installBrowserHarnessShim(dataDir);
  return {
    home: join(dataDir, "browser-harness"),
    output: join(root, "curl-output"),
    shim: join(bin ?? "", "browser-harness"),
    temp,
    env: {
      ...process.env,
      CURL_OUTPUT: join(root, "curl-output"),
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      TMPDIR: temp,
    },
  };
}

it.skipIf(!supported)(
  "downloads uv into the data folder, never the OS temp folder",
  async () => {
    // uv runs from this download outside any sandbox. Read-only Mac commands
    // and sandboxed agents can change files in the OS temp folder.
    const run = await firstRun(0);

    const result = spawnSync(run.shim, ["--version"], {
      encoding: "utf8",
      env: run.env,
    });

    expect(result.stderr).toContain("uv checksum mismatch");
    const download = readFileSync(run.output, "utf8");
    expect(download.startsWith(`${run.home}/install.`)).toBe(true);
    expect(download.endsWith("/uv.tgz")).toBe(true);
    expect(readdirSync(run.temp)).toEqual([]);
    // The download and the install lock are gone.
    expect(readdirSync(run.home)).toEqual([]);
  },
);

it.skipIf(!supported)(
  "removes its download and lock when it is stopped mid-install",
  async () => {
    const run = await firstRun(30);
    // In its own process group, like an agent's command that times out.
    const child = spawn(run.shim, ["--version"], {
      detached: true,
      env: run.env,
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const pid = child.pid;
    if (pid === undefined) throw new Error("The shim did not start");
    await vi.waitFor(() => expect(existsSync(run.output)).toBe(true), {
      timeout: 10_000,
    });

    process.kill(-pid, "SIGTERM");
    await exited;

    expect(readdirSync(run.home)).toEqual([]);
  },
);
