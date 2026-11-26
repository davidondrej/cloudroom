import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useGitlabConnection } from "@/hooks/useGitlabConnection";
import { useNavigate } from "react-router";
import { deriveProjectNameFromPath } from "@cloudroom/domain";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { ClaudeConnectionButton, useClaudeConnection, useInstallPercent } from "@/components/ClaudeConnection";
import { openCodexConnection } from "@/components/CodexConnectionPanel";
import { selectCloudForNewThreads } from "@/components/promptbox/NewThreadComposer";
import { ImportChats } from "@/components/settings/ImportChats";
import { useOwnCoreConnection } from "@/components/settings/SelfHostedCoreForm";
import { RoomLogo } from "@/components/ui/cloudroom-logo";
import { appToast } from "@/components/ui/app-toast";
import { useCreateProject } from "@/hooks/mutations/project-mutations";
import { useUpdateGeneralSettings } from "@/hooks/mutations/settings-mutations";
import { cloudCanRunHarness, useCloudroomAccount, useCloudroomSignIn, useImportRoom, useInstalledMacAgents, useMacAgents, useNativeSessions, useProjectSuggestions, useSetCopyLogins, useSetMacAccess } from "@/hooks/queries/cloudroom-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useHostDaemon, useThisComputer } from "@/hooks/useHostDaemon";
import { GitForWindowsBanner } from "@/components/layout/DesktopUpdateBanner";
import { usePathPickerHost } from "@/hooks/useLocalPathPicker";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { usePromptBoxProviderPreference } from "@/hooks/thread-creation-options/persisted-selection-fields";
import { booleanLocalStorage } from "@/lib/browser-storage";
import { getRoomDesktopInfo, MACOS_APP_REGION_NO_DRAG_CLASS, MACOS_WINDOW_DRAG_CLASS } from "@/lib/room-desktop";
import { copyTextToClipboard, copyToClipboardWithToast, useClipboardCopy } from "@/lib/clipboard";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { useSystemConfig, useSystemProviders } from "@/hooks/queries/system-queries";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const dismissedAtom = atomWithStorage("cloudroom.setup.dismissed", false, booleanLocalStorage, { getOnInit: true });
const openAtom = atom(false);
// A new install's sign-in page opens by itself (David, 2026-11-03, docs/scopes/onboarding.md). 20% keep the button, to measure it.
const signInGroupAtom = atomWithStorage<"auto" | "manual" | "auto_done" | null>("cloudroom.setup.signInGroup", null, undefined, { getOnInit: true });

const STEPS = ["Sign in", "Connect an agent", "Connect GitHub", "Import your work"];
const STEP_IDS = ["account", "agent", "github", "project"] as const;
type SetupStepId = (typeof STEP_IDS)[number];
type SetupDetail = "gitlab" | "claude" | "codex" | "both" | "none" | "existing" | "found" | "folder" | "recent_folder" | "bb_import" | "chat_import" | "pi" | "opencode" | "cursor" | "hermes" | "grok" | "devin" | "droid" | "kimi" | "antigravity" | "fx" | "openclaw" | "agent-zero" | "auto" | "manual" | "repos" | "mac";
const agentDetail = (id: string) => id.replace(/^acp-/, "").replace(/-agent$/, "") as SetupDetail;
function track(step: SetupStepId, action: "viewed" | "started" | "done" | "skipped" | "closed" | "detected", detail: SetupDetail | null = null, agents?: SetupDetail[]) {
  void fetchWithAppSurface("/api/v1/cloudroom/setup-step", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step, action, detail, agents }),
  }).catch(() => {});
}
const LATER = ["Your Cloudroom account", "Claude Code or Codex", "For private repos", "Last step"];
const PALETTE = {
  "--ob-bg": "#faf7ef", "--ob-rail": "#f2ecde", "--ob-card": "#fffdf7", "--ob-line": "#e2dac6", "--ob-dash": "#c9bfa6",
  "--ob-ink": "#29251e", "--ob-muted": "#7a7263", "--ob-lime": "#bfff00", "--ob-ok": "#4d6b00", "--ob-green": "#17803f", "--ob-error": "#b42318",
} as CSSProperties;

export function useSetupProgress() {
  const account = useCloudroomAccount();
  const accountId = account.data?.account?.id;
  // A Core the user hosts, with no Cloudroom account: connecting it was step 1, and its server keeps its own GitHub login.
  // Never true for account users, so their setup is unchanged.
  const ownCore = account.data?.selfHosted === true && !account.data.account;
  const ready = account.data?.ready === true;
  const offline = Boolean(account.data?.account && !ready && account.data?.error);
  const claude = useClaudeConnection({ target: "cloud" }, Boolean(accountId) || ownCore);
  const codex = useQuery({
    queryKey: ["cloudroom-codex-auth", accountId],
    enabled: (Boolean(accountId) || ownCore) && ready,
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
  const gitlab = useGitlabConnection(Boolean(accountId) && ready);
  const done = [Boolean(accountId) || ownCore, agents.claude || agents.codex || other !== null, github.data?.state === "connected" || Boolean(gitlab.state?.login && !gitlab.state.expired) || ownCore];
  return { account, ownCore, ready, offline, agents, codex, github, gitlab, done, complete: done.every(Boolean), checking: account.isPending };
}

/** True while setup is open, so a pop-up waits for it to close. */
export const useOnboardingOpen = () => useAtomValue(openAtom);

export function Onboarding() {
  const [dismissed, setDismissed] = useAtom(dismissedAtom);
  const [open, setOpen] = useAtom(openAtom);
  const projects = useSidebarNavigation().data?.projects;
  const account = useCloudroomAccount();
  // No account and no Core of their own. Setup never locks: the app works without sign-in (ADR 20261116-210853).
  const signedOut = account.isSuccess && !account.data.account && !account.data.selfHosted;
  // Only the desktop app opens setup by itself: "skipped" is saved per browser, so phones and other browsers would see it again.
  const firstRun = !dismissed && getRoomDesktopInfo() !== null && projects !== undefined && projects.length === 0;
  // Stay open once shown: adding a folder or importing chats creates projects, which would otherwise end the first run mid-step.
  useEffect(() => { if (firstRun) setOpen(true); }, [firstRun, setOpen]);
  const visible = open || firstRun;
  if (!visible) return null;
  return <Setup signedOut={signedOut} fresh={projects?.length === 0} close={() => { setDismissed(true); setOpen(false); }} />;
}

function Setup({ signedOut, fresh, close }: { signedOut: boolean; fresh: boolean; close: () => void }) {
  const progress = useSetupProgress();
  const { done, account } = progress;
  const lab = progress.gitlab.state;
  const gitlabChosen = lab?.waiting || (lab?.login && !lab.expired && progress.github.data?.state !== "connected");
  const [ownCoreForm, setOwnCoreForm] = useState(false);
  const [choices, setChoices] = useState({ macAccess: true, copyLogins: true });
  // Only choices the user actually saw on Step 1 are ever saved; Skip setup saves nothing.
  const shownChoices = useRef({ mac: false, logins: false });
  const markChoiceShown = useCallback((kind: "mac" | "logins") => { shownChoices.current[kind] = true; }, []);
  // Step 4's progress lives here, so going back a step keeps the Added ticks and Continue.
  const [added, setAdded] = useState<AddedFolder[]>([]);
  const [imported, setImported] = useState(false);
  const saveMacAccess = useSetMacAccess(undefined, { showErrorToast: false });
  const saveCopyLogins = useSetCopyLogins();
  const os = account.data?.computerOs;
  const saveShownChoices = async () => {
    const saves = Boolean(account.data?.account) || progress.ownCore;
    // Windows (#958): setup never turns access on, nor when the computer's system is unknown.
    const canSaveMac = saves && os !== undefined && os !== "windows" && account.data?.macAccessSupported !== false;
    await Promise.all([
      shownChoices.current.mac && canSaveMac && account.data?.macAccess !== choices.macAccess && saveMacAccess.mutateAsync(choices.macAccess),
      shownChoices.current.logins && saves && account.data?.copyLogins !== choices.copyLogins && saveCopyLogins.mutateAsync(choices.copyLogins),
    ]);
  };
  const leave = () => {
    void saveShownChoices();
    close();
  };
  useFirstAgentDefault(progress.agents);
  const first = done.findIndex((isDone) => !isDone);
  const [picked, setPicked] = useState<number | null>(null);
  const step = picked ?? (first === -1 ? 3 : first);
  const skip = () => { track(STEP_IDS[step] ?? "project", "closed"); close(); };
  const next = () => setPicked(nextStep(done, step));
  const finishAgentStep = () => setPicked(nextStep(done, 1));
  const agentDoneTracked = useRef(false);
  const trackAgentDone = useCallback((detail: SetupDetail) => {
    if (agentDoneTracked.current) return;
    agentDoneTracked.current = true;
    track("agent", "done", detail);
  }, []);
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
  const [countdown, setCountdown] = useState<number | null>(null);
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  useEffect(() => {
    if (step === 1 && picked === null) setPicked(1);
    const had = hadAgents.current;
    hadAgents.current = { claude, codex };
    if (step !== 1) {
      setStamped(false);
      return setCountdown(null);
    }
    if ((claude && !had.claude) || (codex && !had.codex)) setStamped(true);
    if (claude && codex && !(had.claude && had.codex)) setCountdown(AGENT_COUNTDOWN);
  }, [claude, codex, step, picked]);
  const advanceAfterCountdown = useRef<() => void>(() => {});
  useEffect(() => {
    advanceAfterCountdown.current = () => {
      void (async () => {
        await saveShownChoices().catch((error: unknown) => {
          appToast.error(error instanceof Error ? error.message : "Could not save setup preferences.");
        });
        if (stepRef.current !== 1) return;
        trackAgentDone("both");
        finishAgentStep();
      })();
    };
  });
  useEffect(() => {
    if (countdown === null) return;
    const timer = setTimeout(() => {
      if (countdown > 1) return setCountdown(countdown - 1);
      setCountdown(null);
      advanceAfterCountdown.current();
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdown]);
  const viewed = useRef(new Set<number>());
  const signInGroup = useAtomValue(signInGroupAtom);
  useEffect(() => {
    if (progress.checking || viewed.current.has(step)) return;
    const group = step === 0 && signInGroup ? (signInGroup === "manual" ? "manual" : "auto") : null;
    const timer = setTimeout(() => { viewed.current.add(step); track(STEP_IDS[step] ?? "project", "viewed", group); }, 1500);
    return () => clearTimeout(timer);
  }, [progress.checking, step, signInGroup]);
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
            <RoomLogo className="size-7" />
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
                    onClick={() => {
                      if (step === 1 && index > 1) void saveShownChoices();
                      setPicked(index);
                    }}
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
                      <strong className="block text-sm leading-tight font-semibold">{index === 0 && (progress.ownCore || (signedOut && ownCoreForm)) ? "Your own Core" : index === 2 && gitlabChosen ? "Connect GitLab" : title}</strong>
                      <small className="mt-0.5 block truncate text-[12.5px] text-(--ob-muted)">{meta}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <SharingNote className="mt-auto px-3" />
        </aside>
        <main className="relative flex min-w-0 flex-1 overflow-y-auto px-6 pt-16 pb-8 md:px-[110px] md:py-10">
          {signedOut && step === 0 ? (
            // Self-hosters need no account (docs/scopes/self-hosting.md). The step itself offers "Use without an account".
            <button type="button" onClick={() => setOwnCoreForm(!ownCoreForm)} className={CORNER}>
              <Icon name={ownCoreForm ? "ArrowLeft" : "Server"} className="size-3.5" aria-hidden />
              {ownCoreForm ? "Sign in instead" : "Use my own Core"}
            </button>
          ) : (
            <button type="button" onClick={skip} className={CORNER}>
              Skip setup
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          )}
          <div key={step} className={cn("my-auto w-full duration-300 animate-in fade-in-0 slide-in-from-bottom-1", step === 3 ? "max-w-[860px]" : "max-w-[600px]")}>
            {step === 1 && stamped ? <TickStamp key={`${claude}-${codex}`} /> : <RoomLogo className="mb-6 size-[72px] -rotate-[5deg]" />}
            <p className="font-serif text-base text-(--ob-muted) italic">Step {step + 1} of 4</p>
            {step === 0 && (progress.ownCore ? <OwnCoreDone next={next} /> : signedOut && ownCoreForm ? <OwnCoreStep /> : <AccountStep email={account.data?.account?.email ?? null} signingIn={account.data?.signingIn === true} error={account.data?.signInError ?? null} next={next} fresh={fresh} skip={signedOut ? skip : null} />)}
            {step === 1 && <AgentStep progress={progress} onDone={(detail) => { trackAgentDone(detail); finishAgentStep(); }} stamped={stamped} left={countdown} choices={choices} setChoices={setChoices} onChoiceShown={markChoiceShown} />}
            {step === 2 && <GithubStep progress={progress} next={next} stay={()=>setPicked(2)} />}
            {step === 3 && <ProjectStep close={leave} added={added} setAdded={setAdded} imported={imported} setImported={setImported} />}
            <SharingNote className="mt-10 md:hidden" />
          </div>
        </main>
      </div>
    </div>
  );
}

// The first-run notice that usage stats are on, with no click (docs/scopes/onboarding.md). Hidden when sharing is off.
function SharingNote({ className }: { className: string }) {
  const config = useSystemConfig().data;
  if (config?.telemetryAllowed === false || config?.generalSettings.telemetryEnabled !== true) return null;
  return <p className={cn("text-[12px] leading-relaxed text-(--ob-muted)", className)}>Cloudroom shares usage stats, never your prompts, code, or files. Turn it off in Settings.</p>;
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
  if (index === 0) return progress.account.data?.account?.email ?? (progress.ownCore ? "Connected" : "Signed in");
  if (index === 1) return [progress.agents.claude && "Claude Code", progress.agents.codex && "Codex", progress.agents.otherName].filter(Boolean).join(" + ");
  if (progress.gitlab.state?.login && progress.github.data?.state !== "connected") return "@"+progress.gitlab.state.login;
  return progress.github.data?.email ?? (progress.ownCore ? "On your server" : "Connected");
}

function Heading({ lead, mark }: { lead: string; mark: string }) {
  return (
    <h1 className="mt-1.5 font-serif text-[52px] leading-[1.08] font-medium tracking-[-0.025em]">
      {lead}{" "}
      <em className="bg-[linear-gradient(transparent_58%,var(--ob-lime)_58%,var(--ob-lime)_92%,transparent_92%)]">{mark}</em>
    </h1>
  );
}

const CORNER = cn("absolute top-5 right-6 flex items-center gap-1.5 text-[13px] text-(--ob-muted) hover:text-(--ob-ink)", MACOS_APP_REGION_NO_DRAG_CLASS);
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

// Keyed by the link, so "Copied" never carries over to a new sign-in attempt.
function CopyLink({ url }: { url: string }) {
  const { copied, copy } = useClipboardCopy({ text: url });
  return <button type="button" className={LINK} onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button>;
}

const SIGN_IN_COUNTDOWN = 3;
/** `skip` closes setup with no account: the app works without sign-in (ADR 20261116-210853). */
function AccountStep({ email, signingIn, error, next, fresh, skip }: { email: string | null; signingIn: boolean; error: string | null; next: () => void; fresh: boolean; skip: (() => void) | null }) {
  const signIn = useCloudroomSignIn();
  const busy = signingIn || signIn.isPending;
  const [group, setGroup] = useAtom(signInGroupAtom);
  const start = (detail: SetupDetail | null = null) => { track("account", "started", detail); signIn.mutate("signIn"); };
  const begin = () => { setGroup("auto_done"); if (!busy && !email) start("auto"); };
  const [left, setLeft] = useCountdown(true, begin);
  const openNow = () => { setLeft(null); begin(); };
  const cancel = () => { setLeft(null); setGroup("auto_done"); };
  // Only the desktop app on a new install, and only once: Cancel or a finished countdown never auto-opens again.
  const offered = fresh && !email && getRoomDesktopInfo() !== null;
  useEffect(() => {
    if (!offered || busy) return;
    if (group === null) setGroup(Math.random() < 0.2 ? "manual" : "auto");
    else if (group === "auto" && left === null) setLeft(SIGN_IN_COUNTDOWN);
  }, [offered, busy, group, left, setGroup, setLeft]);
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
          <Note>
            Finish in your browser.{" "}
            {signIn.data && <>Wrong browser? <CopyLink key={signIn.data} url={signIn.data} /> · </>}
            <button type="button" className={LINK} onClick={() => signIn.mutate("cancel")}>Cancel</button>
          </Note>
        </div>
      ) : left !== null ? (
        <>
          <p className="mt-3 text-base text-(--ob-muted)">Use the account you made on cloudroom.dev.</p>
          <div className="mt-8 flex items-center gap-5">
            <Cta onClick={openNow}>Opening your browser in {left}…</Cta>
            <Note>
              <button type="button" className={LINK} onClick={openNow}>Open now</button> · <button type="button" className={LINK} onClick={cancel}>Cancel</button>
              {skip && <> · <button type="button" className={LINK} onClick={skip}>Use without an account</button></>}
            </Note>
          </div>
          <CountdownBar seconds={SIGN_IN_COUNTDOWN} />
          <p className="mt-6 text-sm text-(--ob-muted)">Already signed in on cloudroom.dev? You come right back.</p>
        </>
      ) : (
        <>
          <p className="mt-3 text-base text-(--ob-muted)">Use the account you made on cloudroom.dev.</p>
          <div className="mt-8 flex flex-col items-start gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Cta onClick={() => start()}>Sign in with browser <Icon name="ArrowRight" aria-hidden /></Cta>
              {skip && <button type="button" onClick={skip} className="inline-flex h-12 items-center justify-center border border-(--ob-ink) px-7 text-[15.5px] font-semibold text-(--ob-ink) transition-colors hover:bg-(--ob-card)">Use without an account</button>}
            </div>
            {error ? <p role="alert" className="text-[13px] text-(--ob-error)">{error}</p> : <Note>Already signed in there? You come right back.</Note>}
          </div>
        </>
      )}
    </>
  );
}

const FIELD = "h-11 w-full border border-(--ob-line) bg-(--ob-card) px-3.5 text-[14px] text-(--ob-ink) outline-none placeholder:text-(--ob-muted) focus:border-(--ob-ink)";

/** Step 1 for self-hosters: connect the Core by URL and token. Setup stays open and moves on to the agents. */
function OwnCoreStep() {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const keepOpen = useSetAtom(openAtom);
  const connect = useOwnCoreConnection(() => keepOpen(true));
  const failure = connect.failure;
  return (
    <>
      <Heading lead="Connect your own" mark="Core" />
      <p className="mt-3 text-base text-(--ob-muted)">Use its address and the API token from /etc/cloudroom/core.env.</p>
      <form className="mt-8 flex max-w-[460px] flex-col gap-3" onSubmit={(event) => { event.preventDefault(); connect.mutate({ url, token }); }}>
        <input aria-label="Core URL" className={FIELD} placeholder="https://my-core.example.ts.net" value={url} onChange={(event) => setUrl(event.target.value)} autoComplete="off" spellCheck={false} />
        <input aria-label="Core API token" type="password" className={FIELD} placeholder="API token" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" />
        <div className="mt-3 flex items-center gap-5">
          <Cta type="submit" disabled={connect.isPending || !url.trim() || !token.trim()}>{connect.isPending ? "Connecting…" : <>Connect <Icon name="ArrowRight" aria-hidden /></>}</Cta>
          {failure ? <p role="alert" className="text-[13px] text-(--ob-error)">{failure}</p> : <Note>No Cloudroom account needed.</Note>}
        </div>
      </form>
    </>
  );
}

function OwnCoreDone({ next }: { next: () => void }) {
  return (
    <>
      <Heading lead="Connected to your" mark="Core" />
      <div className="mt-8 flex items-center gap-5">
        <Cta onClick={next}>Continue <Icon name="ArrowRight" aria-hidden /></Cta>
        <Note>No Cloudroom account needed.</Note>
      </div>
    </>
  );
}

type Choices = { macAccess: boolean; copyLogins: boolean };
function AgentStep({ progress, onDone, stamped, left, choices, setChoices, onChoiceShown }: { progress: ReturnType<typeof useSetupProgress>; onDone: (detail: SetupDetail) => void; stamped: boolean; left: number | null; choices: Choices; setChoices: (choices: Choices) => void; onChoiceShown: (kind: "mac" | "logins") => void }) {
  const { account, agents, codex, ready, offline } = progress;
  const defaultAgent = useSystemConfig().data?.generalSettings.defaultProviderId;
  const { localHostId } = useHostDaemon();
  const here = useThisComputer();
  const claudeLocal = useClaudeConnection({ target: "local", hostId: localHostId });
  const macAgents = useMacAgents();
  const installedMacAgents = useInstalledMacAgents();
  const detected = useRef(false);
  useEffect(() => {
    if (detected.current || installedMacAgents.isPending) return;
    detected.current = true;
    const installed = installedMacAgents.data ?? [];
    const claude = installed.includes("claude"), codexFound = installed.includes("codex");
    const extra = installed.filter((id) => id !== "claude" && id !== "codex").map(agentDetail);
    track("agent", "detected", claude && codexFound ? "both" : claude ? "claude" : codexFound ? "codex" : "none", extra);
  }, [installedMacAgents.isPending, installedMacAgents.data]);
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
  const saveMacAccess = useSetMacAccess(undefined, { showErrorToast: false });
  const saveCopyLogins = useSetCopyLogins();
  const [askedAccess] = useState(() => ({ mac: account.data?.macAccessSupported !== false && account.data?.macAccess == null, logins: account.data?.copyLogins == null }));
  // Windows (#958): setup never asks or saves computer access, so Connect can't save the ticked default. The sidebar
  // chip asks once instead (MacAccessChip). Until the server says its system, nothing is saved either.
  const os = account.data?.computerOs;
  const ask = { ...askedAccess, mac: askedAccess.mac && os !== undefined && os !== "windows" };
  const { macAccess, copyLogins } = choices;
  const showingChoices = Boolean(agents.claude || agents.codex || agents.other);
  useEffect(() => {
    if (!showingChoices) return;
    if (ask.mac) onChoiceShown("mac");
    if (ask.logins) onChoiceShown("logins");
  }, [showingChoices, ask.mac, ask.logins, onChoiceShown]);
  // Save whenever a box differs from the saved choice, so re-checking it after a Connect works.
  const saveChoices = () =>
    Promise.all([
      ask.mac && account.data?.macAccess !== macAccess && saveMacAccess.mutateAsync(macAccess),
      ask.logins && account.data?.copyLogins !== copyLogins && saveCopyLogins.mutateAsync(copyLogins),
    ]);
  const connectCodex = useMutation({
    mutationFn: async () => {
      // Codex sandbox sign-in needs copyLogins, never macAccess before that box is even shown.
      if (ask.logins && account.data?.copyLogins !== copyLogins) await saveCopyLogins.mutateAsync(copyLogins);
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
  const finish = useMutation({
    mutationFn: saveChoices,
    onSuccess: () => {
      onDone(agents.other ? agentDetail(agents.other) : agents.claude && agents.codex ? "both" : agents.claude ? "claude" : "codex");
    },
    meta: { showErrorToast: false },
    onError: (error) => appToast.error(error.message),
  });
  const codexBrowser = codex.data?.state === "waiting" && !codex.data.user_code ? codex.data : null;
  // Connect installs a missing Codex first; the button shows it (ADR 20261111-123959).
  const codexInstalling = useInstallPercent(codexBrowser?.installing_since);
  // An install or sign-in that fails after Connect arrives through the status poll, not the mutation: show it once.
  const codexState = codex.data?.state;
  const codexMessage = codex.data?.message;
  const codexWasWaiting = useRef(false);
  useEffect(() => {
    if (codexState === "error" && codexWasWaiting.current && codexMessage) appToast.error(codexMessage);
    codexWasWaiting.current = codexState === "waiting";
  }, [codexState, codexMessage]);
  const waiting = progress.ownCore ? (ready ? null : "Your Core isn't reachable") : !account.data?.account ? "Log in first" : offline ? "Cloud unreachable" : !ready ? "Starting your cloud…" : null;
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
          {action(agents.claude, <span onClickCapture={() => started("claude")}><ClaudeConnectionButton target="cloud" className={CONNECT} /></span>)}
        </Card>
        <Card on={agents.codex} isDefault={agents.codex && defaultAgent === "codex"} logo={<AgentLogo id="codex" className="bg-black text-white" />} name="Codex" detail={account.data?.localLogins?.codex ? `Found on ${here}` : "Uses your ChatGPT plan"}>
          {action(agents.codex, codexBrowser && codexInstalling === null ? (
            <Note>
              Finish in your browser.{" "}
              {codexBrowser.verification_url && <button type="button" className={LINK} onClick={() => openUrlInExternalBrowser(codexBrowser.verification_url!)}>Reopen</button>}
            </Note>
          ) : (
            <Outline className={cn(CONNECT, "tabular-nums")} disabled={connectCodex.isPending || codexInstalling !== null} onClick={() => { started("codex"); connectCodex.mutate(); }}>{codexInstalling !== null ? `Installing ${codexInstalling}%` : connectCodex.isPending ? "Connecting…" : "Connect"}</Outline>
          ))}
        </Card>
      </div>
      <MoreAgents agents={macAgents.data ?? []} picked={agents.other} pick={pick} />
      {offline && <CloudOffline />}
      {/* Hidden until an agent connects, so the choices don't distract from Connect. */}
      {showingChoices && (ask.mac || ask.logins) && (
        <div className="mt-4 flex gap-6 text-[12.5px] text-(--ob-muted) duration-300 animate-in fade-in-0">
          {ask.logins && <Choice checked={copyLogins} onChange={(value) => { setChoices({ ...choices, copyLogins: value }); if (account.data?.copyLogins != null && account.data.copyLogins !== value) saveCopyLogins.mutate(value); }} label="Copy logins to the cloud" detail="Agent logins, API keys, and model providers." />}
          {ask.mac && <Choice checked={macAccess} onChange={(value) => { setChoices({ ...choices, macAccess: value }); if (account.data?.macAccess != null && account.data.macAccess !== value) saveMacAccess.mutate(value); }} label="Let cloud agents use this computer" detail="Far more powerful agents. Turn off anytime." />}
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
          <span className="bb-hero-progress-fill block h-full bg-(--ob-ink)" style={{ "--room-hero-slide-duration": `${AGENT_COUNTDOWN}s` } as CSSProperties} />
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

/** Counts down a second at a time while `ready`, then runs `done`. Returns the seconds left (null when stopped) and its setter. */
function useCountdown(ready: boolean, done: () => void) {
  const [left, setLeft] = useState<number | null>(null);
  const finish = useRef(done);
  useEffect(() => { finish.current = done; });
  useEffect(() => {
    if (left === null || !ready) return;
    const timer = setTimeout(() => {
      if (left > 1) return setLeft(left - 1);
      setLeft(null);
      finish.current();
    }, 1000);
    return () => clearTimeout(timer);
  }, [left, ready]);
  return [left, setLeft] as const;
}
const CountdownBar = ({ seconds }: { seconds: number }) => (
  <div className="mt-3.5 h-1.5 w-[360px] bg-(--ob-line)">
    <span className="bb-hero-progress-fill block h-full bg-(--ob-ink)" style={{ "--room-hero-slide-duration": `${seconds}s` } as CSSProperties} />
  </div>
);

const GITHUB_COUNTDOWN = 4;
const openGithub = (url: string) => { if (new URL(url).origin === "https://github.com") openUrlInExternalBrowser(url); };

function GithubStep({ progress, next, stay }: { progress: ReturnType<typeof useSetupProgress>; next: () => void; stay:()=>void }) {
  const { github, gitlab, account, ready, offline } = progress;
  const here = useThisComputer();
  const client = useQueryClient();
  const requestId = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: ["cloudroom-github-auth"] });
  const connect = useMutation({
    mutationFn: async () => {
      track("github", "started", "repos");
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
  const copyMac = useMutation({
    mutationFn: async (expectedLogin: string | null) => {
      track("github", "started", "mac");
      return sdk.cloudroom.copyMacGithub(expectedLogin);
    },
    onSuccess: (result) => {
      client.setQueriesData({ queryKey: ["cloudroom-github-auth"] }, result);
      void client.invalidateQueries({ queryKey: ["cloudroom-github-account"] });
      track("github", "done", "mac");
      next();
    },
    meta: { showErrorToast: false },
    onError: () => { void refresh(); },
  });
  const cancel = useMutation({
    onMutate: () => setLeft(null),
    mutationFn: () => sdk.cloudroom.cancelGithubLogin(requestId.current ?? github.data?.login_id ?? ""),
    onSettled: refresh,
  });
  const state = github.data?.state;
  const connected = state === "connected";
  const onServer = progress.ownCore; // Never queries GitHub: its server has its own login.
  const localGithub = !connected && !onServer ? github.data?.local_github ?? null : null;
  const busy = connect.isPending || copyMac.isPending;
  const error = copyMac.error?.message ?? (!connected && (state === "error" || state === "expired") ? github.data?.message : null);
  const code = state === "waiting" ? github.data?.user_code : null;
  const url = state === "waiting" ? github.data?.verification_url : null;
  const [left, setLeft] = useCountdown(Boolean(url), () => { if (url) openGithub(url); });
  // After the code is approved, the same login waits with GitHub's page for picking repos and no code. It opens by
  // itself once, right after the code screen, like the code's page did.
  const pick = Boolean(url) && !code;
  const hadCode = useRef(false);
  useEffect(() => {
    if (code) hadCode.current = true;
    else if (pick && hadCode.current) { hadCode.current = false; setLeft(GITHUB_COUNTDOWN); }
  }, [code, pick, setLeft]);
  const open = () => {
    setLeft(null);
    if (url) openGithub(url);
  };
  // Someone whose account or organization already has the app skips the picking screen, so the repos may not be the
  // ones they had in mind: the link opens GitHub's page for changing them.
  const repos = useQuery({ queryKey: ["cloudroom-github-account"], enabled: connected && !onServer, retry: false, queryFn: ({ signal }) => sdk.cloudroom.githubAccount(signal) }).data?.reposUrl;
  const copyAgain = async () => {
    if (code && await copyToClipboardWithToast(code, { successMessage: "Code copied." })) setCopied(true);
  };
  const detail = connected
    ? repos ? "Cloud agents can use the repos Cloudroom has on GitHub." : "Cloud agents can use your repos."
    : onServer ? "Your Core uses the GitHub login set up on its server."
    : !account.data?.account ? "Log in first" : offline ? "Cloud unreachable" : !ready ? "Starting your cloud…"
    : localGithub ? `Found ${localGithub.login ? `@${localGithub.login}` : "GitHub CLI"} on ${here}. Nothing is shared until you click below.`
    : `Not found on ${here}. You'll copy a code, then paste it on github.com.`;
  if (gitlab.state?.waiting || (!connected && gitlab.state?.login && !gitlab.state.expired)) {
    const waiting = gitlab.state.waiting;
    return <>
      <Heading lead={waiting ? "Connect" : "Connected to"} mark="GitLab"/>
      <div className="mt-8"><Card on={!waiting} logo={<img className="size-8" src="/gitlab.svg" alt=""/>} name={waiting ? "GitLab.com" : "@"+gitlab.state.login}
        detail={waiting ? "Finish authorizing Cloudroom in your browser." : "Cloud agents can use your GitLab projects."}>{!waiting && <Connected/>}</Card></div>
      <div className="mt-8 flex items-center gap-5">
        {waiting ? <><Cta onClick={gitlab.open}>Open GitLab <Icon name="ExternalLink"/></Cta><Note><button className={LINK} disabled={gitlab.busy} onClick={()=>gitlab.change("cancel")}>Back to GitHub</button></Note></> :
          <Cta onClick={()=>{track("github","done","gitlab");next();}}>Continue <Icon name="ArrowRight"/></Cta>}
      </div>
      {gitlab.error && <p role="alert">{gitlab.error}</p>}
    </>;
  }
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
        {left !== null && <CountdownBar seconds={GITHUB_COUNTDOWN} />}
        <p className="mt-6 text-sm text-(--ob-muted)">
          On GitHub: press <b className="text-(--ob-ink)">⌘V</b> to paste, then click <b className="text-(--ob-ink)">Authorize</b>. This screen moves on by itself.
        </p>
      </>
    );
  }
  if (pick) {
    return (
      <>
        <Heading lead="Pick your" mark="repos" />
        <p className="mt-4 text-[15px] text-(--ob-muted)">GitHub is connected. Now choose which repos cloud agents may use.</p>
        <div className="mt-8 flex items-center gap-5">
          <Cta onClick={open}><Icon name="Github" aria-hidden />{left === null ? "Pick repos on GitHub" : `Opening GitHub in ${left}…`}</Cta>
          <Note>
            {left !== null && <><button type="button" className={LINK} onClick={open}>Open now</button> · </>}
            <button type="button" className={LINK} onClick={() => cancel.mutate()}>Cancel</button>
          </Note>
        </div>
        {left !== null && <CountdownBar seconds={GITHUB_COUNTDOWN} />}
        <p className="mt-6 text-sm text-(--ob-muted)">
          On GitHub: choose your account, pick <b className="text-(--ob-ink)">All repositories</b> or <b className="text-(--ob-ink)">Only select repositories</b>, then click <b className="text-(--ob-ink)">Install</b>. Install on your organization too if needed. This screen moves on by itself.
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
      {!connected && error && <p role="alert" className="mt-3 text-sm text-(--ob-error)">{error}</p>}
      {offline && <CloudOffline />}
      <div className="mt-8 flex items-center gap-5">
        {connected || onServer ? (
          <Cta onClick={() => { track("github", "done", repos ? "repos" : null); next(); }}>Continue <Icon name="ArrowRight" aria-hidden /></Cta>
        ) : localGithub ? (
          <Cta disabled={!ready || busy} onClick={() => { connect.reset(); copyMac.mutate(localGithub.login); }}>
            {copyMac.isPending ? (
              <><Icon name="Loading" className="animate-spin" aria-hidden />Connecting…</>
            ) : (
              <>{localGithub.login ? `Use @${localGithub.login}` : "Use GitHub CLI"} <Icon name="ArrowRight" aria-hidden /></>
            )}
          </Cta>
        ) : (
          <Cta disabled={!ready || busy} onClick={() => { copyMac.reset(); connect.mutate(); }}>
            <Icon name={connect.isPending ? "Loading" : "Github"} className={cn(connect.isPending && "animate-spin")} aria-hidden />
            {connect.isPending ? "Getting your code…" : "Connect GitHub"}
          </Cta>
        )}
        {!connected && !onServer && (
          <Note><button type="button" className={LINK} onClick={() => { track("github", "skipped"); next(); }}>Skip this step</button> if you only use public repos.</Note>
        )}
        {connected && repos && <Note><button type="button" className={LINK} onClick={() => openGithub(repos)}>Change repos</button> on GitHub.</Note>}
      </div>
      {!connected && !onServer && (localGithub || gitlab.state?.available || gitlab.error) && <div className="mt-3.5 text-[12.5px] text-(--ob-muted)">
        {localGithub && <button type="button" className={QUIET_LINK} disabled={!ready || busy} onClick={() => { copyMac.reset(); connect.mutate(); }}>Pick specific repos or another account</button>}
        {localGithub && gitlab.state?.available && " · "}
        {gitlab.state?.available && <button type="button" className={QUIET_LINK} disabled={gitlab.busy || !ready || busy} onClick={()=>{stay();track("github","started","gitlab");gitlab.change("start");}}>Use GitLab instead</button>}
        {gitlab.error && <p role="alert" className="text-xs text-(--ob-error)">{gitlab.error}</p>}
      </div>}
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
  const importRoom = useImportRoom();
  const sessions = useNativeSessions().data?.sessions;
  // An import empties the scan; keep "Import your work" with Continue instead of flipping to "No agent chats to import".
  const empty = sessions?.length === 0 && !imported;
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
    importRoom.mutate(localHostId, {
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
        <button type="button" className={QUIET_LINK} disabled={importRoom.isPending} onClick={bringWorkOver}>
          {importRoom.isPending ? "Bringing your BB threads over…" : "Coming from BB?"}
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
