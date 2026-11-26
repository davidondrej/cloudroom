import { EventEmitter } from "node:events";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AppUpdater } from "electron-updater";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElectronAutoUpdaterAdapter } from "../src/desktop-auto-update.js";

const require = createRequire(join(process.cwd(), "package.json"));
const { AppImageUpdater } =
  require("electron-updater/out/AppImageUpdater.js") as typeof import("electron-updater/out/AppImageUpdater.js");

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Electron updater handoff", () => {
  it.each([
    ["linux", ["unlock", "install", "exit:0"]],
    ["win32", ["install:false,true"]],
    ["darwin", ["install"]],
  ] as const)("hands off the %s update", (platform, expected) => {
    vi.stubGlobal("process", { ...process, platform });
    const calls: string[] = [];
    const updater = {
      quitAndInstall(...args: boolean[]) {
        calls.push(args.length === 0 ? "install" : `install:${args.join(",")}`);
      },
    } as unknown as AppUpdater;
    const app = {
      releaseSingleInstanceLock() {
        calls.push("unlock");
      },
      exit(code: number) {
        calls.push(`exit:${code}`);
      },
    };

    createElectronAutoUpdaterAdapter(
      updater,
      new EventEmitter(),
      app,
    ).quitAndInstall();

    expect(calls).toEqual(expected);
  });

  it("delivers a synchronous install error before exiting, so the recovery listener can reopen", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const updater = new AppImageUpdater(null, { version: "1.0.0" });
    updater.logger = null;
    const calls: string[] = [];
    const app = {
      releaseSingleInstanceLock() {
        calls.push("unlock");
      },
      exit(code: number) {
        calls.push(`exit:${code}`);
      },
    };
    updater.once("error", (error: Error) => {
      expect(error.message).toContain("No update filepath provided");
      calls.push("recovery");
    });

    createElectronAutoUpdaterAdapter(
      updater,
      new EventEmitter(),
      app,
    ).quitAndInstall();

    expect(calls).toEqual(["unlock", "recovery", "exit:0"]);
  });

  it.skipIf(process.platform !== "linux").each([
    ["Cloudroom.AppImage", "Cloudroom.AppImage"],
    ["Cloudroom-1.0.0.AppImage", "Cloudroom-2.0.0.AppImage"],
  ])(
    "unlocks before the real AppImage updater launches %s and exits the old GUI",
    async (oldName, newName) => {
      // BaseUpdater queues app.quit with setImmediate. A renderer could cancel it;
      // hold it here to prove the explicit exit does not depend on that callback.
      vi.useFakeTimers({ toFake: ["setImmediate"] });
      const root = await mkdtemp(join(tmpdir(), "cloudroom-update-"));
      try {
        const oldImage = join(root, oldName);
        const stagingDir = join(root, "staged");
        await mkdir(stagingDir);
        const downloadedImage = join(stagingDir, newName);
        const lockPath = join(root, "gui.lock");
        const launchPath = join(root, "replacement.json");
        await writeFile(oldImage, "old build");
        await writeFile(lockPath, "locked");
        await writeFile(
          downloadedImage,
          `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(`${launchPath}.tmp`)}, JSON.stringify({ locked: fs.existsSync(${JSON.stringify(lockPath)}) }));
fs.renameSync(${JSON.stringify(`${launchPath}.tmp`)}, ${JSON.stringify(launchPath)});
`,
          { mode: 0o755 },
        );
        vi.stubEnv("APPIMAGE", oldImage);

        const updater = new AppImageUpdater(null, { version: "1.0.0" });
        updater.logger = null;
        // Stage a synthetic download without a server or the user's profile.
        Object.assign(updater, {
          downloadedUpdateHelper: {
            file: downloadedImage,
            downloadedFileInfo: { isAdminRightsRequired: false },
          },
        });
        const events: string[] = [];
        const app = {
          releaseSingleInstanceLock() {
            // The old file must still exist when the lock is released.
            expect(existsSync(oldImage)).toBe(true);
            events.push("unlock");
            // unlink synchronously, as Electron releases its lock synchronously.
            unlinkSync(lockPath);
          },
          exit(code: number) {
            expect(existsSync(join(root, newName))).toBe(true);
            events.push(`exit:${code}`);
          },
        };
        const errors: Error[] = [];
        updater.on("error", (error: Error) => errors.push(error));

        createElectronAutoUpdaterAdapter(
          updater,
          new EventEmitter(),
          app,
        ).quitAndInstall();

        expect(errors).toEqual([]);
        // vi.waitFor advances fake timers, which would run the queued app.quit.
        const deadline = Date.now() + 2_000;
        while (!existsSync(launchPath) && Date.now() < deadline)
          await delay(10);
        expect(existsSync(launchPath)).toBe(true);
        expect(JSON.parse(await readFile(launchPath, "utf8"))).toEqual({
          locked: false,
        });
        expect(events).toEqual(["unlock", "exit:0"]);
        expect(await readFile(join(root, newName), "utf8")).toContain(
          "replacement.json",
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );
});
