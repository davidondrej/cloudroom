import type {
  BbDesktopApi,
  RoomDesktopBrowserApi,
  RoomDesktopInfo,
} from "@cloudroom/desktop-contract";

export function createNoopDesktopBrowserApi(): RoomDesktopBrowserApi {
  return {
    attach() {},
    detach() {},
    navigate() {},
    goBack() {},
    goForward() {},
    reload() {},
    stop() {},
    focus() {},
    setBounds() {},
    setVisible() {},
    setVisibleWithoutFocus() {},
    onState() {
      return () => {};
    },
    onOpenTab() {
      return () => {};
    },
    onFocus() {
      return () => {};
    },
  };
}

export function createRoomDesktopApi(
  info: RoomDesktopInfo,
  browser: RoomDesktopBrowserApi = createNoopDesktopBrowserApi(),
): BbDesktopApi {
  return {
    ...info,
    browser,
    async checkForUpdates() {
      return info;
    },
    async getInfo() {
      return info;
    },
    async installUpdate() {},
    onChange() {
      return () => {};
    },
    setTheme() {},
    openExternalUrl() {},
  };
}
