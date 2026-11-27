import type { RoomDesktopApi } from "@cloudroom/desktop-contract";

declare global {
  interface Window {
    roomDesktop?: RoomDesktopApi;
    /** @deprecated Compat alias for older desktop shells connecting to a newer server. */
    bbDesktop?: RoomDesktopApi;
  }
}

export {};
