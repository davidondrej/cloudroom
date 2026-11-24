import { COMPUTER } from "@cloudroom/domain";
import { useEffect, useState, useSyncExternalStore } from "react";
import { appToast } from "@/components/ui/app-toast";
import { LONG_GONE_MS } from "@/cloud/other-mac";
import { otherMacLostAt, onMacConnectionChange, viewingOtherMac } from "@/cloud/mac-connection";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";

// Most drops are over in a second or two. Only a longer one is worth a note.
const SHOW_AFTER_MS = 2_000;

/**
 * The desktop app showing another of your Macs. When that Mac drops, the app stays on it: this note says
 * "Reconnecting…" and, after 30 seconds, offers this Mac. The app never leaves a Mac by itself.
 * While this Mac stands in for it, a toast offers to switch once the other Mac is back.
 */
export function OtherMacStatus() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const computers = desktopInfo?.computers;
  const fallback = computers?.fallback ?? null;
  const backHandle = fallback?.back === true ? fallback.handle : null;
  const backName = fallback?.back === true ? fallback.name : null;
  const openComputer = desktopApi?.openComputer;

  useEffect(() => {
    if (backHandle === null || backName === null || !openComputer) return;
    const id = `mac-back-${backHandle}`;
    appToast.message(`${backName} is back`, {
      id,
      duration: Infinity,
      action: { label: "Switch", onClick: () => void openComputer(backHandle) },
    });
    return () => {
      appToast.dismiss(id);
    };
  }, [backHandle, backName, openComputer]);

  const viewing = viewingOtherMac();
  const lostAt = useSyncExternalStore(onMacConnectionChange, otherMacLostAt);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!viewing || lostAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [viewing, lostAt]);

  if (!viewing || lostAt === null || now - lostAt < SHOW_AFTER_MS) {
    return null;
  }
  // An older desktop app has no "show this Mac": opening this Mac is the closest it can do.
  const showThisMac =
    desktopApi?.showThisComputer ??
    (openComputer ? () => openComputer(null) : undefined);
  return (
    <ReconnectingNote
      name={computers?.list.find(mac => mac.handle === computers.viewing)?.name}
      onUseThisMac={now - lostAt >= LONG_GONE_MS ? showThisMac : undefined}
    />
  );
}

/** The small note under the header, top right. It never covers the page. */
export function ReconnectingNote({
  name,
  onUseThisMac,
}: {
  name?: string;
  onUseThisMac?: () => Promise<void>;
}) {
  return (
    <div className="pointer-events-none absolute right-4 top-14 z-40 flex justify-end">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-warning"
        />
        <span role="status">Connection to {name || `the other ${COMPUTER}`} lost. Reconnecting…</span>
        {onUseThisMac ? (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => void onUseThisMac()}
            >
              Use this {COMPUTER}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
