import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  session: { fromPartition: () => ({}) },
  nativeImage: { createFromBuffer: () => ({}) },
}));

import { createDesktopBrowserBroker } from "../src/desktop-browser-broker.js";
import type { DesktopBrowserViewManager } from "../src/desktop-browser-view.js";
import type { BrowserImportService } from "../src/browser-import/browser-import.js";

function createFakeManager(
  profileSession: DesktopBrowserViewManager["profileSession"],
  listTabs: DesktopBrowserViewManager["listTabs"] = () => [],
) {
  const manager: Pick<
    DesktopBrowserViewManager,
    "listTabs" | "subscribeAutomationTabs" | "profileSession" | "destroyAll"
  > = {
    listTabs,
    subscribeAutomationTabs: () => () => undefined,
    profileSession,
    destroyAll: () => undefined,
  };
  return manager as DesktopBrowserViewManager;
}

function createFakeWindow() {
  return {
    webContents: {
      id: 7,
      isDestroyed: () => false,
      send: () => undefined,
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

describe("desktop browser broker cookie import commands", () => {
  it("lists sources and imports only into the personal profile", async () => {
    const personalSession = { cookies: {} } as unknown as Session;
    const automationSession = { cookies: {} } as unknown as Session;
    const profileSession = vi.fn((profile: { kind: string }) =>
      profile.kind === "personal" ? personalSession : automationSession,
    );
    const browserImport: BrowserImportService = {
      listSources: vi.fn<BrowserImportService["listSources"]>(async () => [
        { id: "firefox", name: "Firefox", profiles: [] },
      ]),
      importCookies: vi.fn<BrowserImportService["importCookies"]>(async () => ({
        ok: true,
        imported: 1,
        skipped: 0,
        skippedDomains: [],
      })),
    };
    const broker = createDesktopBrowserBroker({
      manager: createFakeManager(profileSession),
      product: "Chrome/1",
      browserImport,
    });
    const window = createFakeWindow();
    broker.registerWindow(window as never);
    const [instance] = broker.listInstances();
    await expect(
      broker.execute({
        type: "desktop.browser.list_import_sources",
        instanceId: instance.instanceId,
        generation: instance.generation,
      }),
    ).resolves.toEqual({
      sources: [{ id: "firefox", name: "Firefox", profiles: [] }],
    });
    const importInto = (profile: { kind: "personal" } | { kind: "automation"; id: string }) =>
      broker.execute({
        type: "desktop.browser.import_cookies",
        instanceId: instance.instanceId,
        generation: instance.generation,
        sourceId: "firefox",
        sourceProfileDirectory: "Profiles/p1",
        profile,
      });
    await expect(importInto({ kind: "personal" })).resolves.toEqual({
      ok: true,
      imported: 1,
      skipped: 0,
      skippedDomains: [],
    });
    expect(browserImport.importCookies).toHaveBeenCalledWith(
      { sourceId: "firefox", sourceProfileDirectory: "Profiles/p1" },
      personalSession,
    );
    await expect(
      importInto({ kind: "automation", id: "agent" }),
    ).rejects.toThrow("Cookies can only be imported into the personal browser");
    expect(browserImport.importCookies).toHaveBeenCalledTimes(1);
    await expect(
      broker.execute({
        type: "desktop.browser.import_cookies",
        instanceId: instance.instanceId,
        generation: "stale",
        sourceId: "firefox",
        sourceProfileDirectory: "Profiles/p1",
        profile: { kind: "personal" },
      }),
    ).rejects.toThrow(/unavailable or has reconnected/);
    broker.dispose();
  });

  it("rejects import commands when no import service is wired", async () => {
    const broker = createDesktopBrowserBroker({
      manager: createFakeManager(() => {
        throw new Error("unused");
      }),
      product: "Chrome/1",
    });
    broker.registerWindow(createFakeWindow() as never);
    const [instance] = broker.listInstances();
    await expect(
      broker.execute({
        type: "desktop.browser.list_import_sources",
        instanceId: instance.instanceId,
        generation: instance.generation,
      }),
    ).rejects.toThrow("Browser cookie import is unavailable");
    broker.dispose();
  });
});

describe("desktop browser personal tabs", () => {
  it("never captures or leases a personal tab", async () => {
    const personalTab = {
      tabId: "personal-tab",
      threadId: "thr_test",
      generation: "g1",
      url: "https://mail.example",
      title: "Inbox",
      profile: { kind: "personal" as const },
      presentation: "reveal" as const,
    };
    const manager = createFakeManager(
      () => {
        throw new Error("unused");
      },
      () => [personalTab] as never,
    );
    const captureTab = vi.fn();
    Object.assign(manager, { captureTab });
    const broker = createDesktopBrowserBroker({ manager, product: "Chrome/1" });
    broker.registerWindow(createFakeWindow() as never);
    const [instance] = broker.listInstances();
    const scope = {
      instanceId: instance.instanceId,
      generation: instance.generation,
      threadId: "thr_test",
    };
    await expect(
      broker.execute({
        type: "desktop.browser.capture_tab",
        ...scope,
        tabId: "personal-tab",
      }),
    ).rejects.toThrow("Agents cannot capture or control personal browser tabs");
    await expect(
      broker.execute({
        type: "desktop.browser.acquire_control",
        ...scope,
        leaseId: "lease-1",
        tabIds: ["personal-tab"],
        controllerLabel: "Agent",
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow("Agents cannot capture or control personal browser tabs");
    expect(captureTab).not.toHaveBeenCalled();
    broker.dispose();
  });
});

describe("desktop browser reveal", () => {
  it("sends the tab request without restoring, showing, or focusing the window", async () => {
    const broker = createDesktopBrowserBroker({
      manager: createFakeManager(
        () => {
          throw new Error("unused");
        },
        () => [
          {
            tabId: "tab-a",
            threadId: "thread-a",
            generation: "tab-generation",
            profile: { kind: "automation", id: "profile-a" },
            presentation: "hidden",
            url: "about:blank",
            title: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            errorText: null,
          },
        ],
      ),
      product: "Chrome/1",
    });
    const window = {
      ...createFakeWindow(),
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    const send = vi.spyOn(window.webContents, "send");
    broker.registerWindow(window as never);
    broker.setHostId("host-a");
    const [instance] = broker.listInstances();
    try {
      await broker.execute({
        type: "desktop.browser.reveal_tab",
        instanceId: instance.instanceId,
        generation: instance.generation,
        threadId: "thread-a",
        tabId: "tab-a",
      });
      expect(send).toHaveBeenCalledWith("bb-desktop:browser:reveal", {
        threadId: "thread-a",
        tabId: "tab-a",
        desktopTarget: {
          hostId: "host-a",
          instanceId: instance.instanceId,
          generation: instance.generation,
        },
      });
      expect(window.restore).not.toHaveBeenCalled();
      expect(window.show).not.toHaveBeenCalled();
      expect(window.focus).not.toHaveBeenCalled();
    } finally {
      broker.dispose();
    }
  });
});
