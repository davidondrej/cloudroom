import { useEffect, useSyncExternalStore, type CSSProperties } from "react";

// One module owns the app's top right corner (docs/scopes/corner-cards.md): only one card shows there at a time.
// A card asks for the corner with `useCorner`. The app's CornerHost picks who gets it, and saves every show and
// answer on the account. Plugins are bundled apart, so cards and the app share this state on `window` and follow
// one window event.

/** Every card that may use the corner, most important first.
 *  `wait`: it shows only once the account's record says yes (once per month for Wrapped; every 14 days for Partner,
 *  plus one final showing 30 days after a click; the quiet days and 45 days for Scan; 3 days after the call ticket
 *  was closed or clicked).
 *  `phone`: also shows on a phone. The others are desktop only. */
export const CORNER_CARDS = [
  { id: "invite", phone: true },
  { id: "call", wait: true },
  { id: "checklist" },
  { id: "wrapped", wait: true },
  { id: "partner", wait: true },
  { id: "scan", wait: true },
] as const satisfies readonly { id: string; wait?: true; phone?: true }[];
export type CornerCard = (typeof CORNER_CARDS)[number]["id"];
/** What the user did with a card: its main button, or its close button. */
export type CornerAnswer = "opened" | "closed";
/** One showing of a card. `key` names it (a month, an organization); `variant` is the design shown, for our stats. */
export type CornerWant = { key: string; variant?: string };
export type CornerShown = { card: CornerCard; key: string };
type State = {
  wants: Partial<Record<CornerCard, CornerWant>>;
  shown: CornerShown | null;
  /** Pixels from the top of the window: under the header, or below the new-thread composer. */
  top: number;
  answer: (shown: CornerShown, answer: CornerAnswer) => void;
};

const EVENT = "cloudroom:corner";
const PLACE = "fixed right-3 z-40 duration-300 animate-in fade-in-0 slide-in-from-right-4";
const scope = globalThis as { __cloudroomCorner?: State };
const read = (): State => (scope.__cloudroomCorner ??= { wants: {}, shown: null, top: 52, answer: () => {} });
const subscribe = (listener: () => void) => {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
};

/** For the app's CornerHost only: cards never write the corner's state themselves. */
export function setCorner(next: Partial<State>): void {
  scope.__cloudroomCorner = { ...read(), ...next };
  window.dispatchEvent(new Event(EVENT));
}

export const useCornerState = (): State => useSyncExternalStore(subscribe, read, read);

/** Asks for the corner. Pass `key: null` while the card has nothing to show.
 *  Returns null until it is this card's turn. Then: where to sit (`className`, `style`), and `answer` to save what
 *  the user did. A card still decides for itself when it wants to show; the corner decides whether it may. */
export function useCorner(card: CornerCard, key: string | null, variant?: string) {
  useEffect(() => {
    if (key === null) return;
    setCorner({ wants: { ...read().wants, [card]: variant ? { key, variant } : { key } } });
    return () => {
      const wants = { ...read().wants };
      delete wants[card];
      setCorner({ wants });
    };
  }, [card, key, variant]);
  const { shown, top, answer } = useCornerState();
  if (key === null || shown?.card !== card || shown.key !== key) return null;
  return {
    className: PLACE,
    style: { top } satisfies CSSProperties,
    answer: (value: CornerAnswer) => answer({ card, key }, value),
  };
}
