import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveWindowsUpdateMarker, takeFailedWindowsUpdate } from "../src/desktop-update-resume.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { force: true, recursive: true });
});

describe("Windows update marker", () => {
  it("reports a Restart to update that left the old version, once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "update-marker-"));
    dirs.push(dir);
    await saveWindowsUpdateMarker(dir, "v9011", "9012.0.0");
    expect(await takeFailedWindowsUpdate(dir, "v9011")).toBe("9012.0.0");
    expect(await readdir(dir)).toEqual([]);
    expect(await takeFailedWindowsUpdate(dir, "v9011")).toBeNull();
  });

  it("stays quiet when the update installed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "update-marker-"));
    dirs.push(dir);
    await saveWindowsUpdateMarker(dir, "v9011", "9012.0.0");
    expect(await takeFailedWindowsUpdate(dir, "v9012")).toBeNull();
  });
});
