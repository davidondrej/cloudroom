import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { useMediaQuery } from "@cloudroom/shared-ui/hooks/use-media-query";
import { BbLogo } from "@/components/ui/bb-logo";
import { getAppSurface } from "@/lib/app-surface";
import { usePopup } from "@/lib/popups";

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let installPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => { installPrompt = null; notify(); });
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const useInstallPrompt = () => useSyncExternalStore(subscribe, () => installPrompt, () => null);

type InstallGuide = { where: string; steps: ReactNode[] };

const addToHome = <>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</>;

function installGuide(): InstallGuide | null {
  if (typeof navigator === "undefined") return null;
  const agent = navigator.userAgent;
  const inApp = /FBAN|FBAV|Instagram|LinkedInApp|Snapchat|musical_ly|BytedanceWebview|; wv\)/.test(agent);
  if (/iPhone|iPod/.test(agent) || (/iPad|Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) {
    const device = /iPhone|iPod/.test(agent) ? "iPhone" : "iPad";
    if (inApp) return { where: `this app on ${device}`, steps: [<>Tap the menu <MoreIcon /> and choose <b>Open in Safari</b>.</>, <>Follow the steps there.</>] };
    if (/CriOS/.test(agent)) return { where: `Chrome on ${device}`, steps: [<>Tap <b>Share</b> <ShareIcon /> on the right of the address bar.</>, addToHome] };
    if (/FxiOS/.test(agent)) return { where: `Firefox on ${device}`, steps: [<>Tap <b>Share</b> <ShareIcon /> in the address bar.</>, addToHome] };
    if (/EdgiOS/.test(agent)) return { where: `Edge on ${device}`, steps: [<>Tap the menu <MoreIcon /> at the bottom.</>, <>Tap <b>Share</b> <ShareIcon />.</>, addToHome] };
    const safari = Number(/Version\/(\d+)/.exec(agent)?.[1] ?? 0);
    const share = safari >= 26 ? <>Tap <MoreIcon /> next to the address bar, then <b>Share</b>.</> : <>Tap <b>Share</b> <ShareIcon /> in the browser bar.</>;
    return { where: `Safari on ${device}`, steps: [share, addToHome] };
  }
  if (!/Android/.test(agent)) return null;
  if (inApp) return { where: "this app", steps: [<>Tap the menu <MenuIcon /> and choose <b>Open in Chrome</b> or <b>Open in browser</b>.</>, <>Follow the steps there.</>] };
  if (/SamsungBrowser/.test(agent)) return { where: "Samsung Internet", steps: [<>Tap the menu <LinesIcon /> at the bottom.</>, <>Tap <b>Add page to</b>, then <b>Home screen</b>.</>] };
  if (/Firefox/.test(agent)) return { where: "Firefox on Android", steps: [<>Tap the menu <MenuIcon />.</>, <>Tap <b>Install</b> or <b>Add to Home screen</b>.</>, <>Tap <b>Add</b>.</>] };
  if (/EdgA/.test(agent)) return { where: "Edge on Android", steps: [<>Tap the menu <MoreIcon /> at the bottom.</>, <>Tap <b>Add to phone</b>.</>, <>Tap <b>Install</b>.</>] };
  return { where: /Chrome\//.test(agent) && !/OPR\//.test(agent) ? "Chrome on Android" : "your browser", steps: [<>Tap the menu <MenuIcon /> at the top right.</>, <>Tap <b>Add to Home screen</b> or <b>Install app</b>.</>, <>Tap <b>Install</b>.</>] };
}

export function InstallAppSheet() {
  const installed = useMediaQuery("(display-mode: standalone)") || (navigator as { standalone?: boolean }).standalone === true;
  const prompt = useInstallPrompt();
  const [guide] = useState(installGuide);
  const [visible, setVisible] = useState(false);
  const popup = usePopup("install", guide !== null && !installed && getAppSurface() === "web");
  useEffect(() => {
    if (!popup.open) return;
    const timer = setTimeout(() => setVisible(true), 1_200);
    return () => clearTimeout(timer);
  }, [popup.open]);
  if (!popup.open || !visible || guide === null) return null;

  const close = () => popup.close();
  const install = async () => {
    if (prompt === null) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    installPrompt = null;
    notify();
    if (outcome === "accepted") close();
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Add Cloudroom to your home screen" data-testid="install-app-sheet"
      className="fixed inset-0 z-50 flex items-end bg-black/40 duration-200 animate-in fade-in-0" onClick={close}>
      <div onClick={(event) => event.stopPropagation()}
        className="w-full rounded-t-xl border-t bg-background px-5 pt-5 pb-[calc(env(safe-area-inset-bottom)+20px)] duration-300 animate-in slide-in-from-bottom">
        <div className="flex items-center gap-3">
          <BbLogo className="size-10 shrink-0" />
          <div>
            <h2 className="text-base font-semibold">Add Cloudroom to your home screen</h2>
            <p className="text-sm text-muted-foreground">It opens full screen, like a normal app.</p>
          </div>
        </div>
        {prompt === null ? (<>
          <p className="mt-5 text-xs text-muted-foreground">In {guide.where}:</p>
          <ol className="mt-2 space-y-3 text-sm">
            {guide.steps.map((step, index) => (
              <li key={index} className="flex items-center gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </>) : null}
        <div className="mt-6 flex gap-2">
          <Button variant="outline" className="h-11 flex-1" onClick={close}>Not now</Button>
          {prompt !== null ? <Button className="h-11 flex-1" onClick={() => void install()}>Install</Button> : <Button className="h-11 flex-1" onClick={close}>Done</Button>}
        </div>
      </div>
    </div>
  );
}

const ShareIcon = () => (
  <svg viewBox="0 0 24 24" className="inline size-4 -translate-y-px align-middle" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12M8 7l4-4 4 4" /><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
  </svg>
);

const MenuIcon = () => (
  <svg viewBox="0 0 24 24" className="inline size-4 -translate-y-px align-middle" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
  </svg>
);

const MoreIcon = () => (
  <svg viewBox="0 0 24 24" className="inline size-4 -translate-y-px align-middle" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
  </svg>
);

const LinesIcon = () => (
  <svg viewBox="0 0 24 24" className="inline size-4 -translate-y-px align-middle" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);
