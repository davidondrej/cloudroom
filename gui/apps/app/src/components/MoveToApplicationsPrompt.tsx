import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";
import { useBrowserDimmingModal } from "@/hooks/useBrowserDimmingModal";

const APP_ICON = "/apple-touch-icon.png?v=room";

// The macOS Applications folder: blue folder, App Store "A", shortcut arrow.
function ApplicationsFolder() {
  return (
    <svg width="112" height="112" viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <linearGradient id="move-apps-folder" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4fb3ec" />
          <stop offset="1" stopColor="#3a9bd9" />
        </linearGradient>
      </defs>
      <path d="M10 26a7 7 0 0 1 7-7h26c3 0 4.5 1.2 6.4 3.3L54 27h49a7 7 0 0 1 7 7v8H10z" fill="#62bdf0" />
      <rect x="10" y="32" width="100" height="70" rx="7" fill="url(#move-apps-folder)" />
      <rect x="10" y="94" width="100" height="1.5" fill="#fff" opacity=".35" />
      <rect x="10" y="98" width="100" height="1.5" fill="#fff" opacity=".25" />
      <g stroke="#2a86c2" strokeWidth="6" strokeLinecap="round" opacity=".85">
        <path d="M60 46 44 84" />
        <path d="M60 46l16 38" />
        <path d="M43 70h34" />
      </g>
      <g transform="translate(6 82)">
        <rect width="22" height="22" rx="4" fill="#fff" />
        <path d="M6 17c0-6 3-9 9-9m0 0-4-3m4 3-3 4" stroke="#1d1d1f" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

function Item({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center">
      {children}
      <span className="mt-2 text-[13px] text-[#e5e5e7]">{label}</span>
    </div>
  );
}

// The dark disk-image window people skipped: Cloudroom › Applications.
function DiskImageWindow() {
  return (
    <div className="overflow-hidden rounded-[12px] border border-white/10 bg-[#232325] shadow-[0_10px_30px_rgba(0,0,0,.35)]">
      <div className="relative flex h-9 items-center border-b border-black/40 bg-[#2c2c2e] px-3.5">
        <div className="flex gap-2">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="absolute inset-x-0 flex items-center justify-center gap-1.5 text-[13px] font-semibold text-[#e5e5e7]">
          <img src={APP_ICON} alt="" className="size-4 rounded-[22%]" />
          Cloudroom
        </div>
      </div>
      <div className="flex items-center justify-center gap-10 py-9">
        <Item label="Cloudroom">
          <div className="flex size-[112px] items-center justify-center">
            <img src={APP_ICON} alt="" className="size-[92px] rounded-[22%]" />
          </div>
        </Item>
        <svg width="34" height="48" viewBox="0 0 34 48" aria-hidden="true">
          <path d="M9 9l15 15-15 15" stroke="#d4d4d8" strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <Item label="Applications">
          <ApplicationsFolder />
        </Item>
      </div>
      <div className="flex h-7 items-center gap-1.5 border-t border-black/40 bg-[#1c1c1e] px-3.5 text-[12px] text-[#a1a1a6]">
        <img src={APP_ICON} alt="" className="size-3.5 rounded-[22%]" /> Cloudroom
      </div>
    </div>
  );
}

// Mac only: Cloudroom runs from the disk image or Downloads, where it can never update itself.
// Not now hides it until the next launch.
export function MoveToApplicationsPrompt() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const [hidden, setHidden] = useState(false);
  const [moving, setMoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const open = desktopInfo?.installNeedsMove === true && desktopApi?.moveToApplications !== undefined && !hidden;
  useBrowserDimmingModal(open);
  useEffect(() => { if (open) card.current?.focus(); }, [open]);
  if (!open) return null;

  const move = () => {
    setMoving(true);
    setFailed(false);
    // On success the app quits and reopens from Applications, so only a failure comes back.
    void desktopApi?.moveToApplications?.().then((moved) => {
      if (!moved) {
        setMoving(false);
        setFailed(true);
      }
    });
  };
  const notNow = () => { if (!moving) setHidden(true); };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[6px] duration-200 animate-in fade-in-0">
      <div ref={card} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Move Cloudroom to Applications" data-testid="move-to-applications"
        onKeyDown={(event) => { if (event.key === "Escape") notNow(); }}
        className="w-[540px] max-w-full rounded-2xl border border-border bg-popover p-7 shadow-[0_30px_80px_rgba(0,0,0,.6)] outline-none duration-200 animate-in fade-in-0 zoom-in-95">
        <DiskImageWindow />
        <h2 className="mt-6 text-xl font-semibold text-foreground">Move Cloudroom to Applications</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          It's running from the disk image, so it can't update itself. One click moves it and reopens it.
        </p>
        {failed ? (
          <p role="alert" className="mt-3 text-sm leading-relaxed text-destructive-text">
            Cloudroom couldn't move itself. Quit it, drag it into Applications, then open it from there.
          </p>
        ) : null}
        <div className="mt-6 flex items-center justify-between">
          <button type="button" disabled={moving} onClick={notNow} className="text-[13px] text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-40">
            Not now
          </button>
          <Button size="lg" disabled={moving} onClick={move}>
            {moving ? "Moving…" : "Move to Applications"}
          </Button>
        </div>
      </div>
    </div>
  );
}
