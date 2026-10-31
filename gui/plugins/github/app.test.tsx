// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { act } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

describe("GitHub app navigation", () => {
  it("opens issue details in the URL-backed page instead of a fixed tab", async () => {
    const panel = app.navPanels[0]!;
    expect(panel.fixedTabs).toBeUndefined();

    const slot = renderSlot(
      panel,
      { subPath: "issues" },
      {
        rpc: {
          listItems: () => ({
            items: [
              {
                repo: "get-bb/bb",
                number: 42,
                kind: "issue",
                title: "Route-backed issue",
                state: "OPEN",
                author: "octocat",
                authorAssociation: "OWNER",
                labels: [],
                assignees: [],
                url: "https://github.com/get-bb/bb/issues/42",
                body: "",
                updatedAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          }),
          listLinks: () => ({ links: {} }),
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [{ repo: "get-bb/bb", projectId: null }],
            lastSyncedAt: null,
          }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    );

    (await slot.findByText("Route-backed issue")).click();
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "github",
      options: { subPath: "issues/get-bb/bb/42" },
    });
    slot.lifecycle.unmount();
  });

  it("makes outside authors' issues and PRs open before an agent can start", async () => {
    const item = (
      kind: "issue" | "pr",
      number: number,
      author: string,
      authorAssociation: string,
    ) => ({
      repo: "acme/widgets",
      number,
      kind,
      title: `${kind} by ${author}`,
      state: "OPEN",
      author,
      authorAssociation,
      labels: [],
      assignees: [],
      url: `https://github.com/acme/widgets/${kind === "pr" ? "pull" : "issues"}/${number}`,
      body: "",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    const items = [
      item("issue", 1, "alice", "MEMBER"),
      item("issue", 2, "mallory", "NONE"),
      item("pr", 3, "eve", "CONTRIBUTOR"),
    ];
    const rpc = {
      listItems: (input: unknown) => ({
        items: items.filter(
          (entry) => entry.kind === (input as { kind?: string }).kind,
        ),
      }),
      listLinks: () => ({ links: {} }),
      status: () => ({
        ghOk: true,
        ghState: "ready",
        ghError: null,
        repos: [{ repo: "acme/widgets", projectId: null }],
        lastSyncedAt: null,
      }),
      viewer: () => ({ login: "octocat" }),
      startWork: () => ({ threadId: "thr-started" }),
      startReview: () => ({ threadId: "thr-started" }),
      getIssue: () => ({
        issue: {
          ...item("issue", 2, "mallory", "NONE"),
          comments: [],
        },
      }),
    };
    const panel = app.navPanels[0]!;

    const issues = renderSlot(panel, { subPath: "issues" }, { rpc });
    expect(await issues.findByText("Start")).toBeTruthy();
    await act(async () => issues.getByText("View").click());
    expect(issues.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "github",
      options: { subPath: "issues/acme/widgets/2" },
    });
    issues.lifecycle.unmount();

    const pulls = renderSlot(panel, { subPath: "pulls" }, { rpc });
    const viewPull = await pulls.findByText("View");
    await act(async () => viewPull.click());
    expect(pulls.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "github",
      options: { subPath: "pulls/acme/widgets/3" },
    });
    expect(pulls.queryByText("Review")).toBeNull();
    pulls.lifecycle.unmount();

    const detail = renderSlot(
      panel,
      { subPath: "issues/acme/widgets/2" },
      { rpc },
    );
    expect(
      await detail.findByText(/@mallory is not a member of acme\/widgets\./),
    ).toBeTruthy();
    detail.lifecycle.unmount();

    for (const slot of [issues, pulls, detail]) {
      expect(
        slot.rpcCalls.filter(
          (call) =>
            call.method === "startWork" || call.method === "startReview",
        ),
      ).toEqual([]);
    }
  });

  it("uses the standard responsive page inset for the main panel", () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listItems: () => ({ items: [] }),
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [],
            lastSyncedAt: null,
          }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    );

    expect(slot.container.firstElementChild?.className).toContain("p-4 md:p-5");
    expect(slot.container.firstElementChild?.className).not.toContain("p-3");
    slot.lifecycle.unmount();
  });

  it("keeps removed pull-request files out of live workspace navigation", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr-1", params: null },
      {
        rpc: {
          pullForThread: () => ({
            pull: {
              repo: "get-bb/bb",
              number: 42,
              environmentId: "env-1",
            },
          }),
          getPull: () => ({
            pull: {
              repo: "get-bb/bb",
              number: 42,
              title: "Navigation fix",
              state: "OPEN",
              author: "octocat",
              authorAssociation: "OWNER",
              body: "",
              url: "https://github.com/get-bb/bb/pull/42",
              createdAt: "2026-08-20T00:00:00.000Z",
              updatedAt: "2026-08-20T00:00:00.000Z",
              baseRefName: "main",
              headRefName: "fix-navigation",
              additions: 1,
              deletions: 1,
              changedFiles: 2,
              labels: [],
              assignees: [],
              reviewDecision: "",
              mergeStateStatus: "CLEAN",
              reviewRequests: [],
              checks: [],
              comments: [],
              reviews: [],
              reviewThreads: [],
              files: [
                {
                  path: "removed.ts",
                  status: "removed",
                  additions: 0,
                  deletions: 1,
                  patch: "@@ -1 +0,0 @@\n-removed",
                },
                {
                  path: "modified.ts",
                  status: "modified",
                  additions: 1,
                  deletions: 0,
                  patch: "@@ -0,0 +1 @@\n+added",
                },
              ],
            },
          }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    );

    await act(async () => {});
    expect(slot.queryByText(/is not a member of/)).toBeNull();
    const removedFile = slot.getByText("removed.ts");
    const modifiedFile = slot.getByText("modified.ts");
    expect(removedFile.closest("a")).toBeNull();
    expect(modifiedFile.closest("a")?.getAttribute("href")).toBe(
      "./modified.ts",
    );

    const diffToggle = removedFile.parentElement?.querySelector("button");
    if (!(diffToggle instanceof HTMLButtonElement)) {
      throw new Error("removed file diff toggle was not rendered");
    }
    expect(diffToggle.getAttribute("aria-label")).toBe(
      "Expand removed.ts diff",
    );
    await act(async () => diffToggle.click());
    const diff = slot.getByTestId("bb-diff");
    expect(diff.getAttribute("data-path")).toBe("removed.ts");
    expect(diffToggle.getAttribute("aria-label")).toBe(
      "Collapse removed.ts diff",
    );
    slot.lifecycle.unmount();
  });
});
