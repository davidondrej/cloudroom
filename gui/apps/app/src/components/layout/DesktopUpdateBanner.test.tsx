// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitForWindowsBanner, publishBannerHeight } from "./DesktopUpdateBanner";

const status = vi.hoisted(() => ({ value: null as { gitMissing?: boolean } | null }));
vi.mock("@/lib/use-async-atom-value", () => ({ useAsyncAtomValue: () => status.value }));

const HEIGHT = "--bb-update-banner-height";
const banner = (height: number) => {
  const element = document.createElement("div");
  Object.defineProperty(element, "offsetHeight", { value: height });
  return element;
};

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty(HEIGHT);
});

describe("app-wide banners", () => {
  it("offsets pinned controls by every banner shown", () => {
    const stopUpdate = publishBannerHeight(banner(48));
    const stopGit = publishBannerHeight(banner(40));
    expect(document.documentElement.style.getPropertyValue(HEIGHT)).toBe("88px");
    stopUpdate?.();
    expect(document.documentElement.style.getPropertyValue(HEIGHT)).toBe("40px");
    stopGit?.();
    expect(document.documentElement.style.getPropertyValue(HEIGHT)).toBe("");
  });

  it("asks for Git for Windows only while it is missing", () => {
    status.value = { gitMissing: true };
    render(<GitForWindowsBanner pinned={false} />);
    expect(screen.getByRole("alert").textContent).toContain("Cloudroom needs Git for Windows.");
    expect(screen.getByRole("button", { name: "Download Git" })).toBeTruthy();
    expect(document.documentElement.style.getPropertyValue(HEIGHT)).toBe("");
    cleanup();
    status.value = { gitMissing: false };
    render(<GitForWindowsBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
