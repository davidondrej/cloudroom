import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, onTestFinished } from "vitest";

it.each([false, true])(
  "runs the bundled sync helper with sibling core present: %s",
  (withCore) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cloudroom-assets-")));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, "gui/apps/server/src");
    mkdirSync(source, { recursive: true });
    copyFileSync(
      new URL("../../src/cloudroom-workspace-asset.ts", import.meta.url),
      join(source, "paths.mjs"),
    );
    cpSync(
      new URL("../../src/assets/cloudroom-sync", import.meta.url),
      join(source, "assets/cloudroom-sync"),
      { recursive: true },
    );
    if (withCore) {
      mkdirSync(join(root, "core/src/sync"), { recursive: true });
      writeFileSync(
        join(root, "core/src/sync/client.py"),
        "raise RuntimeError('must use bundled helper')\n",
      );
    }

    const resolved = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const m = await import(process.argv[1]); console.log(m.CLOUDROOM_SYNC_SCRIPT_PATH)",
        pathToFileURL(join(source, "paths.mjs")).href,
      ],
      { encoding: "utf8", cwd: root, timeout: 10_000 },
    );
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(resolved.stdout.trim()).toBe(
      join(source, "assets/cloudroom-sync/client.py"),
    );
    const help = spawnSync(
      "python3",
      ["-B", resolved.stdout.trim(), "--help"],
      { encoding: "utf8", cwd: root, timeout: 10_000 },
    );
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("--no-start");
  },
);
