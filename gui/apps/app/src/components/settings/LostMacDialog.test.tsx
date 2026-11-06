// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";
import { LostMacDialog } from "./YourComputers";

vi.mock("@/hooks/useDesktopUpdateInfo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useDesktopUpdateInfo")>()),
  useDesktopUpdateInfo: vi.fn(),
}));

function renderDialog(retryUntil: number | null) {
  const reconnectComputer = vi.fn(async () => {});
  vi.mocked(useDesktopUpdateInfo).mockReturnValue({
    desktopApi: { reconnectComputer, openComputer: vi.fn(async () => {}) } as never,
    desktopInfo: {
      computers: { list: [], viewing: null, fallback: { handle: "air", name: "MacBook Air", back: false, retryUntil } },
    } as never,
    isDesktop: true,
  });
  render(<LostMacDialog />);
  return reconnectComputer;
}

describe("LostMacDialog", () => {
  afterEach(cleanup);

  it("counts down and sends the user's answer", () => {
    const reconnect = renderDialog(Date.now() + 18_500);
    expect(screen.getByText("Lost MacBook Air")).toBeDefined();
    expect(screen.getByText(/in 18 seconds/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Keep trying" }));
    fireEvent.click(screen.getByRole("button", { name: /now$/ }));
    expect(reconnect.mock.calls).toEqual([[true], [false]]);
  });

  it("stays hidden once the app stops trying", () => {
    renderDialog(null);
    expect(screen.queryByText("Lost MacBook Air")).toBeNull();
  });
});
