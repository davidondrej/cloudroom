import { useEffect, useMemo, useState } from "react";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Dialog, DialogContent, DialogTitle } from "@cloudroom/shared-ui/dialog";
import { useIsCompactViewport } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import cloudUrl from "../../../../assets/room-cloud.png";
import { checklistShownAtom, useCornerTop } from "@/components/ActivationChecklist";
import { useIsNativeBrowserViewShown } from "@/hooks/useBrowserDimmingModal";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { getLocalStorage } from "@/lib/browser-storage";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { drawWrappedCard, wrappedMidMonth, wrappedMonthName, WRAPPED_CARD, type Wrapped as Month } from "@/lib/wrapped-card";

// Monthly Wrapped (docs/scopes/wrapped.md): from the 1st, a small card at the top right says last month is wrapped.
// A click opens the Story, a three-panel card to save, copy or share on X. Settings → Analytics opens it again.

const PATH = "/api/v1/cloudroom/wrapped";
/** The month whose card was opened or closed on this computer. */
const ANSWERED_KEY = "cloudroom.wrapped.answered";
/** The last month worked out, so it is read from thread history only once. */
const SAVED_KEY = "cloudroom.wrapped.saved";
/** Fewer agents than this is not a month worth wrapping. */
const MIN_AGENTS = 5;
/** The numbers take a few seconds on a big history, so the app starts first. */
const WAIT_MS = 20_000;
const wrappedAtom = atom<Month | null>(null);
const openAtom = atom(false);
const answeredAtom = atom(getLocalStorage()?.getItem(ANSWERED_KEY) ?? "");
/** Opening the Story, from the card or from Settings, or closing the card is the answer: the card is done for that month. */
const answerAtom = atom(null, (_get, set, answer: { month: string; open: boolean }) => {
  getLocalStorage()?.setItem(ANSWERED_KEY, answer.month);
  set(answeredAtom, answer.month);
  if (answer.open) set(openAtom, true);
});
let viewed = "";

/** The month that just ended, in local time: `2026-10`. */
function lastMonth(): string {
  const now = new Date(), first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}`;
}

function saved(month: string): Month | null {
  try {
    const value = JSON.parse(getLocalStorage()?.getItem(SAVED_KEY) ?? "null") as Month | null;
    return value?.month === month && typeof value.agents === "number" && Array.isArray(value.days) ? value : null;
  } catch { return null; }
}

const report = (month: string, action: "viewed" | "opened" | "closed" | "saved" | "copied" | "shared") =>
  void fetchWithAppSurface(PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, action }) }).catch(() => {});

let cloud: Promise<HTMLImageElement> | null = null;
function loadCloud(): Promise<HTMLImageElement> {
  cloud ??= new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = cloudUrl;
  });
  return cloud;
}

const pngOf = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The image could not be made.")), "image/png"));
const copyPng = (canvas: HTMLCanvasElement) => navigator.clipboard.write([new ClipboardItem({ "image/png": pngOf(canvas) })]);

function Story({ wrapped, onClose }: { wrapped: Month; onClose: () => void }) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const name = wrappedMonthName(wrapped.month);
  useEffect(() => {
    if (!canvas) return;
    let live = true;
    // Every weight the card uses comes from the one variable font file.
    void Promise.all([loadCloud(), document.fonts.load('800 118px "Inter Variable"')]).then(([image]) => { if (live) drawWrappedCard(canvas, wrapped, image); }, () => {});
    return () => { live = false; };
  }, [canvas, wrapped]);
  // What the last button did, shown in the Story itself: a toast would cover these buttons.
  const [status, setStatus] = useState<string | null>(null);
  const act = (action: "saved" | "copied" | "shared", work: (canvas: HTMLCanvasElement) => Promise<void>, done?: string) => {
    if (!canvas) return;
    report(wrapped.month, action);
    void work(canvas).then(() => setStatus(done ?? null), () => setStatus("That didn't work. Try again."));
  };
  const save = async (target: HTMLCanvasElement) => {
    const link = document.createElement("a"), url = URL.createObjectURL(await pngOf(target));
    link.href = url;
    link.download = `cloudroom-wrapped-${wrapped.month}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  // X can't attach an image from a link, so the image goes to the clipboard and the post opens ready to paste.
  const share = async (target: HTMLCanvasElement) => {
    await copyPng(target);
    const text = `My ${name} in Cloudroom: ${wrapped.agents.toLocaleString("en-US")} agents started${wrapped.hours > 0 ? `, ${wrapped.hours} hours` : ""}.\n\ncloudroom.dev/wrapped`;
    openUrlInExternalBrowser(`https://x.com/intent/post?text=${encodeURIComponent(text)}`);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-w-[min(1168px,calc(100vw-48px))] gap-0 overflow-hidden p-0">
        <div className="flex h-[54px] items-center px-6">
          <DialogTitle className="text-[15px] font-semibold">Your {name} in Cloudroom</DialogTitle>
        </div>
        <canvas ref={setCanvas} role="img" aria-label={`Your ${name} in Cloudroom: ${wrapped.agents} agents started`}
          className="block w-full bg-[#111111]" style={{ aspectRatio: `${WRAPPED_CARD.width} / ${WRAPPED_CARD.height}` }} />
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <p role="status" className={cn("text-xs", status ? "font-medium text-primary-text" : "text-muted-foreground")}>
            {status ?? "Made on this computer. Nothing is uploaded until you share."}
          </p>
          <div className="flex items-center gap-6">
            {/* Saving and copying stay quiet text links: sharing is the point of the Story, so it gets the only button. */}
            {([["Save image", () => act("saved", save)], ["Copy image", () => act("copied", copyPng, "Image copied.")]] as const).map(([label, run]) => (
              <button key={label} type="button" onClick={run} className="cursor-pointer text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">{label}</button>
            ))}
            {/* The X logo is the name, so the label never spells it out. */}
            <Button aria-label="Share on X" className="h-12 gap-1.5 px-7 text-base font-semibold" onClick={() => act("shared", share, "Image copied. Paste it into your post on X.")}>
              Share on<svg viewBox="0 0 24 24" fill="currentColor" className="size-4" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function Wrapped() {
  const compact = useIsCompactViewport();
  const nativeBrowserShown = useIsNativeBrowserViewShown();
  const checklistShown = useAtomValue(checklistShownAtom);
  const top = useCornerTop();
  const [month, setMonth] = useState(lastMonth);
  const answered = useAtomValue(answeredAtom);
  const answer = useSetAtom(answerAtom);
  const [waited, setWaited] = useState(false);
  const [open, setOpen] = useAtom(openAtom);
  const setWrapped = useSetAtom(wrappedAtom);
  const pending = answered !== month && !compact;
  // An app left open over the 1st notices the new month when its window is shown again.
  useEffect(() => {
    const check = () => { if (document.visibilityState === "visible") setMonth(lastMonth()); };
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setWaited(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  const stored = useMemo(() => saved(month), [month]);
  // Worked out once per month for the card, or when the Story opens and this app run has no answer yet.
  const { data, refetch } = useQuery<Month>({
    queryKey: ["cloudroom-wrapped", month], staleTime: Infinity, retry: false,
    enabled: open || (pending && waited && stored === null),
    queryFn: async ({ signal }) => {
      // That month's own UTC offset: a clock change since then would shift every hour by one.
      const response = await fetchWithAppSurface(`${PATH}?month=${month}&utcOffsetMinutes=${-wrappedMidMonth(month).getTimezoneOffset()}`, { signal });
      if (!response.ok) throw new Error("Wrapped is unavailable.");
      const wrapped = await response.json() as Month;
      getLocalStorage()?.setItem(SAVED_KEY, JSON.stringify(wrapped));
      return wrapped;
    },
  });
  // Opening the Story asks again for a rank it missed: the website was slow or offline, or the month wasn't over everywhere.
  const missing = data?.top === null;
  useEffect(() => {
    if (open && missing) void refetch();
    // oxlint-disable-next-line react/exhaustive-deps -- once per opening, never again for the answer it brings
  }, [open]);
  const wrapped = data ?? stored;
  const worth = wrapped !== null && wrapped.agents >= MIN_AGENTS ? wrapped : null;
  useEffect(() => { setWrapped(worth); }, [setWrapped, worth]);
  const card = pending && worth !== null && !open && !nativeBrowserShown && !checklistShown;
  useEffect(() => {
    if (!card || viewed === month) return;
    viewed = month;
    report(month, "viewed");
  }, [card, month]);
  const name = wrappedMonthName(month);
  return (
    <>
      {card ? (
        <div data-testid="wrapped-card" className={cn("fixed right-3 z-30 h-[176px] w-[340px] overflow-hidden rounded-[10px] bg-[#BFFF00] text-[#0a0a0a] shadow-[0_18px_50px_rgba(0,0,0,.65),0_2px_8px_rgba(0,0,0,.5)] duration-300 animate-in fade-in-0 slide-in-from-right-4", top)}>
          <button type="button" onClick={() => { report(month, "opened"); answer({ month, open: true }); }}
            className="absolute inset-0 flex cursor-pointer flex-col px-4 pt-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#0a0a0a] focus-visible:ring-inset">
            <span className="flex gap-[3px]">
              {[0, 1, 2].map((step) => <span key={step} className={step === 0 ? "h-[3px] flex-1 bg-[#0a0a0a]" : "h-[3px] flex-1 bg-[#0a0a0a]/20"} />)}
            </span>
            <span className="mt-[11px] block font-mono text-[10px] tracking-[0.16em] uppercase">{name} · Wrapped</span>
            <span className="mt-2 block text-[27px] leading-[1.05] font-extrabold tracking-[-0.045em]">Your {name}<br />is wrapped.</span>
            <span className="absolute bottom-4 left-4 flex h-8 items-center gap-[7px] rounded-[7px] bg-[#0a0a0a] px-3.5 text-[13px] font-semibold text-[#BFFF00]">
              Open<Icon name="ArrowRight" className="size-3.5" aria-hidden="true" />
            </span>
            <img src={cloudUrl} alt="" aria-hidden="true" className="absolute -right-[30px] -bottom-[34px] w-[150px] max-w-none -rotate-[14deg]" />
          </button>
          <button type="button" aria-label="Dismiss" onClick={() => { report(month, "closed"); answer({ month, open: false }); }}
            className="absolute top-[22px] right-3 flex size-6 cursor-pointer items-center justify-center rounded hover:bg-[#0a0a0a]/10">
            <Icon name="X" className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {open && wrapped ? <Story wrapped={wrapped} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Settings → Analytics: opens last month's Wrapped again. Shows once that month has been worked out. */
export function WrappedButton() {
  const wrapped = useAtomValue(wrappedAtom);
  const answer = useSetAtom(answerAtom);
  if (!wrapped) return null;
  return (
    <button type="button" onClick={() => { report(wrapped.month, "opened"); answer({ month: wrapped.month, open: true }); }}
      className="shrink-0 rounded-md px-2.5 py-1 text-sm text-primary-text hover:bg-accent">
      {wrappedMonthName(wrapped.month)} Wrapped
    </button>
  );
}
