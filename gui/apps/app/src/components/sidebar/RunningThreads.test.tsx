// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeThreadListEntry } from "@cloudroom/test-helpers/domain-fixtures";
import { RunningThreads } from "./RunningThreads";

afterEach(cleanup);

describe("Running threads", () => {
  it("renders hidden children as independent links with their absent parent's link", () => {
    render(
      <RunningThreads
        threads={[
          makeThreadListEntry({
            id: "thr_child",
            title: "Remote worker",
            projectId: "remote",
            parentThreadId: "thr_absent",
            visibility: "hidden",
            status: "active",
          }),
          makeThreadListEntry({
            id: "thr_root",
            title: "Other project",
            projectId: "other",
            status: "starting",
          }),
        ]}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Running threads" }),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Remote worker Working" })
        .getAttribute("href"),
    ).toBe("/projects/remote/threads/thr_child");
    expect(
      screen
        .getByRole("link", { name: "Parent of Remote worker" })
        .getAttribute("href"),
    ).toBe("/threads/thr_absent");
    expect(
      screen.getByRole("link", { name: "Other project Starting" }),
    ).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("removes settled work when the shared inventory changes", () => {
    const view = render(
      <RunningThreads
        threads={[makeThreadListEntry({ title: "Worker", status: "active" })]}
      />,
    );
    view.rerender(<RunningThreads threads={[]} />);
    expect(
      screen.queryByRole("region", { name: "Running threads" }),
    ).toBeNull();
  });
});
