import type { CreateSdkAreaArgs } from "./common.js";
import type { TeleportProgress, ThreadListEntry } from "@cloudroom/domain";

export interface CloudroomStorage {
  enabled: boolean;
  level: "normal" | "low_space" | "blocked";
  reason: "disk_capacity" | "measurement_unavailable" | "unprotected_test_mode";
  workspace_available_bytes: number | null;
  history_available_bytes: number | null;
  workspace_total_bytes: number | null;
  history_total_bytes: number | null;
  sampled_at: number | null;
}

/** Mac access levels (ADR 0186). */
export type MacAccessLevel = "off" | "read-only" | "ask" | "full";

export type CloudroomThreadStatus = { model: string; reasoning: string; error?: string | null; reconnecting?: boolean; waiting?: string | null };
/** A thread's Cloud Credits from the last 7 days, split by what used them (docs/scopes/thread-purpose.md). `credits` is
 *  null when they can't be known yet; `pending`: billed, but the split isn't ready; `partial`: the thread is older than 7 days. */
export type CloudroomThreadCredits = { credits: number | null; pending: boolean; awakeMinutes: number; partial: boolean; rows: { name: string; credits: number; ms: number | null; rest?: true }[] };

export interface CloudroomStatus {
  storage?: CloudroomStorage | null;
  ready: boolean;
  account: { id: string; email: string } | null;
  /** True only when the saved connection confirms no signed-in Cloudroom account (#872). */
  signedOut?: boolean;
  /** Connected to a core the user hosts, by URL and token, without a Cloudroom account. */
  selfHosted?: boolean;
  projectId: string | null;
  repository: string | null;
  model: string | null;
  error: string | null;
  sync?: { state: "synced" | "syncing" | "offline" | "conflict"; conflicts: number; issue: string | null } | null;
  previews?: { state: "connected" | "offline"; count: number; message: string | null; issue: string | null; explained?: boolean } | null;
  /** Cloud agents may run commands on this computer (ADR 0113); null until first-run setup asks. */
  macAccess?: boolean | null;
  /** How much cloud agents may do on this computer (ADR 0186); null until first-run setup asks. */
  macAccessLevel?: MacAccessLevel | null;
  /** Only older Windows servers send it, as false: hide Mac access for them. Newer servers support every system (#958). */
  macAccessSupported?: boolean;
  /** The levels this computer supports: macOS has all four, Linux and Windows only Off and Full. Missing from older servers. */
  macAccessLevels?: readonly MacAccessLevel[];
  /** The system of the computer whose access this is: the server's, not the viewer's. Missing from older servers. */
  computerOs?: "macos" | "linux" | "windows";
  /** Copy this computer's logins, API keys, and model providers to the VM (ADR 0130); null until first-run setup asks. */
  copyLogins?: boolean | null;
  /** Agent and GitHub CLI logins found on this computer. Claude's is checked through its provider plugin. */
  localLogins?: { codex: boolean; github?: boolean; githubUser?: string | null };
  signingIn: boolean;
  signInError: string | null;
  /** The account's place in the cloud queue, or a blocked region: new Cloud threads wait. Null when it may start them. */
  cloudQueue?: { position: number; total: number; regionBlocked: boolean } | null;
  /** Non-null when Metal capacity is temporarily reserved for higher plans and this account's tier waits. */
  cloudCapacity?: "paid" | "priority" | null;
  /** The website's database can't answer (an outage or planned work): Cloud waits and Local works. Missing from older servers. */
  cloudPaused?: boolean;
  /** The account's plan (free, pro, super, ultra) from the website's mode check; null while billing is off or unknown. */
  plan?: string | null;
  /** The account's Cloud Credits this credit period and when they refill (`resetsAt`, ADR 20261108-142517): Free's sidebar
   *  card, paid plans' meter from 75%. Null while billing is off or in the cloud queue; null credits while metering is stale. */
  planUsage?: { plan: string; credits: number | null; creditsLimit: number; resetsAt?: string | null; extraCredits?: number; extraCreditsTotal?: number } | null;
  /** Thread families burning Cloud Credits fast, by top thread: credits in the last hour, and how many subagents used most
   *  of them (0: the thread itself). The sidebar shows a red line under each (docs/scopes/credit-burn.md). */
  burning?: Record<string, { credits: number; subagents: number }>;
  /** The switch in Settings → General → DeepAPI. Null hides it. */
  deepapi?: { enabled: boolean } | null;
}

export interface CloudroomCodexAuth {
  state: "missing" | "waiting" | "connected" | "limited" | "unavailable" | "error" | "expired";
  email: string | null;
  plan: string | null;
  message: string | null;
  login_id: string | null;
  verification_url: string | null;
  user_code: string | null;
  /** Claude and Codex: when Cloudroom started installing the missing CLI for this sign-in, in ms since 1970. */
  installing_since?: number | null;
}

export interface CloudroomGithubAuth extends CloudroomCodexAuth {
  /** Local `gh` login found on this computer while Cloud has no GitHub login. Nothing is uploaded until `copyMacGithub()`. */
  local_github?: { login: string | null } | null;
}

/** This Mac's Cloudroom Connect address and tunnel credential (ADR 0184). */
export interface CloudroomConnectRegistration {
  handle: string;
  credential: string;
  serverUrl: string;
  accountId: string;
}

/** The GitHub account cloud sandboxes clone and push as. */
export interface CloudroomGithubAccount {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** Set when the login reaches only the repos its owner picked: GitHub's page for changing them. */
  reposUrl?: string;
}

/** Every new cloud thread starts with these (synced with the website). Values are never returned; `hint` is the
 *  last 4 characters of long values. */
export interface CloudEnvironment {
  variables: { name: string; hint: string }[];
  setup: string;
  /** `owner/name` GitHub repos every sandbox clones into /repos/<name>. */
  repos: string[];
  /** MCP servers copied from this Mac into every sandbox, by name. */
  mcp: string[];
  /** Repos RepoSync commits and pushes to `branch`, `every` seconds after edits stop (docs/scopes/repo-sync.md). */
  repoSync: CloudRepoSync[];
  /** A repo's branches, default first; only answered to `githubBranches`. */
  branches?: string[];
  /** The account's GitHub repos, newest first; only answered to `githubRepos`. */
  available?: string[];
  /** Last push time of each `available` repo, in ms. */
  pushed?: Record<string, number>;
  /** GitHub's ID of each `available` repo, which survives renames and transfers. */
  ids?: Record<string, number>;
  /** The GitHub account the repos belong to; only answered to `githubRepos`. */
  login?: string;
  /** How many Cloud loops picked each API key (ADR 0342); keys no loop picked are missing. */
  loops?: Record<string, number>;
}

/** A repo that is not a Cloudroom project yet: a Git folder on this Mac, or a GitHub repo. */
export type GitlabConnection = { available: boolean; login: string | null; expired: boolean; waiting: boolean; url?: string };
export type RepoSuggestion =
  | { source: "mac"; name: string; path: string; updatedAt: number }
  | { source: "github" | "gitlab"; name: string; repo: string; updatedAt: number | null };
export type CloudRepoSync = { repo: string; branch: string; every: number; on: boolean };
export type CloudEnvironmentChange =
  | { action: "repoSync"; repo: string; on?: boolean; branch?: string; every?: number; remove?: boolean }
  | { action: "githubBranches"; repo: string }
  | { action: "set"; variables: Record<string, string> }
  | { action: "remove"; name: string }
  | { action: "setup"; setup: string }
  | { action: "addRepo"; repo: string }
  | { action: "removeRepo"; repo: string }
  | { action: "githubRepos" };
export type AutoDeleteDays = 30 | 90 | 180 | 365 | null;
/** A plan's name and how long it keeps unused cloud threads, in days and in words. */
export type AutoDeleteLimit = { name: string; days: number; label: string };
/** The setting, the days unused threads really stay, the plan limit that caps them, and the plan that allows longer. Null from older websites. */
export type AutoDeleteSetting = { days: AutoDeleteDays; kept: number | null; plan: AutoDeleteLimit | null; upgrade: AutoDeleteLimit | null };

/** The user's own VPS for Cloud threads (ADR 0319). `health` is live, null while the VPS is offline; `busy` names what
 *  is over its limit, when new threads would go to Cloud instead. `critical`: memory or disk so full that its threads
 *  may break, so the app offers to move them to Cloud. */
export type CloudVps = {
  connected: boolean; name: string | null; useForCloud: boolean; fallback: boolean; busy: string | null;
  /** The live health check's answer; `connected` only means paired. Null when not paired, absent from older websites (#2025). */
  state?: "online" | "busy" | "unreachable" | null;
  critical?: { kind: "memory" | "disk"; used: number; total: number } | null;
  health: { cpu: number; memory: { used: number; total: number }; disk: { used: number; total: number }; running: number; os?: string | null } | null;
};
export type CloudVpsAction = { action: "code" } | { action: "disconnect" } | { action: "settings"; useForCloud?: boolean; fallback?: boolean };

/** An automation that runs in the cloud (ADR 0212): the website re-prompts a Cloud thread on a schedule. */
export interface CloudAutomation {
  id: string;
  thread_id: string;
  session_id: string | null;
  name: string;
  prompt: string;
  cron: string | null;
  timezone: string;
  run_at: string | null;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  failures: number;
  runs: number;
  origin: "app" | "agent";
  created_at: string;
  /** The loop's project: its home for a project loop, else its thread's project. Null when the thread is gone. */
  project_id?: string | null;
  /** Each run starts a fresh Cloud thread in its own sandbox (ADR 0239). Missing until the website's 0069 update. */
  new_thread?: boolean;
  /** Runs first in the thread's sandbox: no output skips the run, output goes to the agent (ADR 0246). */
  script?: string | null;
  /** A webhook loop's secret URL (ADR 0262), only in the answer that creates it: the website keeps just its hash. */
  url?: string;
  /** A fresh-thread loop's own agent (app provider ID; null model is the agent's default). Null for same-thread loops,
   *  which use their thread's, or until its settings are saved. Missing from older websites. */
  agent?: CloudLoopAgent | null;
  /** A loop's agents when it has two or more, in turn order: each run takes the next (docs/scopes/loops.md). `agent` is
   *  the first. Missing from older websites. */
  agents?: CloudLoopAgent[];
  /** P1-P4 (docs/scopes/loops.md). Missing until the website's 0094 update. */
  priority?: number;
  /** The API keys a fresh-thread loop's runs get, and `.env` for the project's .env files (ADR 0342); null for all of
   *  them. Missing until the website's 0103 update. */
  secrets?: string[] | null;
  /** A Jev loop's action script (docs/scopes/loops.md, Jev loops): it runs no agent, its `prompt` holds Jev's questions
   *  as JSON, and its `agent` is the provider `jev`. Missing from ordinary loops and older websites. */
  jev_action?: string | null;
}
/** A Cloud loop's agent: the app's provider ID; a null model is the agent's default. */
export type CloudLoopAgent = { provider: string; model: string | null; reasoning: string | null };
/** One Cloud loop run's record (ADR 0298): what its agent reported, or null fields while it runs or never reported. */
export interface CloudLoopRun {
  /** Null for a Jev loop's run: no agent, so no thread. */
  thread_id: string | null;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  confidence: string | null;
  reason: string | null;
  actions: string[] | null;
}
/** `harness` is Core's harness name or the app's provider ID; only fresh-thread loops pick an agent. */
export type CloudAutomationFields = { name?: string; prompt?: string; cron?: string | null; timezone?: string; run_at?: string | null; enabled?: boolean; script?: string | null; new_thread?: boolean; webhook?: true; harness?: string; model?: string; reasoning?: string; agents?: { harness: string; model: string; reasoning?: string }[]; priority?: number; secrets?: string[] | null; jev_action?: string };
/** Webhook events the website holds for one Local webhook loop on this Mac (ADR 0262). Ack the batch once its run starts. */
export interface CloudHookBatch {
  local: string;
  batch: string;
  events: { id: number; kind: string | null; body: string; received_at: string }[];
}
export type CloudAutomationRequest =
  | { action: "list"; thread?: string }
  // A fresh-thread loop is made from its project; a loop that re-prompts a thread, from that thread.
  | ({ action: "create"; thread?: string; project?: string } & CloudAutomationFields)
  | ({ action: "update"; id: string } & CloudAutomationFields)
  | { action: "run" | "delete" | "hook"; id: string }
  // A cloud loop's run threads from the last 7 days, for its usage estimate (docs/scopes/loops.md).
  | { action: "runs"; id: string }
  // What a completed run of each template usually uses, across accounts (docs/scopes/loops.md). A template with too few
  // accounts is left out. Older websites refuse it.
  | { action: "averages" }
  // A cloud loop's newest run records (ADR 0298), for `room-cli loop runs ID`.
  | { action: "history"; id: string; limit?: number }
  // Loops → Review (ADR 0298): the reports of these Local runs and of the Cloud runs that started these threads (this
  // app sends their requests). Older websites refuse it.
  | { action: "reports"; runs: string[]; threads: string[] }
  // Webhook loops (ADR 0262): a Local loop's URL, its removal, the events waiting for this Mac's loops, and their ack.
  | { action: "hook" | "unhook"; local: string }
  | { action: "events"; local: string[] }
  | { action: "ack"; batches: string[] }
  // Stop loops at plan limits (ADR 0292): read the account's switch, or set it with `stop_at_limit`.
  | { action: "settings"; stop_at_limit?: boolean; fallback?: boolean }
  // Loop run records (ADR 0298): a Local loop run's `room-cli loop report`, saved with Cloud runs.
  | { action: "report"; local: string; run: string; thread: string; name: string; started_at: string; outcome: string; confidence: string; reason: string; actions: string[] };
export type CloudAutomationResponse = { automations?: CloudAutomation[]; automation?: CloudAutomation; ok?: boolean; url?: string; batches?: CloudHookBatch[]; recheck_ms?: number; stop_at_limit?: boolean; fallback?: boolean; runs?: string[]; history?: CloudLoopRun[]; reported?: boolean; reports?: { request: string; thread_id: string; outcome: string; reason: string | null }[]; averages?: { name: string; harness: string; runs: number; accounts: number; tokens: number }[] };
/** Weighted tokens the listed threads used since `threadsSince`, and all of the provider's threads since `totalSince`. */
export type TokenUsageRequest = { providerId: string; threadIds: string[]; threadsSince: number; totalSince: number };
export type TokenUsageResponse = { total: number; threads: Record<string, number> };

/** A skill on this Mac. `cloud` means every new cloud thread gets it. */
export interface CloudSkill {
  name: string;
  description: string;
  cloud: boolean;
}
/** `auto`: skills added to this Mac later go to the cloud too. `issue`: why the last upload failed. */
export interface CloudSkills {
  auto: boolean;
  skills: CloudSkill[];
  issue: string | null;
}
export type CloudSkillsChange = { names: string[]; cloud: boolean } | { auto: boolean };
/** An MCP server on this Mac (Claude Code or Codex). `macOnly`: it runs a program or uses a path only this Mac has.
 *  `signIn`: a cloud server that uses OAuth, "needed" until the user signs in once for the cloud. */
export interface MacMcpServer {
  name: string;
  macOnly: boolean;
  signIn?: "needed" | "done";
}

/** A CLI on this Mac with the setup-script lines that install it in a cloud sandbox. `key`: the API key it signs in with. */
export interface MacCli { name: string; title: string; key?: string; install: string }

/** Codex accounts the website keeps and renews (ADR 0195). Responses never hold tokens. */
export type CodexAccountsInput =
  | { action: "list" | "start" }
  | { action: "poll"; sessionId: string }
  | { action: "use"; id: string | null }
  | { action: "remove"; id: string }
  | { action: "rename"; id: string; name: string }
  | { action: "move"; id: string; direction: "up" | "down" };
export interface CodexAccountView { id: string; name: string | null; email: string | null; plan: string | null; inUse: boolean; error: string | null; credits?: { detail: string | null } | null; windows: { label: string; usedPercent: number; resetsAt: number | null }[] }
export type CodexAccountsResult =
  | { signedIn: boolean; accounts: CodexAccountView[] }
  | { sessionId: string; verificationUri: string; userCode: string; expiresAt: number }
  | { status: "pending" | "complete" | "error"; message: string | null };

/** The accounts a Cloud login switch moves between, by name, for the line it leaves in limited threads. */
export interface CloudAccountSwitch { from: string; to: string }

export interface ClaudeAccountInput { action?: "login" | "cancel" | "complete" | "setup-token" | "key" | "token"; requestId?: string; code?: string; state?: string; apiKey?: string; token?: string; plan?: string; follow?: boolean; switched?: CloudAccountSwitch }

export interface CloudroomArea {
  claudeAuth(input?: ClaudeAccountInput, signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  /** Lists, signs in, selects, renames, orders, or removes Codex accounts. `list` answers `{ signedIn, accounts }`,
   *  `start` the device code, and `poll` the sign-in's status. Other actions answer the new list. */
  codexAccounts(input: CodexAccountsInput, signal?: AbortSignal): Promise<CodexAccountsResult>;
  cursorAuth(signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  cursorLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cancelCursorLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cursorApiKey(requestId: string, apiKey: string): Promise<CloudroomCodexAuth>;
  /** The Accounts plugin's Cursor account in use becomes the Cloud login: its API key, or with `null` this computer's own
   *  Cursor login again. */
  cursorAccount(input: { requestId: string; apiKey: string | null; switched?: CloudAccountSwitch }): Promise<CloudroomCodexAuth>;
  piApiKey(provider: string, apiKey: string): Promise<{ providers: string[] }>;
  codexAuth(signal?: AbortSignal): Promise<CloudroomCodexAuth>;
  codexLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cancelCodexLogin(requestId: string): Promise<CloudroomCodexAuth>;
  /** GitHub for cloud sandboxes: connected when the website holds a login; when missing, includes any local `gh` account detected on this computer. */
  githubAuth(signal?: AbortSignal): Promise<CloudroomGithubAuth>;
  /** Copies this computer's local `gh` login to Cloud once after explicit user confirmation (ADR 20261124-215124). */
  copyMacGithub(expectedLogin?: string | null): Promise<CloudroomGithubAuth>;
  /** Runs the GitHub App device flow, then waits for the user to pick repos on GitHub (all or selected) unless already installed. */
  githubLogin(requestId: string): Promise<CloudroomCodexAuth>;
  cancelGithubLogin(requestId: string): Promise<CloudroomCodexAuth>;
  /** Null when GitHub can't tell right now. */
  githubAccount(signal?: AbortSignal): Promise<CloudroomGithubAccount | null>;
  /** Removes the cloud GitHub login and stops copying this Mac's `gh` login. */
  disconnectGithub(): Promise<void>;
  /** Disconnect: signs the agent's login out on this Mac and removes it from Cloud. `remove` also hides the agent (ADR 0327). */
  disconnectAgent(providerId: string, input?: { remove?: boolean }): Promise<void>;
  /** Shows a removed agent again and lets its login copy again. */
  restoreAgent(providerId: string): Promise<void>;
  checkPreviews(): Promise<void>;
  /** Recently updated repos on this Mac and GitHub that no project uses yet. */
  repoSuggestions(signal?: AbortSignal): Promise<{ githubConnected: boolean; repos: RepoSuggestion[] }>;
  /** Only this Mac's repos. Fast: no GitHub calls, so the picker shows them while `repoSuggestions` loads. */
  macRepoSuggestions(signal?: AbortSignal): Promise<{ repos: RepoSuggestion[] }>;
  /** Makes an `owner/name` GitHub repo a project right away. Machines and sandboxes clone it when first needed. */
  gitlabConnection(action: "status" | "start" | "cancel" | "disconnect", signal?: AbortSignal): Promise<GitlabConnection>;
  gitlabCheck(repo: string, signal?: AbortSignal): Promise<{accessible:boolean}>;
  addGitlabRepo(input: {repo:string}): Promise<{projectId:string}>;
  addGithubRepo(input: { repo: string }): Promise<{ projectId: string }>;
  /** Another project a new thread's prompt looks like it belongs in, or null. */
  projectSuggestion(input: { prompt: string; projectId: string }, signal?: AbortSignal): Promise<{ projectId: string | null }>;
  promptSuggestion(input: { threadId: string }, signal?: AbortSignal): Promise<{ suggestion: string | null }>;
  promptSuggestionEvent(input: { threadId: string; action: "shown" | "accepted" }): Promise<{ ok: boolean }>;
  /** A skill to save, when this thread just finished a job the user keeps repeating (docs/scopes/skill-suggestions.md). */
  skillSuggestion(input: { threadId: string }, signal?: AbortSignal): Promise<{ suggestion: { name: string; what: string; count: number; prompt: string } | null }>;
  skillSuggestionEvent(input: { threadId: string; action: "shown" | "accepted" | "dismissed" }): Promise<{ ok: boolean }>;
  searchRank(input: { query: string; items: { id: string; title: string; text: string }[] }, signal?: AbortSignal): Promise<{ probabilities: Record<string, number> | null; ranked: string[] }>;
  /** Cmd+K "Search deeper": a Claude Code agent reads threads and returns its best 5, best first. */
  deepSearch(input: { query: string }, signal?: AbortSignal): Promise<{ threads: ThreadListEntry[] }>;
  /** A project's branches on GitHub, for a project with no folder on this Mac. */
  projectBranches(projectId: string, signal?: AbortSignal): Promise<{ defaultBranch: string | null; branches: string[] }>;
  githubBranches(projectId: string, signal?: AbortSignal): Promise<{ defaultBranch: string | null; branches: string[] }>;
  status(signal?: AbortSignal): Promise<CloudroomStatus>;
  /** `provider` opens that provider's sign-in directly instead of the website's sign-in page. */
  signIn(input?: { projectId?: string; websiteUrl?: string; provider?: "github" | "google" }): Promise<{ url: string }>;
  /** Connects a self-hosted core by its HTTPS URL and API token. The backend checks it before saving. */
  connect(input: { url: string; token: string }): Promise<void>;
  /** `true` means Full access. */
  setMacAccess(access: boolean | MacAccessLevel): Promise<void>;
  setCopyLogins(enabled: boolean): Promise<void>;
  /** Copies this computer's enabled logins to cloud sandboxes right away. */
  copyLoginsNow(): Promise<void>;
  /** Whether DeepAPI is paid from the account's Cloud Credits (Settings → General → DeepAPI). */
  setDeepapi(enabled: boolean): Promise<void>;
  environment(signal?: AbortSignal): Promise<CloudEnvironment>;
  updateEnvironment(change: CloudEnvironmentChange): Promise<CloudEnvironment>;
  autoDelete(signal?: AbortSignal): Promise<AutoDeleteSetting>;
  vps(signal?: AbortSignal): Promise<CloudVps>;
  /** `code` returns the one-time install command; `settings` and `disconnect` return the new state. */
  vpsAction(input: CloudVpsAction): Promise<CloudVps | { code: string; expiresAt: number; command: string } | { ok: true }>;
  /** Lists, creates, changes, runs, or deletes cloud automations. */
  automations(input: CloudAutomationRequest): Promise<CloudAutomationResponse>;
  /** Loop usage estimates (docs/scopes/loops.md): tokens a loop's runs used, and all of the provider's. */
  tokenUsage(input: TokenUsageRequest): Promise<TokenUsageResponse>;
  /** The Snippets plugin reads this device’s identity and exchanges libraries with the account API. */
  snippets(input: { action: string } & Record<string, unknown>): Promise<unknown>;
  /** Organizations (docs/scopes/organizations.md): passes one request to the website's `/api/desktop/org`, signed in as this account. */
  org(input: { action: string } & Record<string, unknown>): Promise<unknown>;
  /** Shared projects (docs/scopes/shared-projects.md): passes one request to the website's `/api/desktop/project-shares`, signed in as this account. */
  projectShares(input: { action: string } & Record<string, unknown>): Promise<unknown>;
  /** GPUs (docs/scopes/gpus.md): one `room-cli gpu` step for `/api/desktop/gpu`, signed in as this account. */
  gpu(input: { argv: string[]; thread?: string }): Promise<unknown>;
  /** Cloudroom Agent (docs/scopes/cloudroom-agent.md): a token from `/api/desktop/inference` that can only buy inference. */
  inference(): Promise<unknown>;
  setAutoDelete(days: AutoDeleteDays): Promise<AutoDeleteSetting>;
  /** Names of API keys and tokens set in this Mac's login shell, never their values. */
  macVariables(signal?: AbortSignal): Promise<{ names: string[] }>;
  /** Copies the named variables from this Mac's login shell into the Cloud environment. */
  importMacVariables(names: string[]): Promise<CloudEnvironment>;
  /** This Mac's skills and which of them new cloud threads get. */
  cloudSkills(signal?: AbortSignal): Promise<CloudSkills>;
  /** Adds or removes skills, or sets whether new skills go to the cloud. Uploads in the background. */
  setCloudSkills(change: CloudSkillsChange): Promise<CloudSkills>;
  /** CLIs on this Mac that the setup script can install in every cloud sandbox. */
  macClis(signal?: AbortSignal): Promise<{ clis: MacCli[] }>;
  /** This Mac's MCP servers. `CloudEnvironment.mcp` says which ones every new cloud thread gets. */
  macMcpServers(signal?: AbortSignal): Promise<{ servers: MacMcpServer[] }>;
  /** Copies MCP servers from this Mac to the Cloud environment, or removes them. */
  setCloudMcp(change: { names: string[]; cloud: boolean }): Promise<CloudEnvironment>;
  /** Starts a one-time cloud sign-in to an MCP server; open `url` in the browser. */
  startMcpSignIn(name: string): Promise<{ url: string }>;
  /** Mac → cloud: runs a shell command as the agent account of the VM, or of `threadId`'s sandbox. Input and output bytes are hex. */
  runOnVm(input: { command: string; stdin?: string; cwd?: string; threadId?: string }): Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean }>;
  cancel(): Promise<void>;
  logout(): Promise<void>;
  threadWorkspace(threadId: string, signal?: AbortSignal): Promise<CloudroomThreadWorkspace | null>;
  /** A Cloud thread's model and current effort, or null when it has no cloud session. `error` and `reconnecting`
   *  say why its start or messages aren't going through yet (older apps send neither); `waiting` is the website's
   *  words while its sandbox's server restarts or is full. */
  threadStatus(threadId: string, signal?: AbortSignal): Promise<CloudroomThreadStatus | null>;
  /** One website read per thread a minute at most (the app server caches it). */
  threadCredits(threadId: string, signal?: AbortSignal): Promise<CloudroomThreadCredits>;
  retryStart(threadId: string): Promise<void>;
  /** Clears package caches and Git-ignored dependency and build folders on a Cloud thread's sandbox, even while a full disk pauses its agent. */
  clearDisk(threadId: string): Promise<{ freedBytes: number }>;
  /** Copies a Cloud thread's project into its folder again after the copy failed. */
  retryCopy(threadId: string): Promise<{ status?: "cloning" | "copied" | "folder_not_empty" }>;
  /** During an outage, continues a Cloud thread from its older copy instead of waiting; newer work is lost. */
  continueFromCopy(threadId: string): Promise<void>;
  /** `choice` runs the cloud thread on another model when the cloud cannot offer the local one. */
  teleport(threadId: string, action?: "start" | "cancel", choice?: { model: string; reasoning: string }): Promise<TeleportProgress>;
  teleportStatus(threadId: string, signal?: AbortSignal): Promise<TeleportProgress | null>;
  teleportCheck(threadId: string, choice?: { model: string; reasoning: string }): Promise<{ model: string; reasoning: string; warnings: string[] }>;
  /** Moves a Cloud thread back to this Mac. `conflicts` counts cloud files saved under `.cloudroom/teleport/` because the local copy also changed. */
  teleportLocal(threadId: string): Promise<{ conflicts: number }>;
  /** Copies a cloud thread's branch into the Mac project without stopping its agent. */
  copyToMac(threadId: string): Promise<{ branch: string }>;
  /** Downloads a file from a cloud thread's machine into ~/Downloads and opens it. */
  openCloudFile(threadId: string, path: string): Promise<{ path: string }>;
  /** Moves a thread from the cloud VM into its own sandbox (moving off the VM). Returns Teleport progress. */
  moveToSandbox(threadId: string): Promise<TeleportProgress>;
  /** Copies open BB threads into idle Local threads by forking their native sessions. Sends no prompts. */
  importBb(hostId: string): Promise<RoomImportResult>;
  /** Claude Code and Codex chats on this Mac that are not in Cloudroom yet, newest first. `claudeConfigDir` reads Claude Code chats from another config folder. */
  nativeSessions(signal?: AbortSignal, claudeConfigDir?: string): Promise<{ sessions: NativeSession[]; conductorApp?: boolean }>;
  /** Copies chosen chats into idle Local threads by forking their native sessions. Sends no prompts. */
  importSessions(hostId: string, sessions: { harness: NativeSession["harness"]; id: string }[], claudeConfigDir?: string): Promise<SessionImportResult>;
  /** Lists the chats in a Conductor Cloud export (its unzipped folder, or the .zip). */
  conductorExport(path: string): Promise<{ sessions: NativeSession[] }>;
  importConductorExport(hostId: string, path: string): Promise<SessionImportResult>;
  /** Every Local and Cloud thread that can be exported, with when it last changed. */
  exportableChats(signal?: AbortSignal): Promise<{ threads: { target: "local" | "cloud"; updatedAt: number }[] }>;
  /** Writes chats as Markdown or JSON files into a new folder in ~/Downloads and opens it. */
  exportChats(input: { scope: "all" | "local" | "cloud"; days: number | null; format: "markdown" | "json" }): Promise<{ folder: string; count: number }>;
  /** Sends a Local agent's Cloudroom bug report. `sent` is false while bug reports are off in Settings. */
  reportBug(input: { message: string; threadId?: string }): Promise<{ sent: boolean }>;
  /** The thread's read-only share link, or null when it is not shared. */
  /** `fresh`: read a Cloud thread's share from the website (when the share menu opens); otherwise the local copy. */
  threadShare(threadId: string, signal?: AbortSignal, fresh?: boolean): Promise<ThreadShare | null>;
  /** Shares the thread's messages (no tool output or files, secrets removed), or updates its shared copy. */
  shareThread(threadId: string): Promise<ThreadShare>;
  /** Turns the thread's share link off and deletes its shared copy. */
  stopSharingThread(threadId: string): Promise<void>;
  /** Copies a shared thread into a new Local thread that starts by reading it. */
  continueShare(link: string): Promise<{ threadId: string; projectId: string }>;
  /** The signed-in Cloudroom account, for Cloudroom Connect. `blocked` says why this Mac can't use Connect. */
  connectAccount(): Promise<{ accountId: string | null; blocked?: string }>;
  /** Registers this Mac with Cloudroom Connect on cloudroom.run and returns its tunnel credential. */
  connectRegister(): Promise<CloudroomConnectRegistration>;
}

export interface ThreadShare {
  url: string;
  updatedAt: string;
}

export interface RoomImportResult {
  imported: { bbThreadId: string; threadId: string; title: string }[];
  skipped: { bbThreadId: string; title: string; reason: string }[];
}

export interface NativeSession {
  harness: "claude-code" | "codex" | "pi" | "acp-hermes-agent" | "t3code" | "conductor";
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
}

export interface SessionImportResult {
  imported: { harness: NativeSession["harness"]; id: string; threadId: string; title: string }[];
  skipped: { harness: NativeSession["harness"]; id: string; title: string; reason: string }[];
}

export interface CloudroomThreadWorkspace {
  path: string;
  branch: string | null;
  head: string | null;
}

export function createCloudroomArea({ transport }: CreateSdkAreaArgs): CloudroomArea {
  const request = (path: string, body?: object, signal?: AbortSignal) => transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/account${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  return {
    claudeAuth: (input, signal) => transport.readJson(request(`/claude${input?.action ? `/${input.action}` : ""}`, input?.action ? { requestId: input.requestId, ...(input.action === "complete" ? { code: input.code, state: input.state } : {}), ...(input.action === "key" ? { apiKey: input.apiKey } : {}), ...(input.action === "token" ? { token: input.token, plan: input.plan, ...(input.follow ? { follow: true } : {}), ...(input.switched ? { switched: input.switched } : {}) } : {}) } : undefined, signal)) as Promise<CloudroomCodexAuth>,
    codexAccounts: (input, signal) => transport.readJson(request("/codex-accounts", input, signal)) as Promise<CodexAccountsResult>,
    cursorAuth: (signal) => transport.readJson(request("/cursor", undefined, signal)) as Promise<CloudroomCodexAuth>,
    cursorLogin: (requestId) => transport.readJson(request("/cursor/login", { requestId })) as Promise<CloudroomCodexAuth>,
    cancelCursorLogin: (requestId) => transport.readJson(request("/cursor/cancel", { requestId })) as Promise<CloudroomCodexAuth>,
    cursorApiKey: (requestId, apiKey) => transport.readJson(request("/cursor/key", { requestId, apiKey })) as Promise<CloudroomCodexAuth>,
    cursorAccount: (input) => transport.readJson(request("/cursor/account", input)) as Promise<CloudroomCodexAuth>,
    piApiKey: (provider, apiKey) => transport.readJson(request("/pi/key", { provider, apiKey })) as Promise<{ providers: string[] }>,
    codexAuth: (signal) => transport.readJson(request("/codex", undefined, signal)) as Promise<CloudroomCodexAuth>,
    codexLogin: (requestId) => transport.readJson(request("/codex/login", { requestId })) as Promise<CloudroomCodexAuth>,
    cancelCodexLogin: (requestId) => transport.readJson(request("/codex/cancel", { requestId })) as Promise<CloudroomCodexAuth>,
    githubAuth: (signal) => transport.readJson(request("/github", undefined, signal)) as Promise<CloudroomGithubAuth>,
    copyMacGithub: (expectedLogin) => transport.readJson(request("/github/mac", expectedLogin ? { expectedLogin } : {})) as Promise<CloudroomGithubAuth>,
    repoSuggestions: (signal) => transport.readJson(request("/repo-suggestions", undefined, signal)) as Promise<{ githubConnected: boolean; repos: RepoSuggestion[] }>,
    macRepoSuggestions: (signal) => transport.readJson(request("/repo-suggestions/mac", undefined, signal)) as Promise<{ repos: RepoSuggestion[] }>,
    gitlabConnection: (action,signal) => transport.readJson(request("/gitlab",{action},signal)) as Promise<GitlabConnection>,
    gitlabCheck: (repo,signal) => transport.readJson(request("/gitlab/check",{repo},signal)) as Promise<{accessible:boolean}>,
    addGitlabRepo: (input) => transport.readJson(request("/repo-suggestions/gitlab",input)) as Promise<{projectId:string}>,
    addGithubRepo: (input) => transport.readJson(request("/repo-suggestions/github", input)) as Promise<{ projectId: string }>,
    projectSuggestion: (input, signal) => transport.readJson(request("/project-suggestion", input, signal)) as Promise<{ projectId: string | null }>,
    promptSuggestion: (input, signal) => transport.readJson(request("/prompt-suggestion", input, signal)) as Promise<{ suggestion: string | null }>,
    promptSuggestionEvent: (input) => transport.readJson(request("/prompt-suggestion/event", input)) as Promise<{ ok: boolean }>,
    skillSuggestion: (input, signal) => transport.readJson(request("/skill-suggestion", input, signal)) as Promise<{ suggestion: { name: string; what: string; count: number; prompt: string } | null }>,
    skillSuggestionEvent: (input) => transport.readJson(request("/skill-suggestion/event", input)) as Promise<{ ok: boolean }>,
    searchRank: (input, signal) => transport.readJson(request("/search-rank", input, signal)) as Promise<{ probabilities: Record<string, number> | null; ranked: string[] }>,
    deepSearch: (input, signal) => transport.readJson(request("/deep-search", input, signal)) as Promise<{ threads: ThreadListEntry[] }>,
    projectBranches: (projectId, signal) => transport.readJson(request(`/project-branches?project=${encodeURIComponent(projectId)}`, undefined, signal)) as Promise<{defaultBranch:string|null;branches:string[]}>,
    githubBranches: (projectId, signal) => transport.readJson(request(`/github-branches?project=${encodeURIComponent(projectId)}`, undefined, signal)) as Promise<{ defaultBranch: string | null; branches: string[] }>,
    githubLogin: (requestId) => transport.readJson(request("/github/login", { requestId })) as Promise<CloudroomCodexAuth>,
    cancelGithubLogin: (requestId) => transport.readJson(request("/github/cancel", { requestId })) as Promise<CloudroomCodexAuth>,
    githubAccount: (signal) => transport.readJson(request("/github/account", undefined, signal)) as Promise<CloudroomGithubAccount | null>,
    disconnectGithub: () => transport.readVoid(request("/github/disconnect", {})),
    disconnectAgent: (providerId, input = {}) => transport.readVoid(request(`/agents/${encodeURIComponent(providerId)}/disconnect`, input)),
    restoreAgent: (providerId) => transport.readVoid(request(`/agents/${encodeURIComponent(providerId)}/restore`, {})),
    checkPreviews: () => transport.readVoid(request("/previews/check", {})),
    status: (signal) => transport.readJson(request("", undefined, signal)) as Promise<CloudroomStatus>,
    signIn: (input = {}) => transport.readJson(request("/sign-in", input)) as Promise<{ url: string }>,
    connect: (input) => transport.readVoid(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })),
    cancel: () => transport.readVoid(request("/cancel", {})),
    setMacAccess: (access) => transport.readVoid(request("/mac-access", typeof access === "boolean" ? { enabled: access } : { level: access })),
    setCopyLogins: (enabled) => transport.readVoid(request("/copy-logins", { enabled })),
    copyLoginsNow: () => transport.readVoid(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/mac/logins`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })),
    setDeepapi: (enabled) => transport.readVoid(request("/deepapi", { enabled })),
    environment: (signal) => transport.readJson(request("/environment", undefined, signal)) as Promise<CloudEnvironment>,
    updateEnvironment: (change) => transport.readJson(request("/environment", change)) as Promise<CloudEnvironment>,
    autoDelete: (signal) => transport.readJson(request("/auto-delete", undefined, signal)) as Promise<AutoDeleteSetting>,
    vps: (signal) => transport.readJson(request("/vps", undefined, signal)) as Promise<CloudVps>,
    vpsAction: (input) => transport.readJson(request("/vps", input)) as Promise<CloudVps | { code: string; expiresAt: number; command: string } | { ok: true }>,
    automations: (input) => transport.readJson(request("/automations", input)) as Promise<CloudAutomationResponse>,
    tokenUsage: (input) => transport.readJson(request("/token-usage", input)) as Promise<TokenUsageResponse>,
    snippets: (input) => transport.readJson(request("/snippets", input)),
    org: (input) => transport.readJson(request("/org", input)),
    projectShares: (input) => transport.readJson(request("/project-shares", input)),
    gpu: (input) => transport.readJson(request("/gpu", input)),
    inference: () => transport.readJson(request("/inference", {})),
    setAutoDelete: (days) => transport.readJson(request("/auto-delete", { days })) as Promise<AutoDeleteSetting>,
    macVariables: (signal) => transport.readJson(request("/environment/mac", undefined, signal)) as Promise<{ names: string[] }>,
    importMacVariables: (names) => transport.readJson(request("/environment/mac", { names })) as Promise<CloudEnvironment>,
    cloudSkills: (signal) => transport.readJson(request("/skills", undefined, signal)) as Promise<CloudSkills>,
    setCloudSkills: (change) => transport.readJson(request("/skills", change)) as Promise<CloudSkills>,
    macClis: (signal) => transport.readJson(request("/clis", undefined, signal)) as Promise<{ clis: MacCli[] }>,
    macMcpServers: (signal) => transport.readJson(request("/mcp", undefined, signal)) as Promise<{ servers: MacMcpServer[] }>,
    setCloudMcp: (change) => transport.readJson(request("/mcp", change)) as Promise<CloudEnvironment>,
    startMcpSignIn: (name) => transport.readJson(request("/mcp/sign-in", { name })) as Promise<{ url: string }>,
    runOnVm: (input) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/vm/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })) as Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean }>,
    logout: () => transport.readVoid(request("/logout", {})),
    threadStatus: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}`, { signal })) as Promise<CloudroomThreadStatus | null>,
    threadCredits: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/credits`, { signal })) as Promise<CloudroomThreadCredits>,
    threadWorkspace: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/workspace`, { signal })) as Promise<CloudroomThreadWorkspace | null>,
    teleport: (threadId, action = "start", choice) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...choice }) })) as Promise<TeleportProgress>,
    teleportCheck: (threadId, choice) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "check", ...choice }) })) as Promise<{ model: string; reasoning: string; warnings: string[] }>,
    teleportStatus: (threadId, signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { signal })) as Promise<TeleportProgress | null>,
    teleportLocal: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "local" }) })) as Promise<{ conflicts: number }>,
    moveToSandbox: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "move" }) })) as Promise<TeleportProgress>,
    copyToMac: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/teleport`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "copy" }) })) as Promise<{ branch: string }>,
    openCloudFile: (threadId, path) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/open-file`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) })) as Promise<{ path: string }>,
    importBb: (hostId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/import/bb`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostId }) })) as Promise<RoomImportResult>,
    nativeSessions: (signal, claudeConfigDir) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/import/sessions${claudeConfigDir ? `?claudeConfigDir=${encodeURIComponent(claudeConfigDir)}` : ""}`, { signal })) as Promise<{ sessions: NativeSession[]; conductorApp?: boolean }>,
    importSessions: (hostId, sessions, claudeConfigDir) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/import/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostId, sessions, claudeConfigDir }) })) as Promise<SessionImportResult>,
    conductorExport: (path) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/import/conductor-export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) })) as Promise<{ sessions: NativeSession[] }>,
    importConductorExport: (hostId, path) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/import/conductor-export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostId, path }) })) as Promise<SessionImportResult>,
    exportableChats: (signal) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/export`, { signal })) as Promise<{ threads: { target: "local" | "cloud"; updatedAt: number }[] }>,
    exportChats: (input) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })) as Promise<{ folder: string; count: number }>,
    reportBug: (input) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/bug-reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })) as Promise<{ sent: boolean }>,
    retryCopy: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/retry-copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })) as Promise<{ status?: "cloning" | "copied" | "folder_not_empty" }>,
    continueFromCopy: (threadId) => transport.readVoid(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/from-copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })),
    threadShare: (threadId, signal, fresh) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/share${fresh ? "?fresh=1" : ""}`, { signal })) as Promise<ThreadShare | null>,
    shareThread: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save" }) })) as Promise<ThreadShare>,
    stopSharingThread: (threadId) => transport.readVoid(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop" }) })),
    continueShare: (link) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/shares/continue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link }) })) as Promise<{ threadId: string; projectId: string }>,
    connectAccount: () => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/connect`)) as Promise<{ accountId: string | null; blocked?: string }>,
    connectRegister: () => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })) as Promise<CloudroomConnectRegistration>,
    retryStart: (threadId) => transport.readVoid(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/retry-start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })),
    clearDisk: (threadId) => transport.readJson(transport.fetch(`${transport.baseUrl}/api/v1/cloudroom/threads/${encodeURIComponent(threadId)}/clear-disk`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })) as Promise<{ freedBytes: number }>,
  };
}
