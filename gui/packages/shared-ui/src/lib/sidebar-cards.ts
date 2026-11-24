import { useSyncExternalStore } from "react";

// The spot for cards in the sidebar, above the plan card. The app's sidebar renders it; plugins portal their card into
// it. Plugins are bundled apart, so the spot lives on `window`, like the corner's state (corner.ts).
/** `close` closes the sidebar on a phone or narrow window, before a card opens a page. Elsewhere it does nothing. */
export type SidebarCards = { element: HTMLElement; close: () => void };

const EVENT = "cloudroom:sidebar-cards";
const scope = globalThis as { __cloudroomSidebarCards?: SidebarCards | null };
const read = () => scope.__cloudroomSidebarCards ?? null;
const subscribe = (listener: () => void) => {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
};

/** For the app's sidebar only: its card spot, or null when the spot unmounts. */
export function setSidebarCards(spot: SidebarCards | null): void {
  scope.__cloudroomSidebarCards = spot;
  window.dispatchEvent(new Event(EVENT));
}

/** Where to portal a card, or null while the sidebar isn't shown. */
export const useSidebarCards = (): SidebarCards | null =>
  useSyncExternalStore(subscribe, read, () => null);
