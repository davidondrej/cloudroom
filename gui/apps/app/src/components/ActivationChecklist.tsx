import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom, useAtomValue } from "jotai";
import { matchPath, useLocation, useNavigate } from "react-router";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Switch } from "@cloudroom/shared-ui/switch";
import { useCorner } from "@cloudroom/shared-ui/lib/corner";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@cloudroom/shared-ui/tooltip";
import { appToast } from "@/components/ui/app-toast";
import { SettingsWithControl } from "@/components/ui/settings-section";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { oneClickScanStateQueryKey } from "@/hooks/queries/query-keys";
import { createBooleanPreferenceAtom } from "@/lib/browser-storage";
import { useChecklistHides, useHiddenUntil } from "@/lib/popups";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { callPluginRpc } from "@/lib/plugin-sdk-hooks";
import { getPluginConfigurationRoutePath, getRootComposeRoutePath, getThreadRoutePath, LEGACY_PROJECT_COMPOSE_ROUTE_PATH } from "@/lib/route-paths";
import { openUpgrade, useUpgradePromptViewed } from "@/lib/upgrade-prompt";
import { selectCloudForNewThreads } from "@/components/promptbox/NewThreadComposer";

type Step = "cloud" | "subagents" | "second" | "phone" | "loop";
type Activation = { steps: Record<Step, boolean>; second: "codex" | "claude-code"; started: number };

const STEPS: { id: Step; title: string; prompt?: (second: string) => string }[] = [
  { id: "cloud", title: "Start a Cloud agent", prompt: () => "Check this repo for security issues found this week. Report only, don't change anything." },
  { id: "subagents", title: "Run 3 agents at once", prompt: () => "Start 3 sub-agents. Tell each of them to check a different part of this repo for security vulnerabilities. Report only." },
  { id: "second", title: "Get a second opinion", prompt: (second) => `Start a ${second} sub-agent to review the last commit on this branch. Report only.` },
  { id: "phone", title: "Open Cloudroom on your phone" },
  { id: "loop", title: "Set up a daily Loop", prompt: () => "Create a Cloud loop for this repo that runs every weekday at 9am: check for new security issues and only tell me if you find one." },
];
// Free plans: each Hide lasts longer, by the account's hides so far (8 hours, 3 days, then 7 days).
const HIDES = [{ ms: 8 * 3_600_000, label: "8 hours" }, { ms: 3 * 86_400_000, label: "3 days" }, { ms: 7 * 86_400_000, label: "7 days" }];
const hideFor = (hides: number | null) => HIDES[Math.min(hides ?? 0, HIDES.length - 1)];
const RETIRED_AT = 50; // threads started: an active user doesn't need the checklist
const HIDDEN_KEY = "cloudroom.activation.hiddenUntil";

function useActivation() {
  const account = useCloudroomAccount().data;
  const enabled = Boolean(account?.account) && !account?.selfHosted && !account?.cloudQueue?.regionBlocked;
  const { data } = useQuery({
    queryKey: ["cloudroom-activation"], enabled, refetchInterval: 30_000,
    queryFn: async ({ signal }) => {
      const response = await fetchWithAppSurface("/api/v1/cloudroom/activation", { signal });
      if (!response.ok) throw new Error("The checklist is unavailable.");
      return await response.json() as Activation;
    },
  });
  return enabled ? data : undefined;
}

// One-click scans (docs/scopes/onboarding.md): two doors under the new-thread box, one per scan in the Loops
// plugin. A click starts the scan; it ends with loops made for that user. They replaced the one-click prompts.
type ScanKind = "workflow" | "cyber";
type ScanAgent = { id: string; name: string; sessions: number; days: number[] };
/** Per kind: the last scan's thread on this computer (if it still exists), and whether one ever started here. */
type ScanState = Record<ScanKind, { thread: string | null; used: boolean }>;
const CELL_OFF = "color-mix(in srgb, currentColor 7%, transparent)";
const BLUE = "#4F9BFF", GREEN = "#34D399", YELLOW = "#F6C945", ORANGE = "#F5873A", RED = "#EF4444";
/** A fixed scatter, so each square keeps its color between renders. */
const scatter = (week: number, day: number) => (week * 37 + day * 53 + week * day * 11) % 17;
/** Workflow squares: each day is blue or green; how bright says how busy it was. */
const workColor = (week: number, day: number) => scatter(week + 3, day + 1) % 2 ? BLUE : GREEN;
/** The Cyber door's grid is a picture, not data: nothing is scanned before the click. Mostly red, more of them to the right. */
const RISK = Array.from({ length: 9 }, (_, week) => Array.from({ length: 7 }, (_, day) => {
  const n = scatter(week, day);
  return n < week * 1.7 - 3 ? [YELLOW, ORANGE, RED, RED, RED][n % 5] : null;
}));
const SCANS_PLUGIN = "automations";

const alwaysShowScansAtom = createBooleanPreferenceAtom("cloudroom.oneClickScans.alwaysShow", false);
export const ONE_CLICK_SCANS_SETTING_LABEL = "Always show one-click scans";

export function OneClickScansSetting() {
  const [always, setAlways] = useAtom(alwaysShowScansAtom);
  return (
    <SettingsWithControl label={ONE_CLICK_SCANS_SETTING_LABEL} description="Keep them under the new-thread box, even after 10 threads. Off: new users only.">
      <Switch checked={always} onCheckedChange={setAlways} aria-label={ONE_CLICK_SCANS_SETTING_LABEL} />
    </SettingsWithControl>
  );
}

const SCAN_RETRY = { retry: 4, retryDelay: (attempt: number) => 1000 * 2 ** attempt };
/** The agents with chats on this computer, most sessions first. The Loops plugin counts file names, never chat text.
 *  Each call logs a scan view, so no refetch on focus. Retries (1+2+4+8 s) ride out the plugin still starting at launch. */
function useScanAgents(enabled: boolean) {
  return useQuery({
    queryKey: ["one-click-scans", "agents"], enabled, staleTime: 10 * 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false, ...SCAN_RETRY,
    queryFn: async () => ((await callPluginRpc(fetch, SCANS_PLUGIN, "scans_agent_sessions", { source: "new_thread" })) as { agents: ScanAgent[] }).agents,
  });
}
function useScanState(enabled: boolean) {
  return useQuery({ queryKey: oneClickScanStateQueryKey(), enabled, ...SCAN_RETRY, queryFn: async () => (await callPluginRpc(fetch, SCANS_PLUGIN, "scans_state", null)) as ScanState });
}

/** `plan` is null until the website answers, up to 10 s after launch: no doors before it, so no one sees the
 *  wrong buttons. `onScreen`: the scan call runs only where the doors can show. */
function useScansShown(data: Activation | undefined, onScreen = true) {
  const always = useAtomValue(alwaysShowScansAtom);
  const plan = useCloudroomAccount().data?.plan;
  const wanted = data !== undefined && plan != null && (always || data.started <= 10);
  const agents = useScanAgents(wanted && onScreen);
  const state = useScanState(wanted && onScreen);
  return { wanted, plan, agents: wanted ? agents.data : undefined, state: wanted ? state.data : undefined, failed: wanted && (agents.isError || state.isError) };
}

function ScanDoor({ kind, label, title, cta, color, onClick, disabled, children }: { kind: ScanKind; label: string; title: ReactNode; cta: string; color: string; onClick: () => void; disabled: boolean; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className="relative flex h-[176px] cursor-pointer flex-col items-start overflow-hidden rounded-[10px] bg-[#0c0c0c] px-4 pt-[24px] text-left text-[#F5F0E1] ring-1 ring-[#F5F0E1]/15 outline-none ring-inset hover:ring-[#F5F0E1]/30 focus-visible:ring-2 focus-visible:ring-[#F5F0E1]/60 disabled:cursor-default">
      <span aria-hidden className="pointer-events-none absolute -right-[30px] -bottom-[22px] flex origin-bottom-right -rotate-[14deg] gap-[3px]">{children}</span>
      <span className="relative block font-mono text-[10px] tracking-[0.16em] uppercase" style={{ color }}>{label}</span>
      <span className="relative mt-2 block text-[27px] leading-[1.05] font-extrabold tracking-[-0.045em]">{title}</span>
      <span className={cn("absolute bottom-4 left-4 flex h-8 items-center gap-[7px] rounded-[7px] px-3.5 text-[13px] font-semibold text-[#0a0a0a]", kind === "workflow" ? "bg-[#8C8C8C]" : "bg-[#BFFF00]")}>
        {cta}<Icon name="ArrowRight" className="size-3.5" aria-hidden />
      </span>
    </button>
  );
}

/** The one-click scans, or `fallback` once they're gone. Never both, and nothing while loading, so nothing flashes.
 *  Free plans get the first scan of each kind free; after a scan, its door opens that scan (David, 2026-11-19). */
export function OneClickScans({ fallback }: { fallback?: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const data = useActivation();
  const { wanted, plan, agents, state, failed } = useScansShown(data);
  const [starting, setStarting] = useState<ScanKind | null>(null);
  const free = plan === "free";
  const shown = wanted && agents !== undefined && state !== undefined;
  // The Workflow scan reads past chats, so with none on this computer only the Cyber scan shows.
  const top = agents?.[0];
  const kinds: ScanKind[] = top ? ["workflow", "cyber"] : ["cyber"];
  const upgrade = (kind: ScanKind) => free && state !== undefined && state[kind].used && !state[kind].thread;
  useUpgradePromptViewed(shown && kinds.some(upgrade) ? "one_click_scan" : null);
  if (!shown) return data === undefined || (wanted && !failed) ? null : fallback;
  const open = (threadId: string) => void navigate(getThreadRoutePath({ projectId: PERSONAL_PROJECT_ID, threadId }));
  const start = (kind: ScanKind) => {
    setStarting(kind);
    callPluginRpc(fetch, SCANS_PLUGIN, "scans_start", { kind, source: "new_thread" }).then(
      (result) => {
        const { threadId } = result as { threadId: string };
        queryClient.setQueryData<ScanState>(oneClickScanStateQueryKey(), (old) => old && { ...old, [kind]: { thread: threadId, used: true } });
        open(threadId);
      },
      (error: unknown) => { setStarting(null); appToast.error(error instanceof Error ? error.message : "The scan could not start."); },
    );
  };
  const door = (kind: ScanKind, label: string) => {
    const thread = state[kind].thread;
    if (thread) return { cta: "Open your scan", onClick: () => open(thread) };
    if (upgrade(kind)) return { cta: "Upgrade to scan", onClick: () => openUpgrade("one_click_scan") };
    return { cta: starting === kind ? "Starting…" : label, onClick: () => start(kind) };
  };
  const days = top?.days.slice(-63) ?? [], max = Math.max(...(top?.days ?? []), 1);
  return (
    <section aria-label="One-click scans" className="mt-8 px-3.5 max-md:hidden">
      <div className={cn("grid gap-3", top ? "grid-cols-2" : "grid-cols-1")}>
        {top ? (
          <ScanDoor kind="workflow" label="Workflow · Scan" title={<>See how you<br />actually work.</>} {...door("workflow", "Scan my workflow")} color={BLUE} disabled={starting !== null}>
            {Array.from({ length: Math.ceil(days.length / 7) }, (_, week) => (
              <span key={week} className="flex flex-col gap-[3px]">
                {days.slice(week * 7, week * 7 + 7).map((count, day) => (
                  <span key={day} className="size-[15px] rounded-[2.5px]" style={count === 0 ? { background: CELL_OFF } : { background: workColor(week, day), opacity: 0.4 + 0.6 * Math.sqrt(count / max) }} />
                ))}
              </span>
            ))}
          </ScanDoor>
        ) : null}
        <ScanDoor kind="cyber" label="Cyber · Scan" title={<>Find what's<br />exposed.</>} {...door("cyber", "Cyber scan")} color={RED} disabled={starting !== null}>
          {RISK.map((week, index) => (
            <span key={index} className="flex flex-col gap-[3px]">
              {week.map((color, day) => <span key={day} className="size-[15px] rounded-[2.5px]" style={color ? { background: color, opacity: 0.6 + 0.05 * index } : { background: CELL_OFF }} />)}
            </span>
          ))}
        </ScanDoor>
      </div>
      <p className="mt-3 text-center text-xs text-muted-foreground/70">{free && kinds.some((kind) => !state[kind].used) ? "Your first scan of each kind is free." : "Read only. Each scan ends with loops made for you."}</p>
    </section>
  );
}

const onResize = (notify: () => void) => { window.addEventListener("resize", notify); return () => window.removeEventListener("resize", notify); };

/** Where a card in the top right corner starts, in pixels: under the header, or below the new-thread composer so it
 *  never covers it. Below the one-click scans too, unless the window is too short for the tallest card (the
 *  checklist, about 265px) to fit under them: then it moves up over the doors' right edge and stays whole. */
export function useCornerTop(): number {
  const { pathname } = useLocation();
  const composing = pathname === getRootComposeRoutePath() || matchPath(LEGACY_PROJECT_COMPOSE_ROUTE_PATH, pathname) !== null;
  const { wanted, failed } = useScansShown(useActivation(), composing);
  const height = useSyncExternalStore(onResize, () => window.innerHeight);
  return !composing ? 52 : wanted && !failed ? Math.max(260, Math.min(475, height - 285)) : 260;
}

export function ActivationChecklist() {
  const navigate = useNavigate();
  const hidden = useHiddenUntil(HIDDEN_KEY);
  const data = useActivation();
  const plan = useCloudroomAccount().data?.plan;
  const paid = Boolean(plan && plan !== "free");
  const [hides, saveHides] = useChecklistHides();
  const next = data && STEPS.find((step) => !data.steps[step.id]);
  const wanted = data !== undefined && next !== undefined && !hidden.hidden && data.started < RETIRED_AT && !(paid && (hides === null || hides >= 2));
  // The corner module (docs/scopes/corner-cards.md) decides whether it shows: it comes before the promo cards.
  const corner = useCorner("checklist", wanted ? "" : null);
  if (!data || !next || !corner) return null;
  const done = STEPS.filter((step) => data.steps[step.id]).length;
  const report = (step: Step, action: "clicked" | "hidden") =>
    fetchWithAppSurface("/api/v1/cloudroom/activation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step, action }) })
      .then((response) => response.json() as Promise<{ hides?: number | null }>).catch(() => ({ hides: null }));
  const hide = () => {
    corner.answer("closed");
    hidden.hideFor((paid ? HIDES[0] : hideFor(hides)).ms);
    void report(next.id, "hidden").then(({ hides: saved }) => { if (typeof saved === "number") saveHides(saved); });
  };
  const start = (step: (typeof STEPS)[number]) => {
    void report(step.id, "clicked");
    if (!step.prompt) return navigate(getPluginConfigurationRoutePath({ pluginId: "connect" }));
    selectCloudForNewThreads();
    void navigate(getRootComposeRoutePath(), {
      state: { focusPrompt: true, initialPrompt: step.prompt(data.second === "codex" ? "Codex" : "Claude Code"), replaceInitialPrompt: true, executionTarget: "cloud" },
    });
  };
  return (
    <section aria-label="Get started" style={corner.style} className={cn(corner.className, "w-[320px] overflow-hidden rounded-[14px] border border-foreground/10 bg-surface-raised-solid shadow-[0_24px_60px_rgba(0,0,0,.45),0_4px_14px_rgba(0,0,0,.25)]")}>
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-baseline">
          <p className="text-sm font-semibold text-foreground">Get started</p>
          <p className="ml-auto text-xs text-muted-foreground">{done} of {STEPS.length}</p>
        </div>
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-foreground/10">
          <div className="h-full rounded-full bg-primary" style={{ width: `${(done / STEPS.length) * 100}%` }} />
        </div>
      </div>
      <ul className="px-2">
        {STEPS.map((step) => {
          const isDone = data.steps[step.id], isNext = step === next;
          return (
            <li key={step.id}>
              <button type="button" disabled={isDone} onClick={() => start(step)}
                className={cn("group flex w-full items-center gap-2.5 rounded-[9px] p-2 text-left text-[13px]", isNext && "bg-foreground/[0.06]", !isDone && "hover:bg-foreground/[0.06]")}>
                <span className={cn("flex size-[18px] shrink-0 items-center justify-center rounded-full", isDone ? "bg-primary text-primary-foreground" : "ring-[1.5px] ring-inset", isNext ? "ring-primary" : "ring-foreground/25")}>
                  {isDone ? <Icon name="Check" className="size-3" aria-label="Done" /> : isNext ? <span className="size-1.5 rounded-full bg-primary" /> : null}
                </span>
                <span className={cn(isDone ? "text-muted-foreground/70 line-through decoration-foreground/25" : isNext ? "font-medium text-foreground" : "text-foreground/70")}>{step.title}</span>
                {isDone ? null : (
                  <span className={cn("ml-auto flex items-center gap-0.5 text-xs font-semibold text-primary-text", !isNext && "hidden group-hover:flex")}>
                    Start<Icon name="ArrowRight" className="size-3.5" aria-hidden />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end px-3 pb-2">
        <TooltipProvider delayDuration={2000}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={hide} className="rounded px-1 text-[11px] text-muted-foreground/50 hover:text-muted-foreground">Hide</button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {!paid ? `Hides this for ${hideFor(hides).label}. It goes away for good once you finish all 5 steps or start ${RETIRED_AT} threads.`
                : hides ? "Hide it now and it's gone for good." : "Hides this for 8 hours. Hide it twice and it's gone for good."}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </section>
  );
}
