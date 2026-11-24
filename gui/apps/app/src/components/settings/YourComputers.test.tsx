// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { RoomDesktopInfo } from "@cloudroom/desktop-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewingMacCard } from "./YourComputers";

const desktop = vi.hoisted(() => ({ platform: "windows" as RoomDesktopInfo["platform"] }));

vi.mock("@/hooks/useDesktopUpdateInfo", () => ({
  DESKTOP_DOWNLOAD_URL: "https://example.test",
  useDesktopUpdateInfo: () => ({
    desktopApi: { openComputer: vi.fn() },
    desktopInfo: {
      platform: desktop.platform,
      computers: {
        list: [{ handle: "h1", name: "c3a-xps15", online: true, self: true }],
        viewing: null,
        fallback: null,
      },
    },
    isDesktop: true,
  }),
}));

afterEach(cleanup);

describe("ViewingMacCard", () => {
  it.each(["windows", "macos", "linux"] as const)("shows the %s logo for this computer", (platform) => {
    desktop.platform = platform;
    const { container } = render(<ViewingMacCard />);
    expect(container.querySelector("[data-os]")?.getAttribute("data-os")).toBe(platform);
  });
});
