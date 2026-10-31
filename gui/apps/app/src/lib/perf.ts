import { useEffect, useLayoutEffect, useRef } from "react";
import { fetchWithAppSurface } from "./app-surface";
import { getBbDesktopInfo } from "./bb-desktop";

type PerfMetric =
  | "app_ready"
  | "thread_open"
  | "ui_freeze"
  | "panel_toggle_noop"
  | "top_right_window_drag";

interface PerfEntry {
  metric: PerfMetric;
  ms: number;
  threadId?: string;
  detail?: string;
}

interface PendingThreadOpen {
  metric: PerfMetric;
  reported: boolean;
  startedAt: number;
  threadId: string;
}

const PERF_ENDPOINT = "/api/v1/perf";
const FLUSH_INTERVAL_MS = 10_000;
const MAX_QUEUED_ENTRIES = 100;
const UI_FREEZE_THRESHOLD_MS = 200;
const INPUT_TO_OPEN_WINDOW_MS = 2_000;
const PANEL_OPEN_CHECK_MS = 500;

const queue: PerfEntry[] = [];
let lastInputAt: number | null = null;
let hasOpenedThread = false;

function recordPerf(entry: PerfEntry): void {
  if (queue.length >= MAX_QUEUED_ENTRIES) return;
  queue.push({ ...entry, ms: Math.round(entry.ms) });
}

function flushPerf(): void {
  if (queue.length === 0) return;
  const entries = queue.splice(0);
  void fetchWithAppSurface(PERF_ENDPOINT, {
    body: JSON.stringify({ entries }),
    headers: { "content-type": "application/json" },
    keepalive: true,
    method: "POST",
  }).catch(() => {});
}

function startThreadOpen(threadId: string): PendingThreadOpen {
  const now = performance.now();
  const isFirstOpen = !hasOpenedThread;
  hasOpenedThread = true;
  if (lastInputAt !== null && now - lastInputAt <= INPUT_TO_OPEN_WINDOW_MS) {
    return {
      metric: "thread_open",
      reported: false,
      startedAt: lastInputAt,
      threadId,
    };
  }
  if (isFirstOpen && lastInputAt === null) {
    return { metric: "app_ready", reported: false, startedAt: 0, threadId };
  }
  return { metric: "thread_open", reported: false, startedAt: now, threadId };
}

function afterNextPaint(callback: () => void): void {
  requestAnimationFrame(() => setTimeout(callback, 0));
}

export function installPerfMonitor(): void {
  const rememberInput = (event: Event) => {
    lastInputAt = event.timeStamp;
  };
  window.addEventListener("click", rememberInput, {
    capture: true,
    passive: true,
  });
  window.addEventListener("keydown", rememberInput, {
    capture: true,
    passive: true,
  });
  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= UI_FREEZE_THRESHOLD_MS) {
          recordPerf({ metric: "ui_freeze", ms: entry.duration });
        }
      }
    }).observe({ buffered: true, type: "longtask" });
  }
  getBbDesktopInfo()?.onTopRightWindowDrag?.((position) => {
    recordPerf({ metric: "top_right_window_drag", ms: 0, detail: position });
  });
  window.setInterval(flushPerf, FLUSH_INTERVAL_MS);
  window.addEventListener("pagehide", flushPerf);
}

export function watchPanelOpen(
  threadId: string,
  stillClosed: () => string | null,
): void {
  window.setTimeout(() => {
    const detail = stillClosed();
    if (detail === null) return;
    recordPerf({
      metric: "panel_toggle_noop",
      ms: PANEL_OPEN_CHECK_MS,
      threadId,
      detail: detail.slice(0, 300),
    });
  }, PANEL_OPEN_CHECK_MS);
}

export function useThreadOpenTiming(threadId: string, ready: boolean): void {
  const pending = useRef<PendingThreadOpen | null>(null);
  useLayoutEffect(() => {
    if (pending.current?.threadId === threadId) return;
    pending.current = startThreadOpen(threadId);
  }, [threadId]);
  useEffect(() => {
    const open = pending.current;
    if (
      !ready ||
      open === null ||
      open.threadId !== threadId ||
      open.reported
    ) {
      return;
    }
    open.reported = true;
    afterNextPaint(() => {
      recordPerf({
        metric: open.metric,
        ms: performance.now() - open.startedAt,
        threadId,
      });
    });
  }, [ready, threadId]);
}
