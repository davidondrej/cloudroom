// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbNavigate, PluginThreadListProps } from "@get-bb/plugin-sdk";
import {
  PluginThreadPanelNavigationProvider,
  resetActiveThreadPanelOpenerForTest,
  usePublishThreadPanelOpener,
  type PluginThreadPanelOpenHandler,
} from "@/components/plugin/plugin-thread-panel-navigation";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { pluginSdkAppImplementation } from "@/lib/plugin-sdk-app-impl";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import { resetDeprecatedAliasWarningsForTests } from "@/lib/plugin-sdk-deprecated-aliases";
import type { ResolvedReplacement } from "@/lib/plugin-slot-resolvers";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  usePluginSlots,
  type PluginThreadListSlot,
} from "@/lib/plugin-slots";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { serializePluginPanelParams } from "@/lib/plugin-json-value";
import { useThreadFileTabs } from "@/components/secondary-panel/useThreadFileTabs";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { PluginThreadList } from "./PluginThreadList";

function pluginReplacement(
  component: (props: PluginThreadListProps) => React.ReactNode,
): ResolvedReplacement<PluginThreadListSlot> {
  return {
    kind: "plugin",
    registration: {
      pluginId: "demo",
      generation: 1,
      id: "list",
      title: "Demo list",
      component,
    },
  };
}

function renderList(
  replacement: ResolvedReplacement<PluginThreadListSlot>,
  searchQuery = "",
) {
  const ui = (query: string) => (
    <MemoryRouter>
      <SidebarProvider>
        <PluginThreadList
          replacement={replacement}
          original={<div data-testid="bb-thread-list">bb thread list</div>}
          searchQuery={query}
          onNavigate={() => {}}
        />
      </SidebarProvider>
    </MemoryRouter>
  );
  const result = render(ui(searchQuery));
  return {
    ...result,
    rerenderWith: (query: string) => result.rerender(ui(query)),
  };
}

beforeEach(() => {
  resetDeprecatedAliasWarningsForTests();
});

afterEach(() => {
  cleanup();
  resetAllCrashedPluginSlotsForTest();
  resetActiveThreadPanelOpenerForTest();
  resetPluginSlotStoreForTest();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("PluginThreadList experimental_Original alias", () => {
  it("delegates to BB's list through the alias and warns once across renders", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    const { rerenderWith } = renderList(
      pluginReplacement(
        ({ experimental_Original: LegacyOriginal, searchQuery }) => {
          seen.push(searchQuery);
          return LegacyOriginal === undefined ? (
            <div>alias missing</div>
          ) : (
            <LegacyOriginal />
          );
        },
      ),
    );

    expect(screen.getByTestId("bb-thread-list")).toBeDefined();
    rerenderWith("needle");
    expect(screen.getByTestId("bb-thread-list")).toBeDefined();
    expect(seen).toEqual(["", "needle"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "experimental_Original is deprecated; use Original. Removed in bb 0.42",
    );
  });

  it("never warns for a list that reads Original", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderList(pluginReplacement(({ Original }) => <Original />));

    expect(screen.getByTestId("bb-thread-list")).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

// Use the host's actual SDK hook and replacement slot; no navigation-hook mock.
const { useBbNavigate } = pluginSdkAppImplementation;

function Pane({
  opener,
  focused,
}: {
  opener: PluginThreadPanelOpenHandler;
  focused: boolean;
}) {
  usePublishThreadPanelOpener(opener, focused);
  return null;
}

// Synthetic pane: action lookup is the host seam, while JSON validation and tab
// identity use the production helpers. This does not mount ThreadDetailView.
function RegisteredPane() {
  const { threadPanelActions } = usePluginSlots();
  const { openPluginPanel, orderedSecondaryFileTabs } = useThreadFileTabs({
    panelStateId: "sidebar-panel-test",
    syncThreadId: null,
    environmentId: null,
    storageFiles: undefined,
    terminalSessions: undefined,
  });
  usePublishThreadPanelOpener(({ pluginId, actionId, params, title }) => {
    const action = threadPanelActions.find(
      (candidate) =>
        candidate.pluginId === pluginId && candidate.id === actionId,
    );
    if (!action) return false;
    let paramsJson: string | null;
    try {
      paramsJson = serializePluginPanelParams(params);
    } catch {
      return false;
    }
    openPluginPanel({
      pluginId,
      actionId,
      paramsJson,
      title: title ?? action.title,
    });
    return true;
  }, true);
  return (
    <output data-testid="tabs">
      {JSON.stringify(orderedSecondaryFileTabs)}
    </output>
  );
}

function OpenPanelProbe({
  options = { actionId: "details", params: { item: 1 } },
}: {
  options?: Parameters<BbNavigate["openThreadPanel"]>[0];
}) {
  const { openThreadPanel } = useBbNavigate();
  return (
    <button
      type="button"
      onClick={(event) => {
        event.currentTarget.textContent = String(openThreadPanel(options));
      }}
    >
      Open panel
    </button>
  );
}

function clickOpenPanel() {
  const button = screen.getByRole("button", { name: "Open panel" });
  fireEvent.click(button);
  return button;
}

describe("sidebar panel opener boundary", () => {
  it("catches missing sidebar context: registered opens reuse one tab and invalid/unavailable actions decline", () => {
    setPluginSlotRegistrations(
      "demo",
      makePluginRegistrationSet({
        threadPanelActions: [
          { id: "details", title: "Details", component: () => null },
        ],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const pane = render(
      <QueryClientProvider client={queryClient}>
        <RegisteredPane />
      </QueryClientProvider>,
    );
    let options: Parameters<BbNavigate["openThreadPanel"]>[0] = {
      actionId: "details",
      params: { item: 1 },
    };
    const list = renderList(
      pluginReplacement(() => <OpenPanelProbe options={options} />),
    );
    const button = clickOpenPanel();
    expect(button.textContent).toBe("true");
    const firstTabs = screen.getByTestId("tabs").textContent;
    expect(JSON.parse(firstTabs ?? "[]")).toHaveLength(1);
    fireEvent.click(button);
    expect(button.textContent).toBe("true");
    expect(screen.getByTestId("tabs").textContent).toBe(firstTabs);

    for (const refused of [
      { actionId: "unavailable" },
      { actionId: "details", params: { invalid: Number.POSITIVE_INFINITY } },
    ]) {
      options = refused;
      list.rerenderWith("");
      fireEvent.click(button);
      expect(button.textContent).toBe("false");
      expect(screen.getByTestId("tabs").textContent).toBe(firstTabs);
    }
    pane.unmount();
    queryClient.clear();
  });

  it("catches a captured destination: the same mounted sidebar follows focus at invocation", () => {
    const left = vi.fn(() => true);
    const right = vi.fn(() => true);
    const panes = (focusLeft: boolean) => (
      <>
        <Pane opener={left} focused={focusLeft} />
        <Pane opener={right} focused={!focusLeft} />
      </>
    );
    const views = render(panes(true));
    renderList(pluginReplacement(() => <OpenPanelProbe />));
    const button = clickOpenPanel();
    expect(button.textContent).toBe("true");
    expect(left).toHaveBeenCalledTimes(1);
    expect(right).not.toHaveBeenCalled();

    // Only the pane tree re-renders; the sidebar keeps its original hook closure.
    views.rerender(panes(false));
    fireEvent.click(button);
    expect(button.textContent).toBe("true");
    expect(left).toHaveBeenCalledTimes(1);
    expect(right).toHaveBeenCalledTimes(1);
  });

  it("catches guessed or disposed destinations: no focused view returns false", () => {
    const opener = vi.fn(() => true);
    const pane = render(<Pane opener={opener} focused={false} />);
    renderList(pluginReplacement(() => <OpenPanelProbe />));
    const button = clickOpenPanel();
    expect(button.textContent).toBe("false");
    expect(opener).not.toHaveBeenCalled();

    pane.rerender(<Pane opener={opener} focused />);
    fireEvent.click(button);
    expect(button.textContent).toBe("true");
    pane.unmount();
    fireEvent.click(button);
    expect(button.textContent).toBe("false");
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it("catches caller identity spoofing: the slot supplies its own plugin id", () => {
    const opener = vi.fn(() => true);
    render(<Pane opener={opener} focused />);
    const options = { actionId: "details", pluginId: "other-plugin" };
    renderList(pluginReplacement(() => <OpenPanelProbe options={options} />));

    expect(clickOpenPanel().textContent).toBe("true");
    expect(opener).toHaveBeenCalledExactlyOnceWith({
      actionId: "details",
      pluginId: "demo",
    });
  });

  it("catches a blanket SDK fallback: other plugin surfaces remain refused or context-local", () => {
    const focused = vi.fn(() => true);
    const local = vi.fn(() => true);
    render(
      <MemoryRouter>
        <Pane opener={focused} focused />
        <PluginSlotMount pluginId="demo" slotKind="navPanel" slotId="page">
          <OpenPanelProbe />
        </PluginSlotMount>
      </MemoryRouter>,
    );
    expect(clickOpenPanel().textContent).toBe("false");
    expect(focused).not.toHaveBeenCalled();
    cleanup();

    render(
      <MemoryRouter>
        <Pane opener={focused} focused />
        <PluginThreadPanelNavigationProvider openThreadPanel={local}>
          <PluginSlotMount
            pluginId="demo"
            slotKind="threadPanelAction"
            slotId="details"
          >
            <OpenPanelProbe />
          </PluginSlotMount>
        </PluginThreadPanelNavigationProvider>
      </MemoryRouter>,
    );
    expect(clickOpenPanel().textContent).toBe("true");
    expect(local).toHaveBeenCalledTimes(1);
    expect(focused).not.toHaveBeenCalled();
  });
});
