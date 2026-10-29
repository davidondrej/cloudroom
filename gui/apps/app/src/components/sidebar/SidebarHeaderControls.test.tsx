// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@cloudroom/shared-ui/tooltip";
import { SIDEBAR_CONTROL_STATE_CLASS } from "./sidebarRowClasses";
import {
  SidebarHeaderActionsProvider,
  SidebarHeaderControls,
  SidebarSectionMenuItems,
} from "./SidebarHeaderControls";
import type { SidebarSectionId } from "@cloudroom/client-core";
import {
  sidebarChronologicalSortAtom,
  sidebarOrganizationModeAtom,
  sidebarSectionSortsAtom,
  sidebarSortDirectionAtom,
} from "./sidebarCollapsedAtoms";

const viewport = vi.hoisted(() => ({ compact: false }));
vi.mock("@cloudroom/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => viewport.compact,
}));

afterEach(() => {
  cleanup();
  viewport.compact = false;
});

function setup(
  label = "Pinned",
  section = false,
  sectionId: SidebarSectionId = "pinned",
) {
  const store = createStore();
  store.set(sidebarOrganizationModeAtom, "project");
  store.set(sidebarChronologicalSortAtom, "updated");
  store.set(sidebarSortDirectionAtom, "default");
  store.set(sidebarSectionSortsAtom, {});
  const newThread = vi.fn();
  const newProject = vi.fn();
  render(
    <Provider store={store}>
      <TooltipProvider>
        <SidebarHeaderActionsProvider
          value={{ onNewProject: newProject }}
        >
          <SidebarHeaderControls
            label={label}
            sectionId={sectionId}
            onNewThread={newThread}
          >
            {section && (
              <SidebarSectionMenuItems onRename={vi.fn()} onRemove={vi.fn()} />
            )}
          </SidebarHeaderControls>
        </SidebarHeaderActionsProvider>
      </TooltipProvider>
    </Provider>,
  );
  return { store, newThread, newProject };
}

async function openMenu(label = "Pinned") {
  fireEvent.keyDown(screen.getByRole("button", { name: `${label} actions` }), {
    key: "Enter",
  });
  await screen.findByRole("menuitem", { name: "New project" });
}

async function openSubmenu(label: string) {
  fireEvent.keyDown(screen.getByRole("menuitem", { name: label }), {
    key: "ArrowRight",
  });
}

describe("sidebar header controls", () => {
  it("keeps the primary before overflow and applies the shared control state", async () => {
    const { newThread } = setup();
    const primary = screen.getByRole("button", {
      name: "New thread in Pinned",
    });
    expect(primary.nextElementSibling?.getAttribute("aria-label")).toBe(
      "Pinned actions",
    );
    for (const control of [primary, primary.nextElementSibling]) {
      for (const token of SIDEBAR_CONTROL_STATE_CLASS.split(" ")) {
        expect(control?.classList.contains(token)).toBe(true);
      }
      expect(control?.classList.contains("hover:bg-sidebar-accent")).toBe(
        false,
      );
      expect(control?.classList.contains("hover:text-foreground")).toBe(false);
    }
    fireEvent.click(primary);
    expect(newThread).toHaveBeenCalledOnce();
    await openMenu();
    expect(primary.nextElementSibling?.getAttribute("data-state")).toBe("open");
  });

  it("preserves creation callbacks and separates section editing/removal", async () => {
    const { newProject } = setup("Review", true);
    await openMenu("Review");
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "New project",
      "Organize",
      "Sort by",
      "Rename",
      "Remove",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(3);
    fireEvent.click(screen.getByRole("menuitem", { name: "New project" }));
    expect(newProject).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: "New project" }),
      ).toBeNull(),
    );
  });

  it("exposes an exclusive Organize choice and closes after selection", async () => {
    const { store } = setup();
    await openMenu();
    await openSubmenu("Organize");
    const machine = await screen.findByRole("menuitemradio", {
      name: "By machine",
    });
    expect(
      screen
        .getByRole("menuitemradio", { name: "By project" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(machine);
    expect(store.get(sidebarOrganizationModeAtom)).toBe("machine");
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitemradio", { name: "By machine" }),
      ).toBeNull(),
    );
  });

  it("toggles sort direction for only its own section and resets direction for a different field", async () => {
    const { store } = setup("Threads", false, "threads");
    const threadsSort = () => store.get(sidebarSectionSortsAtom).threads;
    await openMenu("Threads");
    await openSubmenu("Sort by");
    expect(screen.queryByRole("menuitemradio", { name: "Drag order" })).toBeNull();
    const updated = await screen.findByRole("menuitemradio", {
      name: "Updated at, descending. Sort ascending",
    });
    fireEvent.click(updated);
    expect(threadsSort()).toEqual({ sort: "updated", direction: "ascending" });
    fireEvent.click(
      screen.getByRole("menuitemradio", {
        name: "Updated at, ascending. Sort descending",
      }),
    );
    expect(threadsSort()).toEqual({ sort: "updated", direction: "descending" });
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Alphabetical" }),
    );
    expect(threadsSort()).toEqual({ sort: "alpha", direction: "ascending" });
    expect(Object.keys(store.get(sidebarSectionSortsAtom))).toEqual([
      "threads",
    ]);
    expect(store.get(sidebarChronologicalSortAtom)).toBe("updated");
    expect(
      screen
        .getByRole("menuitemradio", {
          name: "Alphabetical, ascending. Sort descending",
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("announces compact sort direction and resets the nested page after closing", async () => {
    viewport.compact = true;
    const { store } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Pinned actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sort by" }));
    expect(
      (
        await screen.findByRole("menuitemradio", { name: "Drag order" })
      ).getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(
      await screen.findByRole("menuitemradio", {
        name: /Updated at\s*, descending\. Sort ascending/,
      }),
    );
    expect(store.get(sidebarSectionSortsAtom).pinned).toEqual({
      sort: "updated",
      direction: "ascending",
    });
    expect(
      screen
        .getByRole("menuitemradio", {
          name: /Updated at\s*, ascending\. Sort descending/,
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Back" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Organize" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Custom" }));
    expect(store.get(sidebarOrganizationModeAtom)).toBe("chronological");
    fireEvent.click(screen.getByRole("button", { name: "Pinned actions" }));
    expect(
      await screen.findByRole("menuitem", { name: "New project" }),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Back" })).toBeNull();
  });
});
