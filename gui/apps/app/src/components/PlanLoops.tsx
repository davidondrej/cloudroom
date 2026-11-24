import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle } from "@cloudroom/shared-ui/dialog";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useOnboardingOpen } from "@/components/Onboarding";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import { appToast } from "@/components/ui/app-toast";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { getAppSurface } from "@/lib/app-surface";
import { callPluginRpc, useProviders, useRoomContext } from "@/lib/plugin-sdk-hooks";
import { usePopupSlot } from "@/lib/popups";
import { getPluginPanelRoutePath } from "@/lib/route-paths";

// The pop-up after buying a plan (docs/scopes/loops.md#after-buying-a-plan): "You're on Pro!", then three loop
// templates as paper tickets, turned on in the Cloud for one GitHub repo with one click. The Loops plugin decides
// who sees it and turns the loops on (gui/plugins/automations/src/plan-loops.ts). Desktop only.
type Agent = { providerId: string; model: string; level: string };
type Loop = { id: string; name: string; description: string; runsPerDay: number; needs: string };
type Project = { id: string; name: string; on: string[]; agents: Record<string, Agent | null> };
type PlanLoops = { account: string; plan: string; day: number; loops: Loop[]; projects: Project[] };
type Enabled = { added: number; failed: number; error: string | null };
const PLUGIN = "automations";
const NAMES: Record<string, string> = { pro: "Pro", super: "Super", ultra: "Ultra" };
// What each plan includes, in the words of planPerks() in web/lib/model.ts. Keep the two in step.
const SHARED = ["1:1 setup call", "H100 and B200 GPUs on demand"];
const PERKS: Record<string, string[]> = {
  pro: ["50,000 Cloud Credits every month", ...SHARED, "Agents stay awake 4× longer", "1 year storage"],
  super: ["150,000 Cloud Credits every month", ...SHARED, "Agents stay awake 8× longer", "2 year storage", "Priority Support"],
  ultra: ["500,000 Cloud Credits every month", ...SHARED, "Agents stay awake 12× longer", "5 year storage", "Slack channel with David"],
};
/** One color per ticket. */
const INKS = ["#D97757", "#E2A72B", "#7F98F5"];
const ZIGZAG = `polygon(0 0,100% 0,${Array.from({ length: 21 }, (_, index) => `${100 - index * 5}% ${index % 2 ? "100%" : "calc(100% - 10px)"}`).join(",")})`;
const every = (runs: number) => (runs === 24 ? "every hour" : runs > 0 && 24 % runs === 0 ? `every ${24 / runs} h` : `${runs}× a day`);
const rpc = (method: string, input: unknown) => callPluginRpc(fetch, PLUGIN, method, input);
/** An open Loops page reloads its Cloud loops and the plan (usePlanLoopsChanged in the Loops plugin). */
const tellLoopsPage = () => window.dispatchEvent(new Event("cloudroom:plan-loops-changed"));

const row = (label: string, value: string, bold?: boolean) => (
  <p className={cn("flex items-baseline gap-2", bold && "font-bold text-[#29251e]")}>
    <span className="shrink-0">{label}</span><span className="mb-1 flex-1 border-b border-dotted border-[#29251e]/30" /><span className="shrink-0 tabular-nums">{value}</span>
  </p>
);

/** Decides when the pop-up shows: the plugin has one for this account, setup is closed, and no other pop-up is open. */
export function PlanLoops() {
  const account = useCloudroomAccount().data;
  const user = account?.account?.id ?? null, plan = account?.plan ?? null;
  // Asked when the plan changes (the app's own account check sees a new plan within seconds) and when the window
  // comes back. A failed ask is tried again. The ask reaches the website only while a purchase waits for an answer.
  const { data } = useQuery<PlanLoops | null>({
    queryKey: ["cloudroom-plan-loops", user, plan], enabled: getAppSurface() === "desktop" && user !== null && plan !== null, retry: 3, staleTime: 30_000,
    queryFn: async () => (await rpc("plan_loops", null)) as PlanLoops | null,
  });
  const [answered, setAnswered] = useState<string | null>(null);
  const onboarding = useOnboardingOpen();
  const id = data ? `${data.account}:${data.plan}` : null;
  const wants = Boolean(data && data.account === user && NAMES[data.plan] && data.loops.length > 0 && data.projects.length > 0 && id !== answered && !onboarding);
  const open = usePopupSlot("plan", wants);
  if (!open || !data) return null;
  // Keyed by account and plan: a second purchase starts from a clean pop-up.
  return <Tickets key={id} data={data} done={() => setAnswered(id)} />;
}

function Tickets({ data, done }: { data: PlanLoops; done: () => void }) {
  const navigate = useNavigate();
  const { providers } = useProviders();
  const here = useRoomContext().projectId;
  const [picked, setPicked] = useState<string | null>(null);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void rpc("plan_loops_event", { event: "viewed" }).catch(() => {});
    // A plan bought from the Loops page: its paywall goes away behind the pop-up.
    tellLoopsPage();
  }, []);
  const enable = useMutation({
    mutationFn: async (input: { projectId: string; templates: string[] }) =>
      (await rpc("plan_loops_enable", { ...input, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })) as Enabled,
    onMutate: () => setError(null),
    onError: (failure) => setError(failure instanceof Error ? failure.message : "The loops could not be turned on."),
    onSuccess: (result, input) => {
      const lost = result.failed === 1 ? "One loop" : `${result.failed} loops`;
      if (result.failed > 0) setError(`${lost} could not be turned on: ${result.error ?? "try again"}`);
      if (result.added === 0 && result.failed > 0) return;
      const name = data.projects.find((project) => project.id === input.projectId)?.name;
      if (result.failed > 0) appToast.error(`${lost} could not be turned on. Add ${result.failed === 1 ? "it" : "them"} from Loops → Templates.`);
      if (result.added > 0) appToast.success(`${result.added} loop${result.added === 1 ? " is" : "s are"} on${name ? ` for ${name}` : ""}, in the Cloud.`);
      done();
      tellLoopsPage();
      void navigate(getPluginPanelRoutePath({ pluginId: PLUGIN, path: "automations" }));
    },
  });
  const { loops, projects } = data, busy = enable.isPending;
  const project = projects.find((candidate) => candidate.id === picked)
    ?? projects.find((candidate) => candidate.id === here && candidate.on.length < loops.length)
    ?? projects[0]!;
  const todo = loops.filter((loop) => !project.on.includes(loop.id) && project.agents[loop.id] && !off.has(loop.id));
  const close = (event: "later" | "closed") => {
    if (busy) return;
    done();
    void rpc("plan_loops_event", { event }).catch(() => {});
  };
  const toggle = (id: string) => setOff((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const name = NAMES[data.plan]!;
  return (
    // The shared dialog traps the focus and gives Escape to the top dialog only. A click outside does not close it.
    <Dialog open onOpenChange={(next) => { if (!next) close("closed"); }}>
      <DialogContent hideCloseButton aria-describedby={undefined} data-testid="plan-loops" overlayClassName="bg-black/35 backdrop-blur-[4px]"
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}
        className="flex max-h-[calc(100vh_-_72px)] min-h-[min(calc(100vh_-_72px),700px)] w-[calc(100vw_-_72px)] max-w-[1060px] flex-col gap-0 overflow-y-auto border-0 bg-[#f7f3e8] px-12 pt-12 pb-9 text-[#29251e] shadow-[0_40px_120px_rgba(0,0,0,.6)] outline-none sm:rounded-2xl [@media(max-height:780px)]:max-h-[calc(100vh_-_32px)] [@media(max-height:780px)]:min-h-0 [@media(max-height:780px)]:w-[calc(100vw_-_32px)] [@media(max-height:780px)]:pt-8 [@media(max-height:780px)]:pb-6">
        <button type="button" aria-label="Close" disabled={busy} onClick={() => close("closed")}
          className="absolute top-5 right-5 flex size-8 cursor-pointer items-center justify-center rounded-md text-[#7d735f] hover:bg-[#29251e]/8 hover:text-[#29251e]">
          <Icon name="X" className="size-4" aria-hidden="true" />
        </button>
        <p className="font-serif text-[17px] text-[#6f6655] italic">Day {data.day} on {name}</p>
        <DialogTitle className="mt-2 font-serif text-[52px] leading-[1.04] font-normal tracking-[-0.02em] [@media(max-height:780px)]:text-[42px]">You're on {name}!</DialogTitle>
        <p className="mt-3 font-serif text-[32px] leading-[1.18] tracking-[-0.015em] [@media(max-height:780px)]:mt-2 [@media(max-height:780px)]:text-[26px]">
          Enable these Loops that <em className="bg-[linear-gradient(transparent_58%,#bfff00_58%,#bfff00_92%,transparent_92%)]">top 1% of users</em> run:
        </p>
        <div className="mt-auto grid gap-x-5 pt-10 [@media(max-height:780px)]:pt-6" style={{ gridTemplateColumns: `repeat(${loops.length}, minmax(0, 1fr))` }}>
          {loops.map((loop, index) => {
            const ink = INKS[index % INKS.length]!, on = project.on.includes(loop.id), agent = project.agents[loop.id] ?? null;
            const ticked = !on && agent !== null && !off.has(loop.id);
            return (
              <div key={loop.id} className={cn("[filter:drop-shadow(0_12px_20px_rgba(60,45,20,.2))] transition-opacity", ["-rotate-[1deg]", "rotate-[0.6deg]", "-rotate-[0.6deg]"][index % 3], !ticked && "opacity-55")}>
                <div className="relative flex h-full flex-col bg-[#fffdf6] px-6 pt-8 pb-9 font-mono text-[11px] leading-[2] text-[#5f584a]" style={{ clipPath: ZIGZAG }}>
                  <span className="absolute inset-x-0 top-0 h-[8px]" style={{ background: ink }} />
                  <p className="flex items-center justify-between tracking-[0.2em] text-[#29251e]">
                    <span className="font-bold">LOOP 0{index + 1}</span>
                    {on ? <span className="font-bold text-[#3d7a00]">ON</span> : (
                      <button type="button" role="checkbox" aria-checked={ticked} aria-label={loop.name} disabled={busy || agent === null} onClick={() => toggle(loop.id)}
                        className={cn("flex size-[22px] cursor-pointer items-center justify-center border-2 border-[#29251e] disabled:cursor-default", ticked && "bg-[#bfff00]")}>
                        {ticked && <Icon name="Check" className="size-4 text-[#29251e]" aria-hidden="true" />}
                      </button>
                    )}
                  </p>
                  <span className="mt-1 flex h-[58px] items-end">
                    <span className="grid w-max grid-cols-8 gap-[3px]">
                      {Array.from({ length: Math.min(loop.runsPerDay, 24) }, (_, run) => <span key={run} className="size-[15px] rounded-[2px]" style={{ background: ink, opacity: 0.55 + 0.45 * (run / loop.runsPerDay) }} />)}
                    </span>
                  </span>
                  <p className="mt-3.5 font-serif text-[20px] leading-[1.1] tracking-[-0.015em] text-[#29251e]">{loop.name}</p>
                  <p className="mt-1.5 mb-2 font-sans text-[13px] leading-snug">{loop.description}</p>
                  <p className="mt-auto mb-2 border-t border-dashed border-[#29251e]/30" />
                  {row("Runs", every(loop.runsPerDay))}
                  {row("A day", String(loop.runsPerDay), true)}
                  {/* The agent the loop will really get on this repo, or what it needs when none here can run it. */}
                  <p className={cn("flex items-center gap-1.5 pt-1", !agent && "font-bold text-[#a23b1c]")}>
                    {agent
                      ? <><ProviderIcon providerKind="agent" provider={providers.find((candidate) => candidate.id === agent.providerId) ?? { id: agent.providerId }} className="size-3 !text-[#5f584a]" aria-hidden />{agent.model} · {agent.level}</>
                      : `Needs ${loop.needs}`}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-7 flex items-center justify-between gap-6">
          <div className="flex items-center gap-[22px]">
            <button type="button" disabled={todo.length === 0 || busy} onClick={() => enable.mutate({ projectId: project.id, templates: todo.map((loop) => loop.id) })}
              className="inline-flex h-[52px] cursor-pointer items-center gap-2.5 bg-[#29251e] px-7 text-[16px] font-semibold text-[#f7f3e8] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40">
              {busy ? "Turning on…" : todo.length === 0 ? "Pick a loop" : `Enable ${todo.length} loop${todo.length === 1 ? "" : "s"}`}
              <Icon name="ArrowRight" className="size-4" aria-hidden="true" />
            </button>
            <button type="button" disabled={busy} onClick={() => close("later")} className="cursor-pointer text-[14px] text-[#7d735f] underline underline-offset-4 hover:text-[#29251e]">Maybe later</button>
          </div>
          <label className="relative flex items-center gap-1.5 text-[12.5px] text-[#8d8676]">
            Runs on <Icon name="GithubLogo" className="size-3.5" aria-hidden="true" />
            <span className="font-semibold text-[#29251e]">{project.name}</span>
            {projects.length > 1 && (
              <>
                <Icon name="ChevronDown" className="size-3.5" aria-hidden="true" />
                <select aria-label="Repo to run on" value={project.id} disabled={busy} onChange={(event) => setPicked(event.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
                  {projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.on.length >= loops.length ? " (already on)" : ""}</option>)}
                </select>
              </>
            )}
          </label>
        </div>
        {error && <p role="alert" className="mt-3 text-[13px] text-[#a23b1c]">{error}</p>}
        <p className="mt-5 flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-dotted border-[#29251e]/30 pt-3.5 font-mono text-[10.5px] text-[#6f6655] [@media(max-height:720px)]:hidden">
          <span className="-rotate-[4deg] border-2 border-[#3d7a00] px-1.5 font-black tracking-[0.15em] text-[#3d7a00]">PAID</span>
          {(PERKS[data.plan] ?? []).map((perk) => <span key={perk} className="flex items-center gap-1 whitespace-nowrap"><Icon name="Check" className="size-3 text-[#3d7a00]" aria-hidden="true" />{perk}</span>)}
        </p>
      </DialogContent>
    </Dialog>
  );
}
