import { useState, type FocusEvent, type ReactNode } from "react";
import { atom, useAtom } from "jotai";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@cloudroom/shared-ui/hover-card";
import type { ThreadPurpose } from "@cloudroom/domain";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { formatRelativeTime } from "@/lib/relative-time";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";

export const threadPurposeShowInSidebarAtom = createSyncedPreferenceAtom(
  "threadPurpose.showInSidebar",
);

function ThreadPurposeCardBody({ purpose }: { purpose: ThreadPurpose }) {
  return (
    <>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="font-medium uppercase tracking-wider">Purpose</span>
        <span>
          updated{" "}
          {formatRelativeTime({ timestamp: purpose.updatedAt, now: Date.now() })}
        </span>
      </div>
      <p className="text-sm leading-relaxed text-foreground">{purpose.text}</p>
      <div className="flex items-center gap-3">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${purpose.percent}%` }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {purpose.percent}% done
        </span>
      </div>
    </>
  );
}

export function ThreadPurposeHoverCard({
  children,
  purpose,
}: {
  children: ReactNode;
  purpose: ThreadPurpose | null;
}) {
  if (!purpose) return children;
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="start"
        sideOffset={8}
        className="w-[420px] max-w-[calc(100vw-2rem)] space-y-3 px-[18px] py-4"
      >
        <ThreadPurposeCardBody purpose={purpose} />
      </HoverCardContent>
    </HoverCard>
  );
}

const SIDEBAR_PURPOSE_OPEN_DELAY_MS = 1500;
const SIDEBAR_PURPOSE_WARM_MS = 400;
const sidebarPurposeWarmAtom = atom(false);
let openSidebarPurposeThreadId: string | null = null;
let coolSidebarPurposeTimer: number | undefined;

export const preventPurposeOpenOnFocus = (event: FocusEvent) =>
  event.preventDefault();

export function SidebarThreadPurposeHoverCard({
  children,
  purpose,
  threadId,
}: {
  children: ReactNode;
  purpose: ThreadPurpose | null;
  threadId: string;
}) {
  const [isWarm, setIsWarm] = useAtom(sidebarPurposeWarmAtom);
  const [open, setOpen] = useState(false);
  const [openedWarm, setOpenedWarm] = useState(false);
  const handleOpenChange = (next: boolean) => {
    if (next && !purpose) return;
    setOpen(next);
    window.clearTimeout(coolSidebarPurposeTimer);
    if (next) {
      setOpenedWarm(isWarm);
      openSidebarPurposeThreadId = threadId;
      setIsWarm(true);
      return;
    }
    if (openSidebarPurposeThreadId === threadId) openSidebarPurposeThreadId = null;
    coolSidebarPurposeTimer = window.setTimeout(() => {
      if (openSidebarPurposeThreadId === null) setIsWarm(false);
    }, SIDEBAR_PURPOSE_WARM_MS);
  };
  return (
    <HoverCard
      open={open && purpose !== null}
      onOpenChange={handleOpenChange}
      openDelay={isWarm ? 0 : SIDEBAR_PURPOSE_OPEN_DELAY_MS}
      closeDelay={0}
    >
      {children}
      {purpose ? (
        <HoverCardContent
          side="bottom"
          align="start"
          sideOffset={6}
          className={cn(
            "group pointer-events-none relative w-[var(--radix-hover-card-trigger-width)] max-w-[calc(100vw-2rem)] space-y-2.5 px-3.5 py-3 data-[state=closed]:animate-none!",
            openedWarm && "data-[state=open]:animate-none!",
          )}
        >
          <span
            aria-hidden
            className="absolute -top-[5px] left-2.5 size-2.5 rotate-45 rounded-tl-[2px] border-l border-t bg-popover group-data-[side=top]:hidden"
          />
          <ThreadPurposeCardBody purpose={purpose} />
        </HoverCardContent>
      ) : null}
    </HoverCard>
  );
}
