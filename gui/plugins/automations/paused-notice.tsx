import { useEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@cloudroom/shared-ui/hover-card";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cloudLoginProvider, type CloudLoginProvider } from "@cloudroom/domain/cloud-login";
import type { PausedLoop } from "./src/paused";

const POLL_MS = 60_000;
const LOOPS_CHANGED = "cloudroom:loops-changed";

/** A loop was turned on, off, or deleted here: the label reloads now, not within a minute. */
export const loopsChanged = () => window.dispatchEvent(new Event(LOOPS_CHANGED));

// The app's one Reconnect for an agent Cloud refused (gui/apps/app/src/lib/cloud-reconnect.ts), over window events.
export const reconnect = (provider: CloudLoginProvider) =>
  window.dispatchEvent(new CustomEvent("cloudroom:reconnect", { detail: provider }));

export type ReconnectState = { waiting: boolean; code: string | null; error: string | null };
const IDLE: ReconnectState = { waiting: false, code: null, error: null };
// The last state per agent, so a card that mounts mid sign-in (say, opening Loops) shows it too.
const reconnectStates = new Map<string, ReconnectState>();
const RECONNECT_STATE = "cloudroom:reconnect-state";
window.addEventListener(RECONNECT_STATE, (event) => {
  const { provider, waiting, code, error } = (event as CustomEvent<ReconnectState & { provider: string }>).detail;
  reconnectStates.set(provider, { waiting, code, error });
});

/** The app's sign-in for this agent, started from any Reconnect button: waiting, its device code, or why it failed. */
export function useReconnectState(provider: CloudLoginProvider | null): ReconnectState {
  const [state, setState] = useState(() => (provider && reconnectStates.get(provider)) || IDLE);
  useEffect(() => {
    if (!provider) return;
    setState(reconnectStates.get(provider) ?? IDLE);
    const update = (event: Event) => {
      const { provider: from, waiting, code, error } = (event as CustomEvent<ReconnectState & { provider: string }>).detail;
      if (from === provider) setState({ waiting, code, error });
    };
    window.addEventListener(RECONNECT_STATE, update);
    return () => window.removeEventListener(RECONNECT_STATE, update);
  }, [provider]);
  return state;
}

/** Runs `then` a few seconds after an agent works in Cloud again: the website retries its paused loops meanwhile. */
export function useCloudLoginFixed(then: () => void): void {
  const latest = useRef(then);
  latest.current = then;
  useEffect(() => {
    let timer = 0;
    const fixed = () => { window.clearTimeout(timer); timer = window.setTimeout(() => latest.current(), 5_000); };
    window.addEventListener("cloudroom:cloud-login-fixed", fixed);
    return () => { window.clearTimeout(timer); window.removeEventListener("cloudroom:cloud-login-fixed", fixed); };
  }, []);
}

async function rpc(method: string, input: unknown = null): Promise<unknown> {
  const response = await fetch(`/api/v1/plugins/automations/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    error?: string | { message?: string };
  } | null;
  if (!response.ok || body?.ok !== true)
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : (body?.error?.message ?? "Loops are unavailable."),
    );
  return body.result;
}

const resume = (loop: PausedLoop) =>
  loop.kind === "local"
    ? rpc("automations_resume", {
        projectId: loop.projectId,
        automationId: loop.id,
      })
    : rpc("cloud_automations", { action: "update", id: loop.id, enabled: true });

const stop = (event: SyntheticEvent) => event.stopPropagation();

/** The agent whose Cloud login paused this Cloud loop: Reconnect fixes it, not Resume. */
export const loginOf = (loop: Pick<PausedLoop, "kind" | "reason">) =>
  loop.kind === "cloud" ? cloudLoginProvider(loop.reason) : null;

export function PausedLoopsLabel() {
  const navigate = useBbNavigate();
  const [loops, setLoops] = useState<PausedLoop[]>([]);
  const [done, setDone] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(14);
  const label = useRef<HTMLSpanElement>(null);
  // Only the newest answer counts: one that started before a Resume may arrive after it.
  const latest = useRef(0);
  const load = (fresh = false) => {
    if (document.visibilityState !== "visible") return;
    const request = ++latest.current;
    rpc("paused_loops", fresh ? { fresh: true } : null).then(
      (result) => {
        if (request === latest.current)
          setLoops((result as { loops: PausedLoop[] }).loops);
      },
      () => {},
    );
  };
  useEffect(() => {
    const poll = () => load();
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", poll);
    window.addEventListener(LOOPS_CHANGED, poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      window.removeEventListener(LOOPS_CHANGED, poll);
    };
  }, []);
  useCloudLoginFixed(() => load(true));
  const run = (list: PausedLoop[]) => {
    for (const loop of list) {
      setDone((d) => ({ ...d, [loop.key]: "resuming" }));
      resume(loop).then(
        () => setDone((d) => ({ ...d, [loop.key]: "resumed" })),
        (error: Error) => setDone((d) => ({ ...d, [loop.key]: error.message })),
      );
    }
    window.setTimeout(load, 1500);
  };
  const paused = loops.filter((loop) => done[loop.key] !== "resumed");
  if (!loops.length) return null;
  const count = paused.length;
  return (
    <HoverCard
      openDelay={150}
      closeDelay={200}
      onOpenChange={(open) => {
        const row = label.current?.closest("[data-sidebar-navigation-item]");
        if (open && row && label.current)
          setOffset(row.getBoundingClientRect().right - label.current.getBoundingClientRect().right + 14);
      }}
    >
      <HoverCardTrigger asChild>
        <span
          ref={label}
          role="status"
          className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-destructive-text"
        >
          <span className="size-1.5 rounded-full bg-destructive" />
          {count ? `${count} paused` : "Resumed"}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={offset}
        alignOffset={-10}
        className="w-[304px] rounded-xl border-foreground/15 p-1.5 shadow-2xl"
        onClick={stop}
        onPointerDown={stop}
      >
        <div className="flex items-center gap-1.5 px-2 pb-2 pt-1.5 text-xs font-medium text-warning-text">
          <Icon name="Pause" className="size-3 fill-current" aria-hidden />
          {count} loop{count === 1 ? "" : "s"} paused after failed runs
        </div>
        {loops.map((loop) => (
          <div
            key={loop.key}
            className={`flex items-center gap-2 overflow-hidden rounded-md pl-2 pr-1.5 text-[13px] transition-all duration-300 ${done[loop.key] === "resumed" ? "h-0 opacity-0" : "h-[30px]"}`}
          >
            <span className="min-w-0 flex-1 truncate" title={loop.reason}>
              {loop.name}
            </span>
            {loginOf(loop) ? (
              <ReconnectButton provider={loginOf(loop)!} reason={loop.reason} />
            ) : done[loop.key] === "resumed" ? (
              <span className="text-xs font-medium text-primary">Resumed</span>
            ) : (
              <button
                type="button"
                disabled={done[loop.key] === "resuming"}
                title={done[loop.key] && done[loop.key] !== "resuming" ? done[loop.key] : undefined}
                onClick={() => run([loop])}
                className="flex h-[22px] shrink-0 items-center gap-1.5 rounded-md border border-primary/35 px-2 text-xs font-medium text-primary hover:border-primary/70 hover:bg-primary/15 disabled:opacity-50"
              >
                <Icon name="Play" className="size-2.5 fill-current" aria-hidden />
                {done[loop.key] && done[loop.key] !== "resuming" ? "Retry" : "Resume"}
              </button>
            )}
          </div>
        ))}
        <div className="mt-1.5 flex items-center justify-between border-t border-foreground/10 px-2 pb-1 pt-2 text-xs">
          <button
            type="button"
            onClick={() => navigate.toPluginPanel("automations")}
            className="text-muted-foreground hover:text-foreground"
          >
            Open Loops
          </button>
          {paused.filter((loop) => !loginOf(loop)).length > 1 && (
            <button
              type="button"
              onClick={() => run(paused.filter((loop) => done[loop.key] !== "resuming" && !loginOf(loop)))}
              className="flex items-center gap-1.5 font-semibold text-primary hover:underline"
            >
              <Icon name="Play" className="size-2.5 fill-current" aria-hidden />
              Resume all
            </button>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** The sidebar list's Reconnect: hover shows why the last try failed. */
function ReconnectButton({ provider, reason }: { provider: CloudLoginProvider; reason: string }) {
  const state = useReconnectState(provider);
  return (
    <button
      type="button"
      disabled={state.waiting}
      title={state.error ?? reason}
      onClick={() => reconnect(provider)}
      className={`flex h-[22px] shrink-0 items-center rounded-md border px-2 text-xs font-medium hover:bg-primary/15 disabled:opacity-50 ${state.error ? "border-destructive/50 text-destructive-text" : "border-primary/35 text-primary hover:border-primary/70"}`}
    >
      {state.waiting ? "Waiting…" : state.error ? "Retry" : "Reconnect"}
    </button>
  );
}
