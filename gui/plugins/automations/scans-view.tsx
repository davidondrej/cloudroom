import { useEffect, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@cloudroom/shared-ui/icon";
import { showLoopError } from "./cloud-view";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import type { automationRpcContract } from "./src/rpc.js";
import type { AgentSessions } from "./src/agent-sessions.js";

export type Agent = AgentSessions["agents"][number];
type ScanKind = "workflow" | "cyber";
/** Per kind: whether a scan ever started on this computer, and the thread of one that is running now. */
type ScanState = Record<ScanKind, { used: boolean; running: string | null }>;

export const COLORS: Record<string, string> = {
  "claude-code": "#D97757",
  codex: "#8FA8FF",
  pi: "#C792EA",
  "acp-opencode": "currentColor",
  "acp-hermes-agent": "#F2C94C",
};
const fmt = (n: number) => n.toLocaleString("en-US");

// The Scans tab (David, 2026-11-27, docs/scopes/workflow-scan.md): one big card per scan, in the look of the
// one-click scans under the new-thread box (ActivationChecklist.tsx). The whole card is the button.
const BLUE = "#4F9BFF", GREEN = "#34D399", YELLOW = "#F6C945", ORANGE = "#F5873A", RED = "#EF4444";
const OFF = "color-mix(in srgb, currentColor 7%, transparent)";
const COLUMNS = 16, ROWS = 7;
/** One pass of the beam across a card, in seconds. Twice as fast while that scan runs. */
const SWEEP = 4;
const ANIMATION = `
@keyframes cr-scan-beam { from { transform: translateX(-100%) } to { transform: translateX(0) } }
@keyframes cr-scan-lit { 0% { opacity: .2; filter: none } 2.5% { opacity: 1; filter: brightness(2) } 14% { opacity: 1; filter: brightness(1.2) } 62% { opacity: .7; filter: none } 100% { opacity: .2; filter: none } }
.cr-scan-beam { animation: cr-scan-beam linear infinite; }
.cr-scan-lit { animation: cr-scan-lit linear infinite; }
@media (prefers-reduced-motion: reduce) { .cr-scan-beam { display: none } .cr-scan-lit { animation: none } }`;

/** A card's squares are a picture, not data: nothing is scanned before the click. A fixed scatter (from `seed`),
 *  so it never changes between renders: `share` of the squares are on, each with its own brightness.
 *  Returns one color per square, row by row, or null for a square that is off. */
function scatter(seed: number, share: number, color: (pick: number) => string): (string | null)[] {
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: COLUMNS * ROWS }, () => {
    const on = random() < share, strength = 0.51 + 0.49 * random() ** 1.6, pick = random();
    return on ? `color-mix(in srgb, ${color(pick)} ${Math.round(strength * 100)}%, transparent)` : null;
  });
}
const KINDS = {
  workflow: {
    name: "Workflow",
    color: BLUE,
    glow: "ring-[#4F9BFF] shadow-[0_0_48px_-12px_#4F9BFF]",
    squares: scatter(11, 0.5, (pick) => (pick < 0.5 ? BLUE : GREEN)),
  },
  // Cyber has fewer squares on than Workflow (39 and 45), so it looks quieter next to it (David, 2026-11-27).
  cyber: {
    name: "Cyber",
    color: RED,
    glow: "ring-[#EF4444] shadow-[0_0_48px_-12px_#EF4444]",
    squares: scatter(29, 0.28, (pick) => (pick < 0.6 ? RED : pick < 0.85 ? ORANGE : YELLOW)),
  },
};

export function ScansTabLabel() {
  return (
    <span className="inline-flex items-center gap-1.5">
      Scans
      <span className="inline-flex h-4 items-center rounded-full border border-primary/50 bg-primary/10 px-2 text-[9px] leading-none font-bold tracking-wider text-primary uppercase">
        New
      </span>
    </span>
  );
}

export function ScansView() {
  const rpc = useRpc<typeof automationRpcContract>();
  const navigate = useBbNavigate();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [plan, setPlan] = useState<string | null | undefined>(undefined);
  const [starting, setStarting] = useState<ScanKind | null>(null);
  // `used`: a Free plan's first scan of each kind is free (David, 2026-11-19).
  // `running`: its card opens that scan instead of starting a second one. People started scans again and again,
  // because nothing showed that one was already running (David, 2026-11-26).
  const [state, setState] = useState<ScanState | null>(null);
  const anyRunning = Boolean(state?.workflow.running || state?.cyber.running);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      rpc.call("scans_state", null).then(
        ({ workflow, cyber }) =>
          !cancelled &&
          setState({
            workflow: { used: workflow.used, running: workflow.running ? workflow.thread : null },
            cyber: { used: cyber.used, running: cyber.running ? cyber.thread : null },
          }),
        // Unknown counts as unused and not running: the server still refuses a second free scan.
        () => !cancelled && setState((old) => old ?? { workflow: { used: false, running: null }, cyber: { used: false, running: null } }),
      );
    void load();
    // While a scan runs, ask again every 5 s, so its card goes back to normal when it ends. The call stays on
    // this computer (the plugin's own storage and the thread's status): no website or database call.
    const timer = anyRunning ? setInterval(() => !document.hidden && void load(), 5_000) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [rpc, anyRunning]);
  useEffect(() => {
    let cancelled = false;
    rpc.call("scans_agent_sessions", null).then(
      (result) => !cancelled && setAgents(result.agents),
      () => !cancelled && setAgents([]),
    );
    rpc.call("account_plan", null).then(
      (result) => !cancelled && setPlan(result.plan),
      () => !cancelled && setPlan(null),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  const free = plan === "free";
  const upgrade = (kind: ScanKind) => free && state !== null && state[kind].used;
  const start = (kind: ScanKind) => {
    if (upgrade(kind)) {
      rpc.call("scans_upgrade_clicked", null).catch(() => {});
      return navigate.openUrl("https://www.cloudroom.dev/billing");
    }
    setStarting(kind);
    rpc.call("scans_start", { kind }).then(
      ({ threadId }) => navigate.toThread(threadId),
      (error: unknown) => {
        setStarting(null);
        showLoopError(
          error instanceof Error ? error.message : "The scan could not start.",
          () => navigate.openUrl("https://www.cloudroom.dev/billing"),
        );
      },
    );
  };
  const chats = (agents ?? []).reduce((sum, agent) => sum + agent.sessions, 0);
  // The Workflow scan reads past chats, so with none on this computer it cannot start.
  const noChats = agents !== null && agents.length === 0;
  const door = (kind: ScanKind) => {
    const running = state?.[kind].running ?? null;
    return {
      kind,
      running: running !== null,
      disabled: running === null && (starting !== null || plan === undefined || state === null || (kind === "workflow" && !agents?.length)),
      cta: running ? "Open your scan" : upgrade(kind) ? "Upgrade to scan" : starting === kind ? "Starting…" : kind === "workflow" ? "Scan my workflow" : "Cyber scan",
      onClick: () => (running ? navigate.toThread(running) : start(kind)),
    };
  };
  const runningBody = "Your scan is running. It ends with loops for you to approve. Open it to watch.";
  const workflow = door("workflow"), cyber = door("cyber");
  return (
    <div className="@container mx-auto w-full max-w-5xl pb-10">
      <style>{ANIMATION}</style>
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
        <ScanDoor
          {...workflow}
          dim={noChats}
          title={workflow.running ? <>Reading your<br />{chats ? `${fmt(chats)} chats…` : "chats…"}</> : <>See how you<br />actually work.</>}
          body={
            workflow.running
              ? runningBody
              : agents === null
                ? "Reads your past chats. Gives you 3 loops that do that work."
                : noChats
                  ? "No agent chats on this computer yet. Chat with Claude Code or Codex first."
                  : `Reads ${fmt(chats)} chats from ${agents.length} ${agents.length === 1 ? "agent" : "agents"}. Gives you 3 loops that do that work.`
          }
        />
        <ScanDoor
          {...cyber}
          title={cyber.running ? <>Finding what's<br />exposed…</> : <>Find what's<br />exposed.</>}
          body={cyber.running ? runningBody : "Checks this computer and your repos for known CVEs and leaked keys. Gives you 2 loops."}
        />
      </div>
      <p className="mt-3 text-center text-xs text-muted-foreground/70">
        {free && state !== null && !(state.workflow.used && state.cyber.used) ? "Your first scan of each kind is free." : "Read only. Each scan ends with loops made for you."}
      </p>
    </div>
  );
}

function ScanDoor({ kind, title, body, cta, running, disabled, dim, onClick }: {
  kind: ScanKind;
  title: ReactNode;
  body: string;
  cta: string;
  running: boolean;
  disabled: boolean;
  dim?: boolean;
  onClick: () => void;
}) {
  const { name, color, glow, squares } = KINDS[kind];
  const sweep = running ? SWEEP / 2 : SWEEP;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative flex h-[560px] cursor-pointer overflow-hidden rounded-[10px] bg-[#0c0c0c] text-left text-[#F5F0E1] outline-none ring-inset focus-visible:ring-2 focus-visible:ring-[#F5F0E1]/60 disabled:cursor-default",
        running ? cn("ring-[1.5px]", glow) : "ring-1 ring-[#F5F0E1]/15 enabled:hover:ring-[#F5F0E1]/30",
      )}
    >
      {/* The squares across the card. A beam sweeps left to right, and each column lights up as the beam reaches it. */}
      <span aria-hidden className="pointer-events-none absolute top-[250px] left-7 block w-[calc(100%-56px)] max-w-[448px] overflow-hidden py-[10px]">
        <span className="flex gap-[3px]">
          {Array.from({ length: COLUMNS }, (_, column) => (
            <span key={column} className="cr-scan-lit flex flex-1 flex-col gap-[3px]" style={{ animationDuration: `${sweep}s`, animationDelay: `${(sweep * column) / COLUMNS - sweep}s` }}>
              {Array.from({ length: ROWS }, (_, row) => (
                <span key={row} className="aspect-square w-full rounded-[3px]" style={{ background: squares[row * COLUMNS + column] ?? OFF }} />
              ))}
            </span>
          ))}
        </span>
        <span
          className="cr-scan-beam absolute inset-0"
          style={{ animationDuration: `${sweep}s`, background: `linear-gradient(90deg, transparent calc(100% - 90px), color-mix(in srgb, ${color} 32%, transparent))`, borderRight: `2px solid ${color}` }}
        />
      </span>
      <span className="relative flex min-w-0 flex-col items-start px-7 pt-8">
        <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.16em] uppercase" style={{ color }}>
          {running ? (
            <span className="relative flex size-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-75" />
              <span className="relative size-2 rounded-full bg-current" />
            </span>
          ) : null}
          {name} · {running ? "Running now" : "Scan"}
        </span>
        <span className="mt-2 block text-[46px] leading-[1.05] font-extrabold tracking-[-0.045em]">{title}</span>
        <span className="mt-3 block max-w-[290px] text-[15px] leading-snug text-[#F5F0E1]/55">{body}</span>
      </span>
      <span className={cn("absolute bottom-7 left-7 flex h-11 items-center gap-2 rounded-[7px] bg-[#BFFF00] px-5 text-[15px] font-semibold text-[#0a0a0a]", dim && "opacity-50")}>
        {cta}
        <Icon name="ArrowRight" className="size-4" aria-hidden />
      </span>
    </button>
  );
}
