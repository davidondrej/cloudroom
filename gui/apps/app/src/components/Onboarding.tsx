import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { atom, useAtom, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { deriveProjectNameFromPath } from "@cloudroom/domain";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { ClaudeConnectionButton, useClaudeConnection } from "@/components/ClaudeConnection";
import { openCodexConnection } from "@/components/CodexConnectionPanel";
import { selectCloudForNewThreads } from "@/components/promptbox/NewThreadComposer";
import { ImportChats } from "@/components/settings/ImportChats";
import { BbLogo } from "@/components/ui/bb-logo";
import { appToast } from "@/components/ui/app-toast";
import { useCreateProject } from "@/hooks/mutations/project-mutations";
import { useUpdateGeneralSettings } from "@/hooks/mutations/settings-mutations";
import { cloudCanRunHarness, useCloudroomAccount, useCloudroomSignIn, useImportBb, useMacAgents, useNativeSessions, useProjectSuggestions, useSetCopyLogins, useSetMacAccess } from "@/hooks/queries/cloudroom-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useHostDaemon, useThisComputer } from "@/hooks/useHostDaemon";
import { GitForWindowsBanner } from "@/components/layout/DesktopUpdateBanner";
import { usePathPickerHost } from "@/hooks/useLocalPathPicker";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { usePromptBoxProviderPreference } from "@/hooks/thread-creation-options/persisted-selection-fields";
import { booleanLocalStorage } from "@/lib/browser-storage";
import { MACOS_APP_REGION_NO_DRAG_CLASS, MACOS_WINDOW_DRAG_CLASS } from "@/lib/bb-desktop";
import { copyTextToClipboard, copyToClipboardWithToast } from "@/lib/clipboard";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { useSystemConfig, useSystemProviders } from "@/hooks/queries/system-queries";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const dismissedAtom = atomWithStorage("cloudroom.setup.dismissed", false, booleanLocalStorage, { getOnInit: true });
const openAtom = atom(false);
export const useOpenSetup = () => useSetAtom(openAtom);

const STEPS = ["Sign in", "Connect an agent", "Connect GitHub", "Import your work"];
const STEP_IDS = ["account", "agent", "github", "project"] as const;
type SetupStepId = (typeof STEP_IDS)[number];
type SetupDetail = "claude" | "codex" | "both" | "none" | "existing" | "found" | "folder" | "recent_folder" | "bb_import" | "chat_import" | "pi" | "opencode" | "cursor" | "hermes" | "grok" | "devin" | "fx" | "openclaw";
const agentDetail = (id: string) => id.replace(/^acp-/, "").replace(/-agent$/, "") as SetupDetail;
function track(step: SetupStepId, action: "viewed" | "started" | "done" | "skipped" | "closed" | "detected", detail: SetupDetail | null = null, agents?: SetupDetail[]) {
  void fetchWithAppSurface("/api/v1/cloudroom/setup-step", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step, action, detail, agents }),
  }).catch(() => {});
}
const LATER = ["Your Cloudroom account", "Claude Code or Codex", "For private repos", "Last step"];
const PALETTE = {
  "--ob-bg": "#faf7ef", "--ob-rail": "#f2ecde", "--ob-card": "#fffdf7", "--ob-line": "#e2dac6", "--ob-dash": "#c9bfa6",
  "--ob-ink": "#29251e", "--ob-muted": "#7a7263", "--ob-lime": "#bfff00", "--ob-ok": "#4d6b00", "--ob-green": "#17803f",
} as CSSProperties;

export function useSetupProgress() {
  const account = useCloudroomAccount();
  const accountId = account.data?.account?.id;
  const ready = account.data?.ready === true;
  const offline = Boolean(account.data?.account && !ready && account.data?.error);
  const claude = useClaudeConnection({ target: "cloud" }, Boolean(accountId));
  const codex = useQuery({
    queryKey: ["cloudroom-codex-auth", accountId],
    enabled: Boolean(accountId) && ready,
    queryFn: ({ signal }) => sdk.cloudroom.codexAuth(signal),
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === "waiting" ? 1500 : false),
  });
  const github = useQuery({
    queryKey: ["cloudroom-github-auth", accountId],
    enabled: Boolean(accountId) && ready,
    queryFn: ({ signal }) => sdk.cloudroom.githubAuth(signal),
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === "waiting" ? 1500 : false),
  });
  const defaultAgent = useSystemConfig().data?.generalSettings.defaultProviderId ?? null;
  const extra = defaultAgent === "claude-code" || defaultAgent === "codex" ? null : defaultAgent;
  const provider = useSystemProviders().data?.find((entry) => entry.id === extra);
  const signedIn = useMacAgents(extra !== null).data?.includes(extra ?? "") === true;
  const other = provider && signedIn ? provider.id : null;
  const agents = { claude: claude.data?.state === "connected", codex: codex.data?.state === "connected", other, otherName: other && provider?.displayName };
  const done = [Boolean(accountId), agents.claude || agents.codex || other !== null, github.data?.state === "connected"];
  return { account, ready, offline, agents, codex, github, done, complete: done.every(Boolean), checking: account.isPending };
}

export function Onboarding() {
  const [dismissed, setDismissed] = useAtom(dismissedAtom);
  const [open, setOpen] = useAtom(openAtom);
  const projects = useSidebarNavigation().data?.projects;
  const account = useCloudroomAccount();
  const locked = account.isSuccess && !account.data.account && !account.data.selfHosted;
  const firstRun = !dismissed && projects !== undefined && projects.length === 0;
  // Stay open once shown: adding a folder or importing chats creates projects, which would otherwise end the first run mid-step.
  useEffect(() => { if (firstRun) setOpen(true); }, [firstRun, setOpen]);
  const visible = locked || open || firstRun;
  if (!visible) return null;
  return <Setup locked={locked} close={() => { setDismissed(true); setOpen(false); }} />;
}

function Setup({ locked, close }: { locked: boolean; close: () => void }) {
  const progress = useSetupProgress();
  const { done, account } = progress;
  const [choices, setChoices] = useState({ macAccess: true, copyLogins: true });
  // Step 4's progress lives here, so going back a step keeps the Added ticks and Continue.
  const [added, setAdded] = useState<AddedFolder[]>([]);
  const [imported, setImported] = useState(false);
  const saveMacAccess = useSetMacAccess();
  const saveCopyLogins = useSetCopyLogins();
  const leave = () => {
    if (account.data?.account && account.data.macAccessSupported !== false && account.data.macAccess == null) saveMacAccess.mutate(choices.macAccess);
    if (account.data?.account && account.data.copyLogins == null) saveCopyLogins.mutate(choices.copyLogins);
    close();
  };
  useFirstAgentDefault(progress.agents);
  const first = done.findIndex((isDone) => !isDone);
  const [picked, setPicked] = useState<number | null>(null);
  const step = picked ?? (first === -1 ? 3 : first);
  const next = () => setPicked(nextStep(done, step));
  const signedIn = done[0];
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (signedIn && !wasSignedIn.current && step === 0) setPicked(nextStep(done, 0));
    wasSignedIn.current = signedIn;
  }, [signedIn, step, done]);
  // Stay on the agent step after one agent connects; only both connecting moves on by itself, after a countdown.
  const { claude, codex } = progress.agents;
  const hadAgents = useRef({ claude, codex });
  const [stamped, setStamped] = useState(false);
  const [countdown, setCountdown] = useState<{ left: number; to: number } | null>(null);
  useEffect(() => {
    if (step === 1 && picked === null) setPicked(1);
    const had = hadAgents.current;
    hadAgents.current = { claude, codex };
    if (step !== 1) {
      setStamped(false);
      return setCountdown(null);
    }
    if ((claude && !had.claude) || (codex && !had.codex)) setStamped(true);
    if (claude && codex && !(had.claude && had.codex)) setCountdown({ left: AGENT_COUNTDOWN, to: nextStep(done, 1) });
  }, [claude, codex, step, picked, done]);
  useEffect(() => {
    if (!countdown) return;
    const timer = setTimeout(() => {
      if (countdown.left > 1) return setCountdown({ ...countdown, left: countdown.left - 1 });
      setCountdown(null);
      setPicked(countdown.to);
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdown]);
  const viewed = useRef(new Set<number>());
  useEffect(() => {
    if (progress.checking || viewed.current.has(step)) return;
    const timer = setTimeout(() => { viewed.current.add(step); track(STEP_IDS[step] ?? "project", "viewed"); }, 1500);
    return () => clearTimeout(timer);
  }, [progress.checking, step]);
  const knownSignedIn = useRef<boolean | null>(null);
  useEffect(() => {
    if (progress.checking) return;
    if (knownSignedIn.current === false && signedIn) track("account", "done");
    knownSignedIn.current = signedIn;
  }, [progress.checking, signedIn]);
  if (progress.checking) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Set up Cloudroom" style={PALETTE} className="fixed inset-0 z-50 flex flex-col bg-(--ob-bg) text-(--ob-ink) duration-300 animate-in fade-in-0">
      <div className={cn("h-10 shrink-0 border-b border-(--ob-line) bg-(--ob-rail)", MACOS_WINDOW_DRAG_CLASS)} />
      <GitForWindowsBanner pinned={false} />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[300px] shrink-0 flex-col border-r border-(--ob-line) bg-(--ob-rail) px-[22px] pt-7 pb-6 md:flex">
          <div className="flex items-center gap-2.5 text-base font-semibold tracking-tight">
            <BbLogo className="size-7" />
            cloudroom
          </div>
          <p className="mt-10 mb-3 ml-3 text-[11px] tracking-[0.14em] text-(--ob-muted) uppercase">Setup</p>
          <ol className="flex flex-col gap-2">
            {STEPS.map((title, index) => {
              const state = index === step ? "now" : index < 3 && done[index] ? "done" : "todo";
              const meta = state === "now" ? "In progress" : state === "done" ? doneMeta(index, progress) : LATER[index];
              const reachable = index <= Math.max(first === -1 ? 3 : first, step) || state === "done";
              return (
                <li key={title} className="relative">
                  {index < 3 && <span aria-hidden className="absolute top-11 left-[25px] h-[30px] border-l border-dashed border-(--ob-dash)" />}
                  <button
                    type="button"
                    disabled={!reachable}
                    onClick={() => setPicked(index)}
                    aria-current={state === "now" ? "step" : undefined}
                    className={cn(
                      "relative flex w-full items-start gap-3.5 border border-transparent p-3 text-left",
                      state === "now" && "z-10 border-(--ob-line) bg-(--ob-card) shadow-[0_10px_30px_-18px_rgba(60,45,10,0.35)]",
                      state === "todo" && "opacity-55",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-7 shrink-0 place-items-center border text-[11px] font-semibold",
                        state === "done" && "border-(--ob-ink) bg-(--ob-ink) text-(--ob-bg)",
                        state === "now" && "border-(--ob-ink) bg-(--ob-lime) text-black",
                        state === "todo" && "border-(--ob-line) bg-(--ob-rail) text-(--ob-muted)",
                      )}
                    >
                      {state === "done" ? <Icon name="Check" className="size-3.5" aria-label="Done" /> : `0${index + 1}`}
                    </span>
                    <span className="min-w-0">
                      <strong className="block text-sm leading-tight font-semibold">{title}</strong>
                      <small className="mt-0.5 block truncate text-[12.5px] text-(--ob-muted)">{meta}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-auto px-3 text-[12.5px] text-(--ob-muted)">Reopen setup anytime from the account button in the sidebar.</p>
        </aside>
        <main className="relative flex min-w-0 flex-1 overflow-y-auto px-6 pt-16 pb-8 md:px-[110px] md:py-10">
          {!locked && (
            <button type="button" onClick={() => { track(STEP_IDS[step] ?? "project", "closed"); leave(); }} className={cn("absolute top-5 right-6 flex items-center gap-1.5 text-[13px] text-(--ob-muted) hover:text-(--ob-ink)", MACOS_APP_REGION_NO_DRAG_CLASS)}>
              Skip setup
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          )}
          <div key={step} className={cn("my-auto w-full duration-300 animate-in fade-in-0 slide-in-from-bottom-1", step === 3 ? "max-w-[860px]" : "max-w-[600px]")}>
            {step === 1 && stamped ? <TickStamp key={`${claude}-${codex}`} /> : <BbLogo className="mb-6 size-[72px] -rotate-[5deg]" />}
            <p className="font-serif text-base text-(--ob-muted) italic">Step {step + 1} of 4</p>
            {step === 0 && <AccountStep email={account.data?.account?.email ?? null} signingIn={account.data?.signingIn === true} next={next} />}
            {step === 1 && <AgentStep progress={progress} next={next} stamped={stamped} left={countdown?.left ?? null} choices={choices} setChoices={setChoices} />}
            {step === 2 && <GithubStep progress={progress} next={next} />}
            {step === 3 && <ProjectStep close={leave} added={added} setAdded={setAdded} imported={imported} setImported={setImported} />}
          </div>
        </main>
      </div>
    </div>
  );
}

function useSetDefaultAgent() {
  const settings = useSystemConfig().data?.generalSettings;
  const update = useUpdateGeneralSettings();
  const setProvider = usePromptBoxProviderPreference().setValue;
  return (agent: string) => {
    if (!settings) return;
    setProvider(agent);
    update.mutate({ ...settings, defaultProviderId: agent });
  };
}

function useFirstAgentDefault({ claude, codex }: { claude: boolean; codex: boolean }) {
  const settings = useSystemConfig().data?.generalSettings;
  const setDefault = useSetDefaultAgent();
  const assigned = useRef(false);
  const agent = claude ? "claude-code" : codex ? "codex" : null;
  useEffect(() => {
    if (assigned.current || !agent || !settings || settings.defaultProviderId !== null) return;
    assigned.current = true;
    setDefault(agent);
  }, [agent, settings, setDefault]);
}

function nextStep(done: boolean[], from: number) {
  const index = done.findIndex((isDone, i) => i > from && !isDone);
  return index === -1 ? 3 : index;
}

function doneMeta(index: number, progress: ReturnType<typeof useSetupProgress>) {
  if (index === 0) return progress.account.data?.account?.email ?? "Signed in";
  if (index === 1) return [progress.agents.claude && "Claude Code", progress.agents.codex && "Codex", progress.agents.otherName].filter(Boolean).join(" + ");
  return progress.github.data?.email ?? "Connected";
}

function Heading({ lead, mark }: { lead: string; mark: string }) {
  return (
    <h1 className="mt-1.5 font-serif text-[52px] leading-[1.08] font-medium tracking-[-0.025em]">
      {lead}{" "}
      <em className="bg-[linear-gradient(transparent_58%,var(--ob-lime)_58%,var(--ob-lime)_92%,transparent_92%)]">{mark}</em>
    </h1>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="text-[13px] text-(--ob-muted)">{children}</p>;
const LINK = "text-(--ob-ink) underline underline-offset-[3px] disabled:opacity-50";
const QUIET_LINK = "underline decoration-(--ob-dash) underline-offset-[3px] hover:text-(--ob-ink) disabled:opacity-50";

function Cta({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn("inline-flex h-12 items-center justify-center gap-2.5 bg-(--ob-ink) px-7 text-[15.5px] font-semibold text-(--ob-bg) transition-opacity hover:opacity-90 disabled:opacity-40 [&_svg]:size-4", className)}
      {...props}
    >
      {children}
    </button>
  );
}

const OUTLINE = "inline-flex h-9 shrink-0 items-center gap-2 rounded-none border border-(--ob-ink) bg-(--ob-card) px-4 text-[13.5px] font-medium text-(--ob-ink) hover:bg-(--ob-bg) hover:text-(--ob-ink) disabled:opacity-50";
const CONNECT = cn(OUTLINE, "h-11 gap-2.5 border-2 px-6 text-[15px] font-semibold shadow-[4px_4px_0_var(--ob-ink)] after:content-['→'] active:translate-x-0.5 active:translate-y-0.5 active:shadow-[2px_2px_0_var(--ob-ink)]");

function Outline({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(OUTLINE, className)}
      {...props}
    >
      {children}
    </button>
  );
}

function Card({ on, isDefault, logo, name, detail, children }: { on?: boolean; isDefault?: boolean; logo: ReactNode; name: string; detail: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("flex items-center gap-4 border bg-(--ob-card) px-[22px] py-[18px]", on ? "border-(--ob-ink)" : "border-(--ob-line)")}>
      <span className="grid size-11 shrink-0 place-items-center">{logo}</span>
      <span className="min-w-0 flex-1">
        <b className="block text-base font-semibold">
          {name}
          {isDefault && <span className="ml-2 border border-(--ob-line) px-1.5 py-px align-[2px] text-[11px] font-medium text-(--ob-muted)">Default</span>}
        </b>
        <span className="text-[13px] text-(--ob-muted)">{detail}</span>
      </span>
      {children}
    </div>
  );
}

const Tick = ({ className }: { className: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const Connected = () => (
  <span className="inline-flex items-center gap-2 text-[13.5px] font-semibold text-(--ob-green)">
    <span className="grid size-[22px] place-items-center rounded-full bg-(--ob-green) duration-300 animate-in zoom-in-50">
      <Tick className="size-[13px] text-white" />
    </span>
    Connected
  </span>
);

const AGENT_COUNTDOWN = 3;
const TickStamp = () => (
  <span aria-hidden className="relative mb-6 block size-[72px]">
    {[0, 60, 120, 180, 240, 300].map((turn) => (
      <span key={turn} className="ob-burst absolute top-[29px] left-[34px] h-3.5 w-1 bg-(--ob-ink)" style={{ "--ob-turn": `${turn}deg` } as CSSProperties} />
    ))}
    <span className="ob-stamp absolute inset-0 grid place-items-center border-2 border-(--ob-ink) bg-(--ob-lime) shadow-[5px_5px_0_var(--ob-ink)]">
      <svg viewBox="0 0 24 24" className="size-11" fill="none" stroke="#000" strokeWidth={3.2} strokeLinecap="square">
        <path className="ob-draw" pathLength={1} d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  </span>
);

function AccountStep({ email, signingIn, next }: { email: string | null; signingIn: boolean; next: () => void }) {
  const signIn = useCloudroomSignIn();
  const busy = signingIn || signIn.isPending;
  const start = () => { track("account", "started"); signIn.mutate("signIn"); };
  return (
    <>
      <Heading lead="Sign in to" mark="Cloudroom" />
      {email ? (
        <div className="mt-8 flex items-center gap-5">
          <Cta onClick={next}>Continue <Icon name="ArrowRight" aria-hidden /></Cta>
          <Note>Signed in as {email}.</Note>
        </div>
      ) : busy ? (
        <div className="mt-8 flex max-w-[420px] flex-col gap-3">
          <Cta disabled className="w-full"><Icon name="Loading" className="animate-spin" aria-hidden />Waiting for your browser…</Cta>
          <Note>Finish logging in in your browser. <button type="button" className={LINK} onClick={() => signIn.mutate("cancel")}>Cancel</button></Note>
        </div>
      ) : (
        <>
          <p className="mt-3 text-base text-(--ob-muted)">Use the account you made on cloudroom.dev.</p>
          <div className="mt-8 flex flex-col items-start gap-4">
            <Cta onClick={start}>Sign in with browser <Icon name="ArrowRight" aria-hidden /></Cta>
            <Note>Already signed in there? You come right back.</Note>
          </div>
        </>
      )}
    </>
  );
}

type Choices = { macAccess: boolean; copyLogins: boolean };
function AgentStep({ progress, next, stamped, left, choices, setChoices }: { progress: ReturnType<typeof useSetupProgress>; next: () => void; stamped: boolean; left: number | null; choices: Choices; setChoices: (choices: Choices) => void }) {
  const { account, agents, codex, ready, offline } = progress;
  const defaultAgent = useSystemConfig().data?.generalSettings.defaultProviderId;
  const { localHostId } = useHostDaemon();
  const here = useThisComputer();
  const claudeLocal = useClaudeConnection({ target: "local", hostId: localHostId });
  const macAgents = useMacAgents();
  const detected = useRef(false);
  useEffect(() => {
    if (detected.current || claudeLocal.isPending || macAgents.isPending || !account.data) return;
    detected.current = true;
    const claude = claudeLocal.data?.state === "connected", codexFound = Boolean(account.data.localLogins?.codex);
    track("agent", "detected", claude && codexFound ? "both" : claude ? "claude" : codexFound ? "codex" : "none", (macAgents.data ?? []).map(agentDetail));
  }, [claudeLocal.isPending, claudeLocal.data?.state, macAgents.isPending, macAgents.data, account.data]);
  const setDefault = useSetDefaultAgent();
  const pick = (agent: string) => {
    if (agent === defaultAgent) return;
    track("agent", "started", agentDetail(agent));
    setDefault(agent);
  };
  const startedAgents = useRef(new Set<"claude" | "codex">());
  const started = (agent: "claude" | "codex") => {
    if (startedAgents.current.has(agent)) return;
    startedAgents.current.add(agent);
    track("agent", "started", agent);
  };
  const client = useQueryClient();
  const saveMacAccess = useSetMacAccess();
  const saveCopyLogins = useSetCopyLogins();
  const [ask] = useState(() => ({ mac: account.data?.macAccessSupported !== false && account.data?.macAccess == null, logins: account.data?.copyLogins == null }));
  const { macAccess, copyLogins } = choices;
  // Save whenever a box differs from the saved choice, so re-checking it after a Connect works.
  const saveChoices = () =>
    Promise.all([
      ask.mac && account.data?.macAccess !== macAccess && saveMacAccess.mutateAsync(macAccess),
      ask.logins && account.data?.copyLogins !== copyLogins && saveCopyLogins.mutateAsync(copyLogins),
    ]);
  const connectCodex = useMutation({
    mutationFn: async () => {
      await saveChoices();
      const result = await sdk.cloudroom.codexLogin(crypto.randomUUID());
      // A VM signs in with a device code; a sandbox signs in on this Mac, where Codex opens the browser itself.
      if (result.state === "waiting" && result.user_code) openCodexConnection();
      else if (result.state !== "connected" && result.state !== "waiting") throw new Error(result.message ?? "Codex could not connect. Try again.");
      client.setQueryData(["cloudroom-codex-auth", account.data?.account?.id], result);
    },
    meta: { showErrorToast: false },
    onError: (error) => appToast.error(error.message),
    onSettled: () => client.invalidateQueries({ queryKey: ["cloudroom-codex-auth"] }),
  });
  const finish = useMutation({ mutationFn: saveChoices, onSuccess: () => { track("agent", "done", agents.other ? agentDetail(agents.other) : agents.claude && agents.codex ? "both" : agents.claude ? "claude" : "codex"); next(); }, meta: { showErrorToast: false }, onError: (error) => appToast.error(error.message) });
  const codexBrowser = codex.data?.state === "waiting" && !codex.data.user_code ? codex.data : null;
  const waiting = !account.data?.account ? "Log in first" : offline ? "Cloud unreachable" : !ready ? "Starting your cloud…" : null;
  const connectedLead = agents.claude && agents.codex ? "Agents" : agents.claude ? "Claude Code" : "Codex";
  const action = (connected: boolean, button: ReactNode) => (connected ? <Connected /> : waiting ? <Note>{waiting}</Note> : button);
  return (
    <>
      {stamped ? (
        <div key={connectedLead} className="ob-sweep duration-300 animate-in fade-in-0 slide-in-from-bottom-2">
          <Heading lead={connectedLead} mark="connected" />
        </div>
      ) : <Heading lead="Connect an" mark="agent" />}
      <div className="mt-8 flex flex-col gap-3">
        <Card on={agents.claude} isDefault={agents.claude && defaultAgent === "claude-code"} logo={<AgentLogo id="claude-code" className="bg-[#f4e4d6]" />} name="Claude Code" detail={claudeLocal.data?.state === "connected" ? `Found on ${here}` : "Uses your Claude plan"}>
          {action(agents.claude, <span onClickCapture={() => started("claude")}><ClaudeConnectionButton target="cloud" presentation="inline" className={CONNECT} /></span>)}
        </Card>
        <Card on={agents.codex} isDefault={agents.codex && defaultAgent === "codex"} logo={<AgentLogo id="codex" className="bg-black text-white" />} name="Codex" detail={account.data?.localLogins?.codex ? `Found on ${here}` : "Uses your ChatGPT plan"}>
          {action(agents.codex, codexBrowser ? (
            <Note>
              Finish in your browser.{" "}
              {codexBrowser.verification_url && <button type="button" className={LINK} onClick={() => openUrlInExternalBrowser(codexBrowser.verification_url!)}>Reopen</button>}
            </Note>
          ) : (
            <Outline className={CONNECT} disabled={connectCodex.isPending} onClick={() => { started("codex"); connectCodex.mutate(); }}>{connectCodex.isPending ? "Connecting…" : "Connect"}</Outline>
          ))}
        </Card>
      </div>
      <MoreAgents agents={macAgents.data ?? []} picked={agents.other} pick={pick} />
      {offline && <CloudOffline />}
      {/* Hidden until an agent connects, so the choices don't distract from Connect. */}
      {(agents.claude || agents.codex || agents.other) && (ask.mac || ask.logins) && (
        <div className="mt-4 flex gap-6 text-[12.5px] text-(--ob-muted) duration-300 animate-in fade-in-0">
          {ask.logins && <Choice checked={copyLogins} onChange={(value) => setChoices({ ...choices, copyLogins: value })} label="Copy logins to the cloud" detail="Agent logins, API keys, and model providers." />}
          {ask.mac && <Choice checked={macAccess} onChange={(value) => setChoices({ ...choices, macAccess: value })} label="Let cloud agents use this computer" detail="Far more powerful agents. Turn off anytime." />}
        </div>
      )}
      <div className="mt-8 flex items-center gap-5">
        <Cta
          disabled={!(agents.claude || agents.codex || agents.other) || finish.isPending}
          onClick={() => finish.mutate()}
          className={cn(left !== null && "min-w-[220px] bg-(--ob-lime) text-black shadow-[4px_4px_0_var(--ob-ink)] transition-[background-color,box-shadow] duration-300")}
        >
          {left === null ? <>Continue <Icon name="ArrowRight" aria-hidden /></> : <>Next step in<span key={left} className="-ml-1 inline-block w-[0.6em] duration-200 animate-in fade-in-0 slide-in-from-bottom-2">{left}</span></>}
        </Cta>
        {left === null && <Note>Add more later in Settings.</Note>}
      </div>
      {left !== null && (
        <div className="mt-3.5 h-1.5 w-[360px] bg-(--ob-line)">
          <span className="bb-hero-progress-fill block h-full bg-(--ob-ink)" style={{ "--bb-hero-slide-duration": `${AGENT_COUNTDOWN}s` } as CSSProperties} />
        </div>
      )}
    </>
  );
}

function CloudOffline() {
  const signIn = useCloudroomSignIn();
  const signingIn = useCloudroomAccount().data?.signingIn === true;
  return (
    <div className="mt-3">
      <Note>
        Your cloud isn't responding.{" "}
        <button type="button" className={LINK} disabled={signIn.isPending || signingIn} onClick={() => signIn.mutate("signIn")}>{signingIn ? "Finish in your browser…" : "Sign in again"}</button>
      </Note>
    </div>
  );
}

/** Uses the provider record so the plugin's real logo and tint load, not the generic fallback. */
function AgentLogo({ id, className, small = false }: { id: string; className: string; small?: boolean }) {
  const provider = useSystemProviders().data?.find((entry) => entry.id === id);
  const Logo = getProviderIconInfo("agent", id, provider ?? null).icon;
  return (
    <span className={cn("grid shrink-0 place-items-center", small ? "size-5" : "size-11", className)} style={provider && getProviderIconTintStyle(provider)}>
      <Logo className={small ? "size-3" : "size-6"} />
    </span>
  );
}

function MoreAgents({ agents, picked, pick }: { agents: string[]; picked: string | null; pick: (agent: string) => void }) {
  const providers = useSystemProviders().data ?? [];
  const shown = agents.flatMap((id) => providers.filter((provider) => provider.id === id));
  const here = useThisComputer();
  if (!shown.length) return null;
  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-1.5 text-[13px]">
      <span className="mr-1 text-(--ob-muted)">Also on {here}</span>
      {shown.map(({ id, displayName }) => {
        const on = id === picked;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            onClick={() => pick(id)}
            className={cn("inline-flex h-[30px] items-center gap-1.5 border bg-(--ob-card) pr-2 pl-[5px] font-medium", on ? "border-(--ob-ink) shadow-[2px_2px_0_var(--ob-ink)]" : "border-(--ob-line) hover:border-(--ob-dash)")}
          >
            <AgentLogo id={id} small className="bg-(--ob-rail)" />
            {displayName}
            {!cloudCanRunHarness(id) && <span className="text-[11.5px] font-normal text-(--ob-muted)">Local</span>}
            {on && <Tick className="size-3.5 text-(--ob-green)" />}
          </button>
        );
      })}
    </div>
  );
}

function Choice({ checked, onChange, label, detail }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail: string }) {
  return (
    <label title={detail} className="flex cursor-pointer items-center gap-2 hover:text-(--ob-ink)">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-3.5 accent-(--ob-muted)" />
      {label}
    </label>
  );
}

const GITHUB_COUNTDOWN = 4;
const openGithub = (url: string) => { if (new URL(url).origin === "https://github.com") openUrlInExternalBrowser(url); };

function GithubStep({ progress, next }: { progress: ReturnType<typeof useSetupProgress>; next: () => void }) {
  const { github, account, ready, offline } = progress;
  const here = useThisComputer();
  const client = useQueryClient();
  const requestId = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["cloudroom-github-auth"] });
  const connect = useMutation({
    mutationFn: async () => {
      track("github", "started");
      requestId.current = crypto.randomUUID();
      const result = await sdk.cloudroom.githubLogin(requestId.current);
      if (result.state === "waiting" && result.verification_url && result.user_code) {
        if (new URL(result.verification_url).origin !== "https://github.com") throw new Error("Unexpected GitHub sign-in page.");
        setCopied(await copyTextToClipboard(result.user_code));
        setLeft(GITHUB_COUNTDOWN);
      } else if (result.state !== "connected") throw new Error(result.message ?? "GitHub could not connect. Try again.");
      return result;
    },
    onSuccess: (result) => client.setQueriesData({ queryKey: ["cloudroom-github-auth"] }, result),
    onError: (error) => appToast.error(error.message),
    onSettled: refresh,
  });
  const cancel = useMutation({
    onMutate: () => setLeft(null),
    mutationFn: () => sdk.cloudroom.cancelGithubLogin(requestId.current ?? github.data?.login_id ?? ""),
    onSettled: refresh,
  });
  const state = github.data?.state;
  const connected = state === "connected";
  const code = state === "waiting" ? github.data?.user_code : null;
  const url = state === "waiting" ? github.data?.verification_url : null;
  const open = () => {
    setLeft(null);
    if (url) openGithub(url);
  };
  useEffect(() => {
    if (left === null || !url) return;
    const timer = setTimeout(() => {
      if (left > 1) return setLeft(left - 1);
      setLeft(null);
      openGithub(url);
    }, 1000);
    return () => clearTimeout(timer);
  }, [left, url]);
  const copyAgain = async () => {
    if (code && await copyToClipboardWithToast(code, { successMessage: "Code copied." })) setCopied(true);
  };
  const detail = connected
    ? "Cloud agents can use your repos."
    : !account.data?.account ? "Log in first" : offline ? "Cloud unreachable" : !ready ? "Starting your cloud…" : `Not found on ${here}. You'll copy a code, then paste it on github.com.`;
  if (code) {
    return (
      <>
        <Heading lead="Your GitHub" mark="code" />
        <div className="mt-8 flex items-center gap-2">
          {code.split("").map((char, index) => char === "-"
            ? <span key={index} aria-hidden className="mx-1 h-[3px] w-3.5 bg-(--ob-ink)" />
            : <span key={index} className="grid h-16 w-[52px] place-items-center border-[1.5px] border-(--ob-ink) bg-(--ob-card) font-mono text-3xl font-semibold">{char}</span>)}
        </div>
        <p className="mt-4 text-[15px]">
          {copied && <span className="font-semibold text-(--ob-ok)">✓ Copied to your clipboard · </span>}
          <button type="button" className={LINK} onClick={() => void copyAgain()}>{copied ? "Copy again" : "Copy code"}</button>
        </p>
        <div className="mt-8 flex items-center gap-5">
          <Cta onClick={open}><Icon name="Github" aria-hidden />{left === null ? "Open GitHub" : `Opening GitHub in ${left}…`}</Cta>
          <Note>
            {left !== null && <><button type="button" className={LINK} onClick={open}>Open now</button> · </>}
            <button type="button" className={LINK} onClick={() => cancel.mutate()}>Cancel</button>
          </Note>
        </div>
        {left !== null && (
          <div className="mt-3.5 h-1.5 w-[360px] bg-(--ob-line)">
            <span className="bb-hero-progress-fill block h-full bg-(--ob-ink)" style={{ "--bb-hero-slide-duration": `${GITHUB_COUNTDOWN}s` } as CSSProperties} />
          </div>
        )}
        <p className="mt-6 text-sm text-(--ob-muted)">
          On GitHub: press <b className="text-(--ob-ink)">⌘V</b> to paste, then click <b className="text-(--ob-ink)">Authorize</b>. This screen moves on by itself.
        </p>
      </>
    );
  }
  return (
    <>
      <Heading lead="Connect" mark="GitHub" />
      <div className="mt-8">
        <Card on={connected} logo={<span className="grid size-11 place-items-center bg-black text-white"><Icon name="Github" className="size-6" aria-hidden /></span>} name="GitHub" detail={detail}>
          {connected && <Connected />}
        </Card>
      </div>
      {offline && <CloudOffline />}
      <div className="mt-8 flex items-center gap-5">
        {connected ? (
          <Cta onClick={() => { track("github", "done"); next(); }}>Continue <Icon name="ArrowRight" aria-hidden /></Cta>
        ) : (
          <Cta disabled={!ready || connect.isPending} onClick={() => connect.mutate()}>
            <Icon name={connect.isPending ? "Loading" : "Github"} className={cn(connect.isPending && "animate-spin")} aria-hidden />
            {connect.isPending ? "Getting your code…" : "Connect GitHub"}
          </Cta>
        )}
        {!connected && (
          <Note><button type="button" className={LINK} onClick={() => { track("github", "skipped"); next(); }}>Skip this step</button> if you only use public repos.</Note>
        )}
      </div>
    </>
  );
}

type AddedFolder = { name: string; path: string };

function ProjectStep({ close, added, setAdded, imported, setImported }: {
  close: () => void;
  added: AddedFolder[];
  setAdded: (update: (list: AddedFolder[]) => AddedFolder[]) => void;
  imported: boolean;
  setImported: (value: boolean) => void;
}) {
  const navigate = useNavigate();
  const createProject = useCreateProject();
  const setProjectId = useSetRootComposeProjectId();
  const quickCreate = useQuickCreateProjectController();
  const { canUseNativeFolderPicker, clientHostId, hostId } = usePathPickerHost();
  const here = useThisComputer();
  const { localHostId } = useHostDaemon();
  const importBb = useImportBb();
  const sessions = useNativeSessions().data?.sessions;
  const empty = sessions?.length === 0;
  // Unless the scan found no chats, added folders stay on this step with a tick, and the lime Continue button leaves it.
  const addedPaths = new Set(added.map((folder) => folder.path));
  const suggested = useProjectSuggestions()?.repos.filter((repo) => repo.source === "mac").filter((repo) => !addedPaths.has(repo.path)) ?? [];
  const recent = [...added, ...suggested.slice(0, empty ? 3 : 2)];
  const add = useMutation({
    mutationFn: async (path?: string) => {
      const folder = path ?? (hostId && clientHostId ? (await sdk.hosts.pickFolder({ hostId, clientHostId })).path : null);
      if (!folder || !hostId) return null;
      const project = await createProject.mutateAsync({ name: deriveProjectNameFromPath(folder), source: { type: "local_path", hostId, path: folder } });
      return { project, folder };
    },
    onSuccess: (result, path) => {
      if (!result) return;
      track("project", "done", path ? "recent_folder" : "folder");
      setProjectId(result.project.id);
      selectCloudForNewThreads();
      if (!empty) return setAdded((list) => [...list, { name: result.project.name, path: result.folder }]);
      finish();
    },
    onError: (error) => appToast.error(error.message),
  });
  const addFolder = () => {
    if (canUseNativeFolderPicker) return add.mutate(undefined);
    selectCloudForNewThreads();
    track("project", "started", "folder");
    close();
    quickCreate.openCreateDialog();
  };
  const bringWorkOver = () => {
    if (!localHostId) return appToast.error(`${here[0]!.toUpperCase()}${here.slice(1)} is not connected yet. Try again in a moment.`);
    track("project", "started", "bb_import");
    importBb.mutate(localHostId, {
      onSuccess: ({ imported }) => {
        appToast.success(`Imported ${imported.length} BB thread${imported.length === 1 ? "" : "s"}`);
        if (imported.length) setImported(true);
      },
      onError: (error) => appToast.error(error.message),
    });
  };
  const finish = () => {
    void navigate(getRootComposeRoutePath());
    close();
  };
  const startEmpty = () => { track("project", "skipped"); close(); };
  const done = added.length > 0 || imported;
  const opening = add.isPending ? add.variables : null;
  return (
    <>
      {empty ? <Heading lead="Start your first" mark="project" /> : <Heading lead="Import your" mark="work" />}
      <p className="mt-3 max-w-[560px] text-base text-(--ob-muted)">{empty ? "No agent chats to import. Pick a folder and your first agent starts there." : "Your agent chats move over. Originals stay untouched."}</p>
      <div className="mt-7">
        <ImportChats
          onStart={() => { track("project", "started", "chat_import"); setImported(true); }}
          empty={(
            <button type="button" disabled={add.isPending} onClick={addFolder} className="flex h-[88px] w-[640px] max-w-full items-center gap-4 border-2 border-(--ob-ink) bg-(--ob-lime) px-7 text-[25px] font-bold text-black shadow-[7px_7px_0_var(--ob-ink)] transition-transform hover:-translate-y-0.5 active:translate-x-0.5 active:translate-y-0.5 active:shadow-[3px_3px_0_var(--ob-ink)] disabled:opacity-60 [&_svg]:size-7">
              <Icon name="Folder" aria-hidden />
              {opening === undefined ? "Opening…" : "Open a folder"}
            </button>
          )}
        />
      </div>
      {recent.length > 0 && (
        <div className="mt-9 max-w-[640px]">
          <p className="mb-2.5 text-[11.5px] tracking-[0.12em] text-(--ob-muted) uppercase">{empty ? `Recent on ${here}` : "Or add a recent folder"}</p>
          <ul className="divide-y divide-(--ob-line) border-[1.5px] border-(--ob-ink) bg-(--ob-card)">
            {recent.map((repo) => (
              <li key={repo.path} className="flex items-center gap-4 px-5 py-3.5">
                <Icon name="FolderGit" className="size-5 shrink-0 text-(--ob-muted)" aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold">{repo.name}</p>
                  <p className="truncate text-[12.5px] text-(--ob-muted)">{repo.path.replace(/^\/(Users|home)\/[^/]+/, "~")}</p>
                </div>
                {addedPaths.has(repo.path) ? (
                  <span className="ml-auto inline-flex h-9 shrink-0 items-center gap-2 bg-(--ob-ink) px-4 text-[13.5px] font-semibold text-(--ob-bg)">
                    <Icon name="Check" className="size-3.5" aria-hidden />
                    Added
                  </span>
                ) : (
                  <Outline className="ml-auto shadow-[3px_3px_0_var(--ob-ink)]" disabled={add.isPending} onClick={() => add.mutate(repo.path)}>
                    {opening === repo.path ? (empty ? "Opening…" : "Adding…") : empty ? "Open" : "Add"}
                  </Outline>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-8 text-[13.5px] text-(--ob-muted)">
        {empty ? "Not ready? " : (
          <>
            <button type="button" className={QUIET_LINK} disabled={add.isPending} onClick={addFolder}>Add a folder</button>
            <span aria-hidden className="mx-2 text-(--ob-dash)">·</span>
          </>
        )}
        {!done && (
          <>
            <button type="button" className={QUIET_LINK} onClick={startEmpty}>Start empty</button>
            {empty && " and pick a project later."}
            <span aria-hidden className="mx-2 text-(--ob-dash)">·</span>
          </>
        )}
        <button type="button" className={QUIET_LINK} disabled={importBb.isPending} onClick={bringWorkOver}>
          {importBb.isPending ? "Bringing your BB threads over…" : "Coming from BB?"}
        </button>
      </p>
      {done && (
        <button type="button" onClick={finish} className="fixed right-11 bottom-10 inline-flex h-14 items-center gap-2.5 border-2 border-(--ob-ink) bg-(--ob-lime) px-[30px] text-[19px] font-bold text-black shadow-[5px_5px_0_var(--ob-ink)] transition-transform hover:-translate-y-0.5 active:translate-x-0.5 active:translate-y-0.5 active:shadow-[2px_2px_0_var(--ob-ink)] [&_svg]:size-5">
          Continue
          <Icon name="ArrowRight" aria-hidden />
        </button>
      )}
    </>
  );
}
