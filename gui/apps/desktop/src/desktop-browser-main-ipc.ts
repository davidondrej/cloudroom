import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import type { z } from "zod";
import {
  roomDesktopBrowserAttachRequestSchema,
  roomDesktopBrowserFindInPageRequestSchema,
  roomDesktopBrowserNavigateRequestSchema,
  roomDesktopBrowserSetBoundsRequestSchema,
  roomDesktopBrowserSetVisibleRequestSchema,
  roomDesktopBrowserStopFindInPageRequestSchema,
  roomDesktopBrowserTabRefSchema,
} from "@cloudroom/desktop-contract";
import {
  ROOM_DESKTOP_BROWSER_ATTACH_CHANNEL,
  ROOM_DESKTOP_BROWSER_DETACH_CHANNEL,
  ROOM_DESKTOP_BROWSER_FOCUS_CHANNEL,
  ROOM_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
  ROOM_DESKTOP_BROWSER_GO_BACK_CHANNEL,
  ROOM_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
  ROOM_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
  ROOM_DESKTOP_BROWSER_RELOAD_CHANNEL,
  ROOM_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
  ROOM_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
  ROOM_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
  ROOM_DESKTOP_BROWSER_STOP_CHANNEL,
  ROOM_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
} from "./desktop-browser-ipc.js";
import type { DesktopBrowserViewManager } from "./desktop-browser-view.js";

function hostWindowFromBrowserIpcEvent(
  event: IpcMainEvent,
): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function registerRequestCommand<T>(
  channel: string,
  schema: z.ZodType<T>,
  isTrustedSender: (event: IpcMainEvent) => boolean,
  run: (args: { hostWindow: BrowserWindow; request: T }) => void,
): void {
  ipcMain.on(channel, (event, payload: unknown) => {
    if (!isTrustedSender(event)) {
      return;
    }
    const hostWindow = hostWindowFromBrowserIpcEvent(event);
    if (hostWindow === null) {
      return;
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    run({ hostWindow, request: parsed.data });
  });
}

export function registerDesktopBrowserIpc(
  manager: DesktopBrowserViewManager,
  isTrustedSender: (event: IpcMainEvent) => boolean,
): void {
  const command = <T>(
    channel: string,
    schema: z.ZodType<T>,
    run: (args: { hostWindow: BrowserWindow; request: T }) => void,
  ): void => registerRequestCommand(channel, schema, isTrustedSender, run);

  command(
    ROOM_DESKTOP_BROWSER_ATTACH_CHANNEL,
    roomDesktopBrowserAttachRequestSchema,
    (args) => manager.attach(args),
  );
  command(
    ROOM_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
    roomDesktopBrowserNavigateRequestSchema,
    (args) => manager.navigate(args),
  );
  command(
    ROOM_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
    roomDesktopBrowserSetBoundsRequestSchema,
    (args) => manager.setBounds(args),
  );
  command(
    ROOM_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
    roomDesktopBrowserSetVisibleRequestSchema,
    (args) => manager.setVisible(args),
  );
  command(
    ROOM_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
    roomDesktopBrowserSetVisibleRequestSchema,
    (args) => manager.setVisibleWithoutFocus(args),
  );
  command(
    ROOM_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
    roomDesktopBrowserFindInPageRequestSchema,
    (args) => manager.findInPage(args),
  );
  command(
    ROOM_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
    roomDesktopBrowserStopFindInPageRequestSchema,
    (args) => manager.stopFindInPage(args),
  );
  command(
    ROOM_DESKTOP_BROWSER_DETACH_CHANNEL,
    roomDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.detach({ hostWindow, tabId: request.tabId }),
  );
  command(
    ROOM_DESKTOP_BROWSER_FOCUS_CHANNEL,
    roomDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.focus({ hostWindow, tabId: request.tabId }),
  );
  command(
    ROOM_DESKTOP_BROWSER_GO_BACK_CHANNEL,
    roomDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.goBack({ hostWindow, tabId: request.tabId }),
  );
  command(
    ROOM_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
    roomDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.goForward({ hostWindow, tabId: request.tabId }),
  );
  command(
    ROOM_DESKTOP_BROWSER_RELOAD_CHANNEL,
    roomDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.reload({ hostWindow, tabId: request.tabId }),
  );
  command(
    ROOM_DESKTOP_BROWSER_STOP_CHANNEL,
    roomDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.stop({ hostWindow, tabId: request.tabId }),
  );
}
