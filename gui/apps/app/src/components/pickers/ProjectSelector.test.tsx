// @vitest-environment jsdom

import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import * as gitlabHooks from "@/hooks/useGitlabConnection";
import { sdk } from "@/lib/sdk";
import { ProjectSelector } from "./ProjectSelector";

// Folder listings for the Windows path tests: path → listing, or "missing" when the host has no such folder.
const host = vi.hoisted(() => ({ platform: "win32", listings: new Map<string | null, unknown>() }));
vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [{ id: "host_pc", platform: host.platform }] }),
  // Off Windows, a name search for `C: Repo` finds that folder.
  useHostFolderSearch: (_hostId: string | null, search: string) => ({
    data: search === "C: Repo" ? { directory: "/home/me", entries: [{ kind: "directory", name: "C: Repo", path: "/home/me/C: Repo" }] } : undefined,
  }),
  useHostDirectory: (hostId: string | null, path: string | null) => {
    const listing = hostId ? host.listings.get(path) : undefined;
    return { data: listing === "missing" ? undefined : listing, isError: listing === "missing", isPlaceholderData: false };
  },
}));
const folder = (path: string) => ({ kind: "directory" as const, name: path.split("\\").pop() ?? path, path });

// The picker reads folders through React Query, so every render needs a client.
const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: createQueryClientTestHarness().wrapper });

const PROJECTS = [
  { id: "proj_alpha", name: "Alpha Web" },
  { id: "proj_bravo", name: "Bravo API" },
  { id: "proj_charlie", name: "Charlie Docs" },
  { id: "proj_delta", name: "Delta Mobile" },
  { id: "proj_echo", name: "Echo Infra" },
  { id: "proj_foxtrot", name: "Foxtrot Design" },
] as const;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ProjectSelector", () => {
  function pasteGitlab(ready: boolean, onAdd = vi.fn().mockResolvedValue("proj_existing")) {
    vi.spyOn(gitlabHooks, "useGitlabConnection").mockReturnValue({
      accountId: ready ? "account" : undefined, ready, state: undefined, busy: false,
      change: vi.fn(), open: vi.fn(), error: undefined,
    });
    render(<ProjectSelector projects={PROJECTS} value={null} onChange={() => {}}
      defaultOpen modal={false} createProject={{ onCreate: vi.fn(), suggestions: {
        hostId: "host_dev", repos: [], githubConnected: true, isLoading: false, addingKey: null, onAdd
      } }} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search projects" }), {
      target: { value: "https://gitlab.com/group/sub/project" },
    });
    return onAdd;
  }

  it("offers Cloudroom sign-in without probing the pasted private URL", async () => {
    const check = vi.spyOn(sdk.cloudroom, "gitlabCheck");
    pasteGitlab(false);
    expect(screen.getByRole("option", { name: /Sign in to Cloudroom/ })).toBeTruthy();
    await act(() => new Promise<void>(resolve => setTimeout(resolve, 450)));
    expect(check).not.toHaveBeenCalled();
  });

  it("adds a pasted project once when clicked twice during its access check", async () => {
    let resolve!: (value: { accessible: boolean }) => void;
    const checking = new Promise<{ accessible: boolean }>(done => { resolve = done; });
    vi.spyOn(sdk.cloudroom, "gitlabCheck").mockReturnValue(checking);
    const add = pasteGitlab(true);
    const row = screen.getByRole("option", { name: /gitlab.com\/group\/sub/ });
    fireEvent.click(row);
    fireEvent.click(row);
    resolve({ accessible: true });
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  });

  it("exposes the current project separately from keyboard highlight", () => {
    render(
      <ProjectSelector
        projects={PROJECTS}
        value="proj_charlie"
        onChange={() => {}}
        defaultOpen
        modal={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Project: Charlie Docs" }),
    ).toBeTruthy();
    const search = screen.getByRole("combobox", { name: "Search projects" });
    const alpha = screen.getByRole("option", { name: "Alpha Web" });
    const bravo = screen.getByRole("option", { name: "Bravo API" });
    const charlie = screen.getByRole("option", { name: "Charlie Docs" });
    expect(screen.queryByRole("option", { selected: true })).toBeNull();
    expect(charlie.getAttribute("aria-selected")).toBe("false");
    expect(charlie.getAttribute("aria-current")).toBe("true");

    // The current project is the first row; the rest keep their order.
    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(charlie.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(alpha.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(bravo.getAttribute("aria-selected")).toBe("true");
    expect(charlie.getAttribute("aria-current")).toBe("true");
  });

  it("shows search only when there are more than five projects", () => {
    const result = render(
      <ProjectSelector
        projects={PROJECTS.slice(0, 5)}
        value="proj_alpha"
        onChange={() => {}}
        defaultOpen
        modal={false}
      />,
    );

    expect(
      screen.queryByRole("combobox", { name: "Search projects" }),
    ).toBeNull();

    result.rerender(
      <ProjectSelector
        projects={PROJECTS}
        value="proj_alpha"
        onChange={() => {}}
        defaultOpen
        modal={false}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Search projects" }),
    ).toBeTruthy();
  });

  it("fuzzy-matches project names case-insensitively and selects the match", () => {
    const onChange = vi.fn();
    render(
      <ProjectSelector
        projects={PROJECTS}
        value="proj_alpha"
        onChange={onChange}
        defaultOpen
        modal={false}
      />,
    );

    fireEvent.change(
      screen.getByRole("combobox", { name: "Search projects" }),
      { target: { value: "CD" } },
    );

    expect(screen.queryByRole("option", { name: "Alpha Web" })).toBeNull();
    expect(screen.getByRole("option", { name: "Charlie Docs" })).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Search projects" }),
      { key: "Enter" },
    );

    expect(onChange).toHaveBeenCalledWith("proj_charlie");
    expect(screen.queryByRole("dialog", { name: "Project" })).toBeNull();
  });

  it("keeps keyboard selection for short project lists", () => {
    const onChange = vi.fn();
    render(
      <ProjectSelector
        projects={PROJECTS.slice(0, 5)}
        value="proj_alpha"
        onChange={onChange}
        defaultOpen
        modal={false}
      />,
    );

    const command = document.querySelector<HTMLElement>("[cmdk-root]");
    expect(command).not.toBeNull();
    expect(document.activeElement).toBe(command);

    if (command === null) return;
    expect(screen.queryByRole("option", { selected: true })).toBeNull();
    fireEvent.keyDown(command, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(command, { key: "ArrowDown" });
    fireEvent.keyDown(command, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("proj_alpha");
  });

  it("keeps project actions visible and resets search after closing", () => {
    const onCreate = vi.fn();
    render(
      <ProjectSelector
        projects={PROJECTS}
        value={null}
        onChange={() => {}}
        allowNoProject
        createProject={{ onCreate }}
        defaultOpen
        modal={false}
      />,
    );

    expect(
      screen
        .getByRole("option", { name: "No project" })
        .getAttribute("aria-current"),
    ).toBe("true");
    fireEvent.change(
      screen.getByRole("combobox", { name: "Search projects" }),
      { target: { value: "missing" } },
    );

    expect(screen.getByText("No projects found")).toBeTruthy();
    expect(screen.getByRole("option", { name: "New project" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "No project" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: "New project" }));
    expect(onCreate).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Project: Work in a project" }),
    );
    expect(
      screen.getByRole<HTMLInputElement>("combobox", {
        name: "Search projects",
      }).value,
    ).toBe("");
    expect(screen.getByRole("option", { name: "Alpha Web" })).toBeTruthy();
    expect(screen.queryByRole("option", { selected: true })).toBeNull();
  });

  it("shows only the actions for an empty list", () => {
    render(
      <ProjectSelector
        projects={[]}
        value={null}
        onChange={() => {}}
        allowNoProject
        createProject={{ onCreate: () => {} }}
        defaultOpen
        modal={false}
      />,
    );

    expect(document.querySelectorAll("[cmdk-group]")).toHaveLength(0);
    expect(document.querySelectorAll("[cmdk-item]")).toHaveLength(2);
    expect(screen.queryByRole("option", { selected: true })).toBeNull();
  });

  it("on Windows, Enter on a pasted drive path adds only that exact folder (#2127)", () => {
    host.platform = "win32";
    host.listings.clear();
    host.listings.set("C:\\code\\", { directory: "C:\\code", entries: [folder("C:\\code\\app-old")] });
    host.listings.set("C:\\nope\\", "missing");
    const onAdd = vi.fn(async () => "proj_new");
    const open = () => {
      cleanup();
      render(
        <ProjectSelector
          projects={PROJECTS}
          value={null}
          onChange={() => {}}
          allowNoProject
          createProject={{ onCreate: () => {}, suggestions: { hostId: "host_pc", repos: [], githubConnected: true, isLoading: false, addingKey: null, onAdd } }}
          defaultOpen
          modal={false}
        />,
      );
      const search = screen.getByRole("combobox", { name: "Search projects" });
      return { search, type: (value: string) => fireEvent.change(search, { target: { value } }) };
    };

    // With no home listing yet, the empty state points Windows users at pasting a path.
    let picker = open();
    picker.type("zzz");
    expect(screen.getByText("Nothing matches. Paste a folder path like C:\\code\\app.")).toBeTruthy();
    // A missing folder says so.
    picker.type("C:\\nope\\x");
    expect(screen.getByText("No folder at C:\\nope\\")).toBeTruthy();
    // `app` is missing: the prefix match `app-old` shows, but Enter doesn't add it.
    picker.type('"C:\\code\\app"');
    expect(screen.getByRole("option", { name: /app-old/ }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(picker.search, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();

    // With `App` there too, `app-old` still can't be added, even by moving to it.
    host.listings.set("C:\\code\\", { directory: "C:\\code", entries: [folder("C:\\code\\app-old"), folder("C:\\code\\App")] });
    picker = open();
    picker.type("C:\\code\\app");
    expect(screen.getByRole("option", { name: /app-old/ }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(picker.search, { key: "ArrowDown" });
    fireEvent.keyDown(picker.search, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();
    // The exact folder (any case) is the one Enter adds.
    picker = open();
    picker.type("C:\\code\\app");
    fireEvent.keyDown(picker.search, { key: "Enter" });
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ source: "mac", path: "C:\\code\\App" }));

    // Off Windows nothing changes: `C:\ Repo` is a name search, as before.
    host.platform = "darwin";
    picker = open();
    picker.type("C:\\ Repo");
    expect(screen.getByRole("option", { name: /C: Repo/ })).toBeTruthy();
  });

  it("keeps the search fixed while the project results scroll", () => {
    render(
      <ProjectSelector
        projects={Array.from({ length: 20 }, (_, index) => ({
          id: `proj_${index}`,
          name: `Project ${index}`,
        }))}
        value="proj_0"
        onChange={() => {}}
        defaultOpen
        modal={false}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Project" });
    expect(dialog.className).toContain(
      "max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))]",
    );
    expect(dialog.className).toContain("overflow-hidden");

    const list = document.querySelector<HTMLElement>("[cmdk-list]");
    expect(list).not.toBeNull();
    expect(list?.className).toContain("overflow-y-auto");
    expect(list?.className).toContain("overscroll-contain");

    if (list === null) return;
    list.scrollTop = 120;
    fireEvent.change(
      screen.getByRole("combobox", { name: "Search projects" }),
      { target: { value: "Project 19" } },
    );
    expect(list.scrollTop).toBe(0);
  });
});
