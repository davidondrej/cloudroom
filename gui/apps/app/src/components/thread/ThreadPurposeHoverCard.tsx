import {
  useEffect,
  useMemo,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import { atom, useAtom, useAtomValue, useStore } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { durationToCompactString } from "@cloudroom/thread-view";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@cloudroom/shared-ui/hover-card";
import type { ThreadPurpose } from "@cloudroom/domain";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { formatRelativeTime } from "@/lib/relative-time";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { useLoopLines, type LoopLine } from "@/lib/loop-threads";

export const threadPurposeShowInSidebarAtom = createSyncedPreferenceAtom(
  "threadPurpose.showInSidebar",
);

// The loops that started or wake a thread (#1136), in both cards (David, 2026-11-27): a lime strip on top of the
// sidebar card (design B), black chips under the note in the title card (design C). Names wrap, never cut off.
function LoopStrip({ loops, alone }: { loops: LoopLine[]; alone: boolean }) {
  return (
    <div
      className={cn(
        "-mx-3.5 space-y-0.5 bg-primary px-3.5 py-2 text-xs text-primary-foreground",
        alone ? "-my-3 rounded-md" : "-mt-3 mb-3 rounded-t-md",
      )}
    >
      {loops.map(([verb, names], index) => (
        <div key={index} className="flex items-baseline gap-1.5">
          <span className="shrink-0 opacity-70">{verb}</span>
          <span className="min-w-0 font-semibold break-words">{names}</span>
        </div>
      ))}
    </div>
  );
}

function LoopChips({ loops }: { loops: LoopLine[] }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      {loops.map(([verb, names], index) => (
        <span
          key={index}
          className="max-w-full rounded-lg bg-black px-2.5 py-1 font-mono text-[11px] break-words text-white dark:text-primary"
        >
          {verb.toLowerCase()} · {names}
        </span>
      ))}
    </div>
  );
}

export type SidebarPurposeCard = { purpose: ThreadPurpose | null; loops: LoopLine[] };

/** The sidebar card for a thread, or null: it shows a purpose, loops, or both, unless Settings turned it off. */
export function useSidebarPurposeCard(threadId: string, purpose: ThreadPurpose | null): SidebarPurposeCard | null {
  const show = useAtomValue(threadPurposeShowInSidebarAtom);
  const loops = useLoopLines(threadId);
  return show && (purpose || loops.length) ? { purpose, loops } : null;
}

function ThreadPurposeCardBody({ purpose, loops }: SidebarPurposeCard) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "absolute -top-[5px] left-2.5 size-2.5 rotate-45 rounded-tl-[2px] border-l border-t group-data-[side=top]:hidden",
          loops.length ? "bg-primary" : "bg-popover",
        )}
      />
      {loops.length ? <LoopStrip loops={loops} alone={!purpose} /> : null}
      {purpose ? <PurposeSummary purpose={purpose} /> : null}
    </>
  );
}

function PurposeSummary({ purpose }: { purpose: ThreadPurpose }) {
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

// Every thread, Local or Cloud: the purpose on lime and the thread's Cloud Credits on black, split by GPU sessions and
// the commands that used them (David, 2026-11-16 and 2026-11-18, docs/scopes/thread-purpose.md). Asked when the card
// opens; the app server caches it a minute.
const threadCreditsSchema = z.object({
  credits: z.number().nullable(),
  pending: z.boolean(),
  awakeMinutes: z.number(),
  partial: z.boolean(),
  rows: z.array(z.object({ name: z.string(), credits: z.number(), ms: z.number().nullable(), rest: z.literal(true).optional() })),
});

async function loadThreadCredits(threadId: string, signal?: AbortSignal) {
  const response = await fetchWithAppSurface(`/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/credits`, { signal });
  if (!response.ok) throw new Error(`Cloud Credits: ${response.status}`);
  return threadCreditsSchema.parse(await response.json());
}

const updatedText = (purpose: ThreadPurpose) =>
  `updated ${formatRelativeTime({ timestamp: purpose.updatedAt, now: Date.now() }).toLowerCase()}`;

function ThreadCredits({ threadId }: { threadId: string }) {
  const query = useQuery({
    queryKey: ["cloudroom-thread-credits", threadId],
    queryFn: ({ signal }) => loadThreadCredits(threadId, signal),
    staleTime: 60_000,
    retry: false,
  });
  const data = query.data, total = data?.credits ?? null;
  const note = query.isPending ? "Loading…" : !data ? "Couldn't load Cloud Credits." : total === null ? "Not available yet."
    : data.pending ? "Breakdown not ready yet. Usage data arrives every few minutes."
    : data.rows.length === 0 ? `No Cloud Credits used${data.partial ? " in the last 7 days" : ""}.` : null;
  return (
    <div className="flex min-w-0 flex-1 basis-0 flex-col bg-black p-5 font-mono text-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wider text-white/45">Cloud Credits</span>
        <span className="text-[26px] leading-none text-primary tabular-nums">{total === null ? "—" : Math.round(total).toLocaleString("en-US")}</span>
      </div>
      <div className="my-3.5 border-t border-dashed border-white/15" />
      {note ? <p className="font-sans text-white/50">{note}</p> : (
        <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-2">
          {data!.rows.map((row, index) => (
            <div key={row.name} className="contents">
              <span className={cn("truncate", row.rest ? "font-sans text-white/45" : "text-white/85")} title={row.name}>{row.name}</span>
              <span className="text-right text-white/35 tabular-nums">{row.ms === null ? "" : durationToCompactString(row.ms)}</span>
              <span className={cn("min-w-7 text-right tabular-nums", index === 0 ? "text-primary" : "text-white")}>{row.credits.toLocaleString("en-US")}</span>
            </div>
          ))}
        </div>
      )}
      {data && total !== null && data.rows.length > 0 ? (
        <div className="mt-auto flex justify-between gap-3 border-t border-dashed border-white/15 pt-2.5 text-white/45">
          <span>{[data.awakeMinutes > 0 ? `${durationToCompactString(data.awakeMinutes * 60_000)} awake` : "", data.partial ? "last 7 days" : ""].filter(Boolean).join(" · ")}</span>
          <span>total <span className="text-white">{Math.round(total).toLocaleString("en-US")}</span></span>
        </div>
      ) : null}
    </div>
  );
}

function PurposeCreditsCard({ purpose, loops, threadId }: SidebarPurposeCard & { threadId: string }) {
  return (
    <div className="flex">
      <div className="flex min-w-0 flex-1 basis-0 flex-col gap-3 bg-primary p-5 text-primary-foreground">
        {purpose ? (
          <>
            <div className="text-[11px] font-semibold uppercase tracking-wider opacity-70">Purpose</div>
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-[34px] leading-none font-semibold tabular-nums">{purpose.percent}%</span>
              <span className="text-xs font-semibold opacity-70">{purpose.percent >= 100 ? "done" : "done so far"}</span>
            </div>
            <p className="text-sm leading-relaxed font-medium">{purpose.text}</p>
          </>
        ) : null}
        {loops.length ? <LoopChips loops={loops} /> : null}
        {purpose ? <div className="mt-auto pt-2 text-xs opacity-60">{updatedText(purpose)}</div> : null}
      </div>
      <ThreadCredits threadId={threadId} />
    </div>
  );
}

export function ThreadPurposeHoverCard({
  children,
  purpose,
  threadId,
}: {
  children: ReactNode;
  purpose: ThreadPurpose | null;
  threadId: string;
}) {
  const loops = useLoopLines(threadId);
  if (!purpose && !loops.length) return children;
  return (
    <HoverCard openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        align="start"
        sideOffset={8}
        className="w-[660px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0 shadow-xl"
      >
        <PurposeCreditsCard purpose={purpose} loops={loops} threadId={threadId} />
      </HoverCardContent>
    </HoverCard>
  );
}

const SIDEBAR_PURPOSE_OPEN_DELAY_MS = 1500;
const SIDEBAR_PURPOSE_WARM_MS = 400;
const sidebarPurposeWarmAtom = atom(false);
// One shared open id, so only one sidebar card is ever open.
const openSidebarPurposeThreadIdAtom = atom<string | null>(null);
let coolSidebarPurposeTimer: number | undefined;

// Leaving or scrolling the thread list closes the card and restores the 1.5s delay.
export const closeSidebarPurposeCardAtom = atom(null, (_get, set) => {
  set(openSidebarPurposeThreadIdAtom, null);
  set(sidebarPurposeWarmAtom, false);
});

export const preventPurposeOpenOnFocus = (event: FocusEvent) =>
  event.preventDefault();

export function SidebarThreadPurposeHoverCard({
  children,
  card,
  threadId,
}: {
  children: ReactNode;
  card: SidebarPurposeCard | null;
  threadId: string;
}) {
  const store = useStore();
  const [isWarm, setIsWarm] = useAtom(sidebarPurposeWarmAtom);
  const isOpenThread = useAtomValue(
    useMemo(
      () => atom((get) => get(openSidebarPurposeThreadIdAtom) === threadId),
      [threadId],
    ),
  );
  // A freshly mounted row never shows a card without its own new hover.
  const [openedHere, setOpenedHere] = useState(false);
  const open = openedHere && isOpenThread;
  const [openedWarm, setOpenedWarm] = useState(false);
  // An unmounting card gives up the shared open id, so it can't come back.
  useEffect(
    () => () => {
      if (store.get(openSidebarPurposeThreadIdAtom) === threadId) {
        store.set(closeSidebarPurposeCardAtom);
      }
    },
    [store, threadId],
  );
  const handleOpenChange = (next: boolean) => {
    if (next && !card) return;
    setOpenedHere(next);
    window.clearTimeout(coolSidebarPurposeTimer);
    if (next) {
      setOpenedWarm(isWarm);
      store.set(openSidebarPurposeThreadIdAtom, threadId);
      setIsWarm(true);
      return;
    }
    if (store.get(openSidebarPurposeThreadIdAtom) === threadId) {
      store.set(openSidebarPurposeThreadIdAtom, null);
    }
    coolSidebarPurposeTimer = window.setTimeout(() => {
      if (store.get(openSidebarPurposeThreadIdAtom) === null) setIsWarm(false);
    }, SIDEBAR_PURPOSE_WARM_MS);
  };
  return (
    <HoverCard
      open={open && card !== null}
      onOpenChange={handleOpenChange}
      openDelay={isWarm ? 0 : SIDEBAR_PURPOSE_OPEN_DELAY_MS}
      closeDelay={0}
    >
      {children}
      {card ? (
        <HoverCardContent
          side="bottom"
          align="start"
          sideOffset={6}
          className={cn(
            "group pointer-events-none relative w-[var(--radix-hover-card-trigger-width)] max-w-[calc(100vw-2rem)] space-y-2.5 px-3.5 py-3 data-[state=closed]:animate-none!",
            openedWarm && "data-[state=open]:animate-none!",
          )}
        >
          <ThreadPurposeCardBody {...card} />
        </HoverCardContent>
      ) : null}
    </HoverCard>
  );
}
