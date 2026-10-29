import { describe, expect, it } from "vitest";
import type { BbDesktopInfo } from "@cloudroom/desktop-contract";
import { applyWebsiteRelease } from "./useDesktopUpdateInfo";

const info = (platform: BbDesktopInfo["platform"]): BbDesktopInfo => ({
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform,
  updateAvailable: false,
  updateDownloaded: false,
  version: "v115",
});

describe("applyWebsiteRelease", () => {
  it("announces a newer website release on macOS and Linux", () => {
    expect(applyWebsiteRelease(info("macos"), "116")).toMatchObject({ latestVersion: "v116", updateAvailable: true });
    expect(applyWebsiteRelease(info("linux"), "116")).toMatchObject({ updateAvailable: true });
  });

  it("leaves Windows to electron-updater", () => {
    expect(applyWebsiteRelease(info("windows"), "116")).toEqual(info("windows"));
  });
});
