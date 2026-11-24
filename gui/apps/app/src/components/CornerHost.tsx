import { useEffect, useRef, useState } from "react";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { CORNER_CARDS, setCorner, useCornerState, type CornerAnswer, type CornerShown } from "@cloudroom/shared-ui/lib/corner";
import { useCornerTop } from "@/components/ActivationChecklist";
import { useIsNativeBrowserViewShown } from "@/hooks/useBrowserDimmingModal";
import { fetchWithAppSurface } from "@/lib/app-surface";

// The one place that decides which card shows at the top right (ADR 20261115-004019, docs/scopes/corner-cards.md).
// Cards ask with `useCorner`. The most important one that wants to show gets the corner. Wrapped and Scan wait for
// the account's record to say yes; the others show at once. Every show and answer is saved on the account.
const RETRY_MS = 10 * 60_000;
/** Wrapped and Scan wait this long after the app starts, so a more important card that is still loading goes first. */
const SETTLE_MS = 5_000;
const id = ({ card, key }: CornerShown) => `${card}/${key}`;

export function CornerHost() {
  const { wants, shown } = useCornerState();
  const compact = useIsCompactViewport();
  const covered = useIsNativeBrowserViewShown();
  const top = useCornerTop();
  // Per showing: true once the account said yes, or the time a "no" stops counting.
  const [claims, setClaims] = useState<Record<string, true | number>>({});
  const [, recheck] = useState(0);
  const [settled, setSettled] = useState(false);
  const sent = useRef(new Set<string>());
  // One request at a time, so an answer is saved before the next card asks to show.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const variants = useRef(wants);
  variants.current = wants;

  const send = (showing: CornerShown, event: "shown" | CornerAnswer) => {
    const variant = variants.current[showing.card]?.variant;
    const result = queue.current.then(async () => {
      const response = await fetchWithAppSurface("/api/v1/cloudroom/corner", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...showing, event, ...(variant ? { variant } : {}) }),
      });
      return response.ok && (await response.json() as { ok?: boolean }).ok === true;
    }).catch(() => false);
    queue.current = result;
    return result;
  };
  const refuse = (showing: CornerShown) => setClaims((current) => ({ ...current, [id(showing)]: Date.now() + RETRY_MS }));

  useEffect(() => {
    // An answered card leaves the corner at once, even if saving the answer fails. Every waiting card asks again,
    // since an answer starts the quiet days.
    setCorner({ answer: (showing, answer) => { setClaims({ [id(showing)]: Date.now() + RETRY_MS }); void send(showing, answer); } });
    // A "no" is asked again only when the window is shown again, never on a timer.
    const look = () => { if (document.visibilityState === "visible") recheck((count) => count + 1); };
    document.addEventListener("visibilitychange", look);
    window.addEventListener("focus", look);
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", look); window.removeEventListener("focus", look); };
    // oxlint-disable-next-line react/exhaustive-deps -- installed once: `send` and `refuse` only use refs and setters
  }, []);
  useEffect(() => { setCorner({ top }); }, [top]);

  // The most important card that wants the corner: `next` may show now, `ask` first needs the account's yes.
  let next: CornerShown | null = null, ask: CornerShown | null = null, claimed = false;
  for (const card of covered ? [] : CORNER_CARDS) {
    const want = wants[card.id];
    if (!want || (compact && !("phone" in card))) continue;
    const showing = { card: card.id, key: want.key }, claim = claims[id(showing)];
    if (!("wait" in card) || claim === true) { next = showing; claimed = "wait" in card; break; }
    if (!settled || (typeof claim === "number" && claim > Date.now())) continue;
    ask = showing;
    break;
  }
  const nextId = next && id(next), askId = ask && id(ask);
  useEffect(() => {
    if (!ask || sent.current.has(id(ask))) return;
    const showing = ask;
    sent.current.add(id(showing));
    void send(showing, "shown").then((ok) => {
      sent.current.delete(id(showing));
      if (ok) setClaims((current) => ({ ...current, [id(showing)]: true }));
      else refuse(showing);
    });
    // oxlint-disable-next-line react/exhaustive-deps -- `askId` names the showing
  }, [askId]);
  useEffect(() => {
    if ((shown && id(shown)) !== nextId) setCorner({ shown: next });
    // A card that waited was saved by its claim. A card that shows at once is saved in the background, once per app run.
    if (!next || claimed || sent.current.has(id(next))) return;
    sent.current.add(id(next));
    void send(next, "shown");
    // oxlint-disable-next-line react/exhaustive-deps -- `nextId` names the showing
  }, [nextId, shown]);
  return null;
}
