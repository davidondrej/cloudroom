import type { BbDesktopApi } from "@cloudroom/desktop-contract";

declare global {
  interface Window {
    bbDesktop?: BbDesktopApi;
  }
}

export {};
