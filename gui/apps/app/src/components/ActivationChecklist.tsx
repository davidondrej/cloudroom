import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtom, useAtomValue } from "jotai";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@cloudroom/shared-ui/hover-card";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Switch } from "@cloudroom/shared-ui/switch";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@cloudroom/shared-ui/tooltip";
import { SettingsWithControl } from "@/components/ui/settings-section";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { createBooleanPreferenceAtom } from "@/lib/browser-storage";
import { useIsNativeBrowserViewShown } from "@/hooks/useBrowserDimmingModal";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { getPluginConfigurationRoutePath, getRootComposeRoutePath, LEGACY_PROJECT_COMPOSE_ROUTE_PATH } from "@/lib/route-paths";
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
const HIDE_MS = 8 * 60 * 60 * 1000;
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

const REPOS = "my 3 newest repos on my computer (`room-cli mac run`) or GitHub (`gh`)";
const SUBAGENTS = "Split the work across 4-7 sub-agents with `--reasoning-level high`, on `--provider claude-code --model claude-haiku-5-5` or `--provider codex --model gpt-6.1-terra` (whichever you are).";
const STARTERS = [
  {
    id: "security", title: "Find security holes", about: "4-7 agents check your newest repos, on this Mac or GitHub, for security holes. One list, worst first.",
    prompt: `Find security holes in ${REPOS}. ${SUBAGENTS} Read only; give me one list, worst first.`,
  },
  {
    id: "keys", title: "Check for leaked keys", about: "4-7 agents search your newest repos and their git history for leaked API keys and passwords.",
    prompt: `Find leaked API keys and passwords in ${REPOS}, including git history. ${SUBAGENTS} Read only; never print a full secret, just tell me what to rotate.`,
  },
  {
    id: "packages", title: "Check my packages", about: "4-7 agents check your newest repos for packages with known security problems or hacked versions.",
    prompt: `Check ${REPOS} for vulnerable or hacked packages. ${SUBAGENTS} Read only; list only real problems, with the fix.`,
  },
  {
    id: "mac", title: "Scan my Mac", about: "4-7 agents check your Mac's firewall, disk encryption, updates, open ports, and login items.",
    prompt: `Security-check my Mac with \`room-cli mac run\`: firewall, FileVault, updates, open ports, and login items. ${SUBAGENTS} Read only; give me a short list of what to fix.`,
  },
] as const;

const alwaysShowStartersAtom = createBooleanPreferenceAtom("cloudroom.starterPrompts.alwaysShow", false);
export const STARTER_PROMPTS_SETTING_LABEL = "Always show one-click prompts";

export function StarterPromptsSetting() {
  const [always, setAlways] = useAtom(alwaysShowStartersAtom);
  return (
    <SettingsWithControl label={STARTER_PROMPTS_SETTING_LABEL} description="Keep them under the new-thread box, even after 10 threads. Off: new users only.">
      <Switch checked={always} onCheckedChange={setAlways} aria-label={STARTER_PROMPTS_SETTING_LABEL} />
    </SettingsWithControl>
  );
}

function useStartersShown(data: Activation | undefined) {
  const always = useAtomValue(alwaysShowStartersAtom);
  return data !== undefined && (always || data.started <= 10);
}

export function StarterPrompts({ onPick }: { onPick: (prompt: string) => void }) {
  const data = useActivation();
  if (!useStartersShown(data)) return null;
  const pick = (starter: (typeof STARTERS)[number]) => {
    void fetchWithAppSurface("/api/v1/cloudroom/activation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ starter: starter.id }) }).catch(() => {});
    onPick(starter.prompt);
  };
  return (
    <section aria-label="One-click prompts" className="mt-8 px-3.5 max-md:hidden">
      <div className="flex items-center gap-3.5 text-xs text-muted-foreground/80">
        <span className="h-px flex-1 bg-foreground/10" />One-click prompts<span className="h-px flex-1 bg-foreground/10" />
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {STARTERS.map((starter) => (
          <HoverCard key={starter.id} openDelay={250} closeDelay={100}>
            <HoverCardTrigger asChild>
              <button type="button" onClick={() => pick(starter)} className="rounded-full bg-foreground/[0.06] px-3.5 py-1.5 text-[13px] text-foreground/75 hover:bg-foreground/10 hover:text-foreground">
                {starter.title}
              </button>
            </HoverCardTrigger>
            <HoverCardContent align="start" sideOffset={8} className="w-[340px] space-y-1.5 border-foreground/10 px-3.5 py-3">
              <p className="text-[13px] font-medium text-foreground">{starter.title}</p>
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">{starter.about}</p>
              <p className="flex gap-3 pt-1 text-[11.5px] text-muted-foreground/70">
                <span className="flex items-center gap-1"><Icon name="Cloud" className="size-3" aria-hidden />Cloud</span>
                <span className="flex items-center gap-1"><Icon name="Eye" className="size-3" aria-hidden />Read only</span>
                <span className="flex items-center gap-1"><Icon name="Clock" className="size-3" aria-hidden />~5 min</span>
              </p>
            </HoverCardContent>
          </HoverCard>
        ))}
      </div>
    </section>
  );
}

export function ActivationChecklist() {
  const navigate = useNavigate();
  const [hiddenUntil, setHiddenUntil] = useState(() => Number(localStorage.getItem(HIDDEN_KEY)) || 0);
  useEffect(() => {
    const left = hiddenUntil - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setHiddenUntil(0), left);
    return () => clearTimeout(timer);
  }, [hiddenUntil]);
  const nativeBrowserShown = useIsNativeBrowserViewShown();
  const { pathname } = useLocation();
  const composing = pathname === getRootComposeRoutePath() || matchPath(LEGACY_PROJECT_COMPOSE_ROUTE_PATH, pathname) !== null;
  const data = useActivation();
  const startersShown = useStartersShown(data);
  if (!data || hiddenUntil > Date.now() || nativeBrowserShown) return null;
  const done = STEPS.filter((step) => data.steps[step.id]).length;
  const next = STEPS.find((step) => !data.steps[step.id]);
  if (!next) return null;
  const report = (step: Step, action: "clicked" | "hidden") =>
    void fetchWithAppSurface("/api/v1/cloudroom/activation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step, action }) }).catch(() => {});
  const hide = () => {
    const until = Date.now() + HIDE_MS;
    localStorage.setItem(HIDDEN_KEY, String(until));
    setHiddenUntil(until);
    report(next.id, "hidden");
  };
  const start = (step: (typeof STEPS)[number]) => {
    report(step.id, "clicked");
    if (!step.prompt) return navigate(getPluginConfigurationRoutePath({ pluginId: "connect" }));
    selectCloudForNewThreads();
    void navigate(getRootComposeRoutePath(), {
      state: { focusPrompt: true, initialPrompt: step.prompt(data.second === "codex" ? "Codex" : "Claude Code"), replaceInitialPrompt: true },
    });
  };
  return (
    <section aria-label="Get started" className={cn("fixed right-5 z-40", !composing ? "top-[52px]" : startersShown ? "top-[350px]" : "top-[260px]", "w-[320px] overflow-hidden rounded-[14px] border border-foreground/10 bg-surface-raised-solid shadow-[0_24px_60px_rgba(0,0,0,.45),0_4px_14px_rgba(0,0,0,.25)] max-md:hidden")}>
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
            <TooltipContent side="bottom">Hides this for 8 hours. It goes away for good once you finish all 5 steps.</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </section>
  );
}
