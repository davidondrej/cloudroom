import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Session } from "electron";
import type { DesktopBrowserChanged } from "@cloudroom/host-daemon-contract";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  session: { fromPartition: () => ({}) },
  nativeImage: { createFromBuffer: () => ({}) },
}));

import { createDesktopBrowserBroker } from "../src/desktop-browser-broker.js";
import type {
  DesktopBrowserNativeTab,
  DesktopBrowserViewManager,
} from "../src/desktop-browser-view.js";

const THREAD_ID = "thr_23456789ab";
const PLUGIN_PANEL_ID = "plugin-panel:cloud-sandbox:cloud-machines:pane-1";

function nativeTab(tabId: string, threadId: string): DesktopBrowserNativeTab {
  return {
    tabId,
    threadId,
    url: "https://example.com",
    title: "Example",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    errorText: null,
    generation: "tab-generation",
    profile: { kind: "personal" },
    presentation: "reveal",
  };
}

function createFakeWindow() {
  return {
    webContents: {
      id: 7,
      isDestroyed: () => false,
      send: vi.fn(),
    },
    isDestroyed: () => false,
    focus: () => undefined,
    show: () => undefined,
    restore: () => undefined,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    contentView: {
      addChildView: () => undefined,
      removeChildView: () => undefined,
    },
  };
}

describe("desktop browser broker snapshots", () => {
  it("publishes snapshots only for real threads and keeps plugin-panel tabs local", () => {
    let tabs = [
      nativeTab("thread-tab", THREAD_ID),
      nativeTab("panel-tab", PLUGIN_PANEL_ID),
    ];
    let notifyTabsChanged: () => void = () => undefined;
    const manager: Pick<
      DesktopBrowserViewManager,
      "listTabs" | "subscribeAutomationTabs" | "profileSession" | "destroyAll"
    > = {
      listTabs: ({ threadId }) =>
        tabs.filter((tab) => threadId === null || tab.threadId === threadId),
      subscribeAutomationTabs: (listener) => {
        notifyTabsChanged = listener;
        return () => undefined;
      },
      profileSession: () => ({}) as Session,
      destroyAll: () => undefined,
    };
    const broker = createDesktopBrowserBroker({
      manager: manager as DesktopBrowserViewManager,
      product: "Chrome/1",
    });
    const events: DesktopBrowserChanged[] = [];
    broker.subscribe((event) => events.push(event));
    const window = createFakeWindow();

    broker.registerWindow(window as never);
    broker.setHostId("host_local");
    tabs = [
      { ...tabs[0]!, title: "Navigated" },
      { ...tabs[1]!, title: "Navigated" },
    ];
    notifyTabsChanged();

    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((event) => event.threadId))).toEqual(
      new Set([THREAD_ID]),
    );
    expect(
      events.flatMap((event) => event.tabs.map((tab) => tab.tabId)),
    ).not.toContain("panel-tab");
  });
});


describe("desktop browser broker window cleanup", () => {
  it.each([false, true])("releases a destroyed window with active lease: %s", async (withLease) => {
    const tab = nativeTab("thread-tab", THREAD_ID);
    const manager: Pick<DesktopBrowserViewManager, "listTabs" | "subscribeAutomationTabs"> = {
      listTabs: () => [tab],
      subscribeAutomationTabs: () => () => undefined,
    };
    const broker = createDesktopBrowserBroker({
      manager: manager as DesktopBrowserViewManager,
      product: "Chrome/1",
    });
    const window = createFakeWindow();
    const webContents = window.webContents;
    let destroyed = false;
    window.isDestroyed = () => destroyed;
    Object.defineProperty(window, "webContents", {
      get() {
        if (destroyed) throw new TypeError("Object has been destroyed");
        return webContents;
      },
    });
    broker.registerWindow(window);
    broker.setHostId("host_local");
    const target = broker.getTarget(webContents.id)!;
    if (withLease) {
      await broker.execute({
        type: "desktop.browser.acquire_control",
        ...target,
        threadId: THREAD_ID,
        tabIds: [tab.tabId],
        leaseId: "cleanup-lease",
        controllerLabel: "Cleanup test",
        expiresAt: Date.now() + 60_000,
      });
    }
    const registryChanged = vi.fn();
    broker.subscribeInstances(registryChanged);
    destroyed = true;
    expect(() => broker.releaseWindow(webContents.id)).not.toThrow();
    expect(broker.listInstances()).toEqual([]);
    expect(registryChanged).toHaveBeenCalledTimes(1);
    expect(() => broker.releaseWindow(webContents.id)).not.toThrow();
    broker.dispose();
  });
});

describe("desktop browser broker cleanup of gone resources", () => {
  it.each([
    ["release_control", "mine", { ok: true }],
    ["close_tab", "mine", { ok: true }],
    ["close_tab", "theirs", "Browser tab is outside the requested thread"],
  ] as const)("%s %s", async (action, id, expected) => {
    let tabs = [nativeTab("mine", THREAD_ID), nativeTab("theirs", "thr_other")];
    const subscribeAutomationTabs = vi.fn((_: () => void) => () => undefined);
    const listTabs = ({ threadId }: { threadId: string | null }) =>
      tabs.filter((tab) => threadId === null || tab.threadId === threadId);
    const manager = { listTabs, subscribeAutomationTabs, closeTab: vi.fn() };
    const broker = createDesktopBrowserBroker({ manager: manager as never, product: "Chrome/1" });
    broker.registerWindow(createFakeWindow() as never);
    const base = { ...broker.listInstances()[0]!, threadId: THREAD_ID, tabId: id, leaseId: "mine" };
    const lease = { tabIds: ["mine"], controllerLabel: "T", expiresAt: Date.now() + 9e4 };
    await broker.execute({ ...base, ...lease, type: "desktop.browser.acquire_control" });
    tabs = tabs.slice(1);
    subscribeAutomationTabs.mock.calls[0]![0](); // tab gone: lease revoked
    const run = broker.execute({ ...base, type: `desktop.browser.${action}` } as never);
    expect(await run.catch((error: Error) => error.message)).toEqual(expected);
    expect(manager.closeTab).not.toHaveBeenCalled();
  });
});

describe("desktop browser broker pages a lease opened over CDP (#1383)", () => {
  it.each([
    ["release_control", ["agent-page"]],
    ["stop", []],
    ["takeOver", []],
    ["expiry", ["agent-page"]],
  ] as const)("%s: closes only the expected CDP-opened pages", async (end, closed) => {
    const automation = { kind: "automation", id: "a" } as const;
    let tabs = [{ ...nativeTab("mine", THREAD_ID), profile: automation }, nativeTab("users-own", THREAD_ID)];
    const views = new Map<string, object>();
    const view = (tabId: string) => views.get(tabId) ?? views.set(tabId, { isDestroyed: () => false, getURL: () => "about:blank", getTitle: () => "", debugger: { on() {}, off() {}, isAttached: () => false } }).get(tabId)!;
    const manager = {
      listTabs: ({ threadId }: { threadId: string | null }) => tabs.filter((tab) => threadId === null || tab.threadId === threadId),
      getAutomationTabs: () => tabs.map((tab) => ({ tabId: tab.tabId, webContents: view(tab.tabId) })),
      subscribeAutomationTabs: () => () => undefined,
      createTab: () => tabs[tabs.push({ ...nativeTab("agent-page", THREAD_ID), profile: automation }) - 1]!,
      closeTab: vi.fn(({ tabId }: { tabId: string }) => void (tabs = tabs.filter((tab) => tab.tabId !== tabId))),
    };
    const broker = createDesktopBrowserBroker({ manager: manager as never, product: "Chrome/1" });
    const window = createFakeWindow();
    broker.registerWindow(window as never);
    broker.setHostId("host_local");
    const base = { ...broker.listInstances()[0]!, threadId: THREAD_ID, leaseId: "lease" };
    await broker.execute({ ...base, type: "desktop.browser.acquire_control", tabIds: ["mine"], controllerLabel: "T", expiresAt: Date.now() + (end === "expiry" ? 400 : 9e4) });
    const { wsEndpoint } = (await broker.execute({ ...base, type: "desktop.browser.open_connection", tabIds: ["mine"] })) as { wsEndpoint: string };
    const socket = new WebSocket(wsEndpoint);
    await new Promise((resolve) => socket.once("open", resolve));
    const reply = new Promise((resolve) => socket.once("message", resolve));
    socket.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } }));
    expect(String(await reply)).toContain("targetId");
    if (end === "takeOver") broker.takeOver(window.webContents.id, "agent-page");
    if (end === "expiry") await new Promise((resolve) => setTimeout(resolve, 500));
    const close = end === "release_control" ? { closeOpenedPages: true as const } : {};
    await broker.execute({ ...base, type: "desktop.browser.release_control", ...close });
    expect(manager.closeTab.mock.calls.map(([ref]) => ref.tabId)).toEqual(closed);
    socket.terminate();
    broker.dispose();
  });
});
