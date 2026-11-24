// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadListEntry } from "@cloudroom/test-helpers/domain-fixtures";
import { SubagentBar } from "./SubagentBar";

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useStopThread: () => ({ mutate: vi.fn() }),
}));

afterEach(cleanup);

const child = (
  title: string,
  state: "working" | "waiting" | "done" | "failed",
  updatedAt = 0,
) =>
  makeThreadListEntry({
    id: `thr_${title}`,
    title,
    parentThreadId: "thr_parent",
    updatedAt,
    status: state === "failed" ? "error" : state === "done" ? "idle" : "active",
    hasPendingInteraction: state === "waiting",
    runtime: {
      displayStatus:
        state === "failed" ? "error" : state === "done" ? "idle" : "active",
      hostReconnectGraceExpiresAt: null,
    },
  });

describe("SubagentBar", () => {
  it("renders nothing without subagents, and ignores forks", () => {
    const fork = { ...child("fork", "working"), originKind: "fork" as const };
    const { container } = render(<SubagentBar childThreads={[fork]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows live agents as pills, newest finished as chips, and folds the rest", () => {
    render(
      <SubagentBar
        childThreads={[
          child("sidebar", "working"),
          child("settings", "waiting"),
          child("dialogs", "done", 1),
          child("hooks", "done", 2),
          child("plugins", "failed", 3),
          child("web pages", "done", 4),
        ]}
      />,
    );
    expect(screen.getByText("needs you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop all" })).toBeTruthy();
    // Newest three finished stay visible; the oldest folds into "+1".
    for (const name of ["web pages", "plugins", "hooks"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.queryByText("dialogs")).toBeNull();
    expect(
      screen.getByRole("button", { name: "1 more finished agent" }),
    ).toBeTruthy();
  });

  it("keeps an agent whose computer is offline live, not done", () => {
    const offline = makeThreadListEntry({
      ...child("sidebar", "working"),
      runtime: {
        displayStatus: "waiting-for-host",
        hostReconnectGraceExpiresAt: null,
      },
    });
    render(<SubagentBar childThreads={[offline]} />);
    expect(screen.getByRole("link", { name: "sidebar, working" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop all" })).toBeTruthy();
  });

  it("drops Stop all once every agent is back", () => {
    render(<SubagentBar childThreads={[child("sidebar", "done")]} />);
    expect(screen.queryByRole("button", { name: "Stop all" })).toBeNull();
  });
});
