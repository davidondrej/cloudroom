import { describe, expect, it } from "vitest";
import type { BbDesktopInfo } from "@cloudroom/desktop-contract";
import { createBbDesktopApi } from "@/test/bb-desktop-test-utils";
import {
  CHROME_ROW_HEIGHT_CLASS,
  MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS,
  MACOS_SIDEBAR_MIN_WIDTH,
  shouldReserveMacosTrafficLights,
} from "./bb-desktop";

const desktopInfo: BbDesktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
};

describe("desktop chrome geometry", () => {
  it("sizes chrome rows from the shared app chrome token", () => {
    expect(CHROME_ROW_HEIGHT_CLASS).toBe("h-(--bb-app-chrome-row-height)");
  });

  it("reserves macOS traffic-light space only when lights are visible", () => {
    const desktopApi = createBbDesktopApi(desktopInfo);

    expect(
      shouldReserveMacosTrafficLights({
        desktopInfo: desktopApi,
        windowState: { isFullScreen: false },
      }),
    ).toBe(true);
    expect(
      shouldReserveMacosTrafficLights({
        desktopInfo: desktopApi,
        windowState: { isFullScreen: true },
      }),
    ).toBe(false);
    expect(
      shouldReserveMacosTrafficLights({
        desktopInfo: null,
        windowState: { isFullScreen: false },
      }),
    ).toBe(false);
  });

  it("clears the same window-controls width for the title and the sidebar", () => {
    const controlsWidth = (value: string): number => {
      const match = /calc\((\d+)px ?\/ ?var\(--bb-desktop-zoom, ?1\)/.exec(
        value,
      );
      if (match === null) {
        throw new Error(`no zoom-locked width in "${value}"`);
      }
      return Number(match[1]);
    };

    expect(controlsWidth(MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS)).toBe(
      controlsWidth(MACOS_SIDEBAR_MIN_WIDTH),
    );
    expect(MACOS_COLLAPSED_TOP_LEFT_RESERVE_CLASS).toContain("-1rem)");
  });
});
