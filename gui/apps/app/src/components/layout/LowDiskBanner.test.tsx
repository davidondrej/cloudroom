// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemWorktreeStorageResponse } from "@cloudroom/server-contract";
import { LowDiskBanner } from "./LowDiskBanner";

const storage = vi.hoisted(() => ({
  data: {} as SystemWorktreeStorageResponse,
}));
vi.mock("@/hooks/queries/system-queries", () => ({
  useWorktreeStorage: () => storage,
}));

afterEach(cleanup);

const ARCHIVE = "Archive finished threads to free space.";
const SAFE = "Cloud threads are not affected.";

describe("LowDiskBanner", () => {
  it.each([
    ["Studio Mac", 12e6, "Studio Mac", SAFE],
    [null, 999e6, "the computer running Cloudroom", SAFE],
    [undefined, 1e9, "the computer running Cloudroom", ARCHIVE],
    ["Studio Mac", null, "Studio Mac", ARCHIVE],
  ] as const)("%s, worktrees %s", (computerName, usedBytes, disk, advice) => {
    storage.data = { computerName, freeBytes: 4e9, usedBytes, low: true };
    render(<LowDiskBanner />);
    const text = screen.getByRole("alert").textContent;
    expect(text).toContain(`The disk on ${disk} is almost full: 4.0 GB free.`);
    expect(text).toContain(advice);
  });
});
