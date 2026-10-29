import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useThread } from "@/hooks/queries/thread-queries";
import { sdk } from "@/lib/sdk";

const LOOPS_PLUGIN_ID = "automations";
const DAYS = 91;
const BODY_HEIGHT = 108;
const COLLAPSE_SCROLL_PX = 140;

const counts = z.array(z.number()).catch([]);
const scanSchema = z.object({
  stage: z.enum(["finding", "reading", "patterns"]).catch("finding"),
  chats: z.number().catch(0),
  days: counts,
  read: counts,
  readers: z.number().catch(0),
  readersDone: z.number().catch(0),
  secrets: z.number().catch(0),
});
type Scan = z.output<typeof scanSchema>;

const STAGE_LABEL: Record<Scan["stage"], string> = {
  finding: "finding your chats",
  reading: "reading your chats",
  patterns: "finding patterns",
};

const fmt = (n: number) => n.toLocaleString("en-US");

export function ScanProgress({ threadId }: { threadId: string }) {
  const { data: thread } = useThread(threadId, { refetchOnMount: false });
  if (thread?.originPluginId !== LOOPS_PLUGIN_ID) return null;
  return (
    <ScanProgressLoader
      threadId={threadId}
      busy={thread.status === "starting" || thread.status === "active"}
    />
  );
}

function ScanProgressLoader({
  threadId,
  busy,
}: {
  threadId: string;
  busy: boolean;
}) {
  const { data } = useQuery({
    queryKey: ["workflow-scan-progress", threadId],
    queryFn: ({ signal }) =>
      sdk.threads.getPluginMetadata({
        threadId,
        pluginId: LOOPS_PLUGIN_ID,
        signal,
      }),
    refetchInterval: busy ? 3_000 : false,
  });
  const raw = data?.workflowScan;
  if (raw === undefined || raw === null || typeof raw !== "object") return null;
  return <ScanProgressCard scan={scanSchema.parse(raw)} busy={busy} />;
}

function useScrollCollapse() {
  const ref = useRef<HTMLDivElement>(null);
  const [collapse, setCollapse] = useState(0);
  useEffect(() => {
    let scroller = ref.current?.parentElement ?? null;
    while (
      scroller &&
      !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
    ) {
      scroller = scroller.parentElement;
    }
    if (!scroller) return;
    const element = scroller;
    const update = () =>
      setCollapse(
        Math.min(1, Math.max(0, element.scrollTop / COLLAPSE_SCROLL_PX)),
      );
    update();
    element.addEventListener("scroll", update, { passive: true });
    return () => element.removeEventListener("scroll", update);
  }, []);
  return { ref, collapse: collapse * collapse * (3 - 2 * collapse) };
}

function ScanProgressCard({ scan, busy }: { scan: Scan; busy: boolean }) {
  const { ref, collapse } = useScrollCollapse();
  const read = scan.read.reduce((sum, n) => sum + n, 0);
  const finished = scan.stage === "patterns";
  const waiting = busy && scan.chats === 0;
  const status = waiting
    ? ""
    : busy
      ? `${scan.readers ? Math.round((scan.readersDone / scan.readers) * 100) : 0}%`
      : finished
        ? "Done"
        : "Stopped";
  return (
    <div
      ref={ref}
      className="sticky top-2 z-20 px-2"
      style={{ marginBottom: BODY_HEIGHT * collapse }}
    >
      <div
        className="rounded-xl border border-border bg-background px-3.5"
        style={{
          paddingBlock: 14 - 5 * collapse,
          boxShadow: `0 10px 30px rgba(0,0,0,${0.45 * collapse})`,
        }}
      >
        <div className="flex h-5 items-center gap-2 text-xs">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              busy || finished ? "bg-primary" : "bg-muted-foreground",
              busy && "animate-pulse",
            )}
          />
          <span className="font-semibold text-foreground">Workflow scan</span>
          <span className="truncate text-muted-foreground">
            · {busy ? STAGE_LABEL[scan.stage] : finished ? "done" : "stopped"}
          </span>
          <span className="ml-auto flex items-center gap-3">
            <span
              className="flex items-center gap-3"
              style={{
                opacity: collapse,
                transform: `translateY(${(1 - collapse) * 6}px)`,
              }}
            >
              <Heatmap scan={scan} cell={4} gap={1} waiting={waiting} />
              {waiting ? null : (
                <span className="text-[12px] font-semibold text-foreground tabular-nums">
                  {fmt(read)}
                </span>
              )}
            </span>
            <span className="text-muted-foreground tabular-nums">{status}</span>
          </span>
        </div>
        <div
          className="overflow-hidden"
          style={{
            height: BODY_HEIGHT * (1 - collapse),
            opacity: 1 - collapse * 1.4,
          }}
        >
          <div
            className="flex items-end gap-4 pt-3"
            style={{
              transform: `scale(${1 - 0.15 * collapse})`,
              transformOrigin: "top left",
            }}
          >
            <Heatmap scan={scan} cell={11} gap={3} waiting={waiting} />
            {waiting ? (
              <div className="min-w-0 pb-1">
                <div className="text-[17px] leading-none font-semibold text-foreground">
                  Finding your chats
                </div>
                <div className="mt-2 text-[11px] text-muted-foreground">
                  Looking through 13 weeks on this computer
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Secrets are masked before anything leaves it
                </div>
              </div>
            ) : (
              <div className="min-w-0 pb-0.5">
                <div className="text-[26px] leading-none font-semibold text-foreground tabular-nums">
                  {scan.chats ? fmt(read) : "—"}
                  <span className="text-[15px] text-muted-foreground">
                    {" "}
                    / {scan.chats ? fmt(scan.chats) : "—"}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  chats read across 13 weeks
                </div>
                <div className="mt-2 text-[11px] text-muted-foreground tabular-nums">
                  <span className="text-primary">{scan.readersDone}</span>/
                  {scan.readers} readers · {fmt(scan.secrets)} secrets masked
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const WAVE_KEYFRAMES =
  "@keyframes scan-progress-wave{0%,28%,100%{opacity:.07}11%{opacity:.6}}@media (prefers-reduced-motion:reduce){[data-scan-wave]{animation:none!important;opacity:.12}}";

function Heatmap({
  scan,
  cell,
  gap,
  waiting,
}: {
  scan: Scan;
  cell: number;
  gap: number;
  waiting: boolean;
}) {
  const max = Math.max(1, ...scan.days);
  if (waiting) {
    return (
      <div className="flex" style={{ gap }} aria-hidden>
        <style>{WAVE_KEYFRAMES}</style>
        {Array.from({ length: DAYS / 7 }, (_, week) => (
          <div key={week} className="flex flex-col" style={{ gap }}>
            {Array.from({ length: 7 }, (_, weekday) => (
              <span
                key={weekday}
                data-scan-wave=""
                className="rounded-[2px] bg-primary"
                style={{
                  width: cell,
                  height: cell,
                  opacity: 0.07,
                  animation: "scan-progress-wave 2.2s ease-in-out infinite",
                  animationDelay: `${week * 0.08 + weekday * 0.025}s`,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex" style={{ gap }} aria-hidden>
      {Array.from({ length: DAYS / 7 }, (_, week) => (
        <div key={week} className="flex flex-col" style={{ gap }}>
          {Array.from({ length: 7 }, (_, weekday) => {
            const day = week * 7 + weekday;
            const total = scan.days[day] ?? 0;
            const done = Math.min(total, scan.read[day] ?? 0);
            const level = Math.sqrt(total / max);
            const lit = total > 0 && done > 0;
            return (
              <span
                key={weekday}
                className={cn(
                  "rounded-[2px]",
                  lit ? "bg-primary" : "bg-foreground",
                )}
                style={{
                  width: cell,
                  height: cell,
                  opacity:
                    total === 0
                      ? 0.05
                      : lit
                        ? (0.3 + level * 0.7) * (done === total ? 1 : 0.45)
                        : 0.07 + level * 0.13,
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
