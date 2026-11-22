import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { cloudroomCommands, cloudroomThreads } from "@cloudroom/db";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import { ApiError } from "../../errors.js";
import { CloudroomClient, CloudroomError } from "./client.js";
import { checkPreviewsNow, helperRunning, macAccess, macAccessSupported, previewStatus, previewsSetUp, setupPreviews } from "./previews.js";
import { refreshProjectRemote } from "./project-copy.js";
import { HOSTED_WEBSITE, publicError, type Capabilities, type CloudroomAccount, type Storage } from "./protocol.js";
import type { CloudRuntime } from "./runtime.js";
import { sandboxThread, type SandboxTrigger } from "./sandboxes.js";
import { reportMacHelperDown, reportMacHelperProblem } from "./setup-telemetry.js";
import { bindings } from "./store.js";
import { syncStatus } from "./sync.js";
import { markMinutesSent, unsentMinutes } from "./time-in-app.js";

export interface StatusPreviewHooks {
  syncLogins: () => Promise<void>;
  uploadMacConfig: () => Promise<void>;
}

/** Manages Cloud status snapshots, sandbox warming, onboarding milestones, Mac access reporting, and previews. */
export class CloudStatusPreviews {
  syncIssue: string | null = null;
  private previewIssue: string | null = null;
  private previewSetupEpoch = -1;
  private previewRetryAt = 0;
  private previewFailures = 0;
  private onboardingDue = 0;
  private reportingOnboarding = false;
  private activityAt = 0;
  private active = { day: "", at: 0 };
  private macReports = new Map<string, { report: string; at: number }>();
  private macReportDue = 0;
  private macCheckDue = 0;

  constructor(private readonly rt: CloudRuntime, private readonly hooks: StatusPreviewHooks) {}

  resetOnStop(): void {
    this.previewRetryAt = 0;
    this.previewFailures = 0;
    this.previewIssue = null;
  }

  onWakeNoted(): void { this.macReportDue = 0; }
  /** Check now: a helper that couldn't start tries again at the next status check, not after its wait. */
  retryPreviews(): void { this.previewRetryAt = 0; }
  resetOnboardingDue(): void { this.onboardingDue = 0; }

  /** The project of the newest cloud thread from the last 7 days, if any. */
  private recentCloudProject(): string | undefined {
    const recent = bindings(this.rt.host.db)
      .filter((saved) => sandboxThread(saved.coreUrl))
      .map((saved) => this.rt.host.getThread(saved.threadId))
      .filter((thread) => thread && !thread.archivedAt && !thread.deletedAt)
      .sort((a, b) => b!.createdAt - a!.createdAt)[0];
    return recent && Date.now() - recent.createdAt < 7 * 86_400_000 ? recent.projectId : undefined;
  }

  async warmRecentProject(): Promise<void> {
    const project = this.recentCloudProject();
    if (project) await this.warmSandbox(project, "app_launch");
  }

  async warmSandbox(projectId: string, trigger: SandboxTrigger = "composer"): Promise<void> {
    if (!await this.rt.newThreadsInSandboxes()) return;
    await this.hooks.syncLogins();
    void this.hooks.uploadMacConfig();
    await refreshProjectRemote(this.rt.host.deps, projectId).catch(() => {});
    await this.rt.sandboxes.warm(this.rt.sandboxProject(projectId), trigger);
  }

  /** Any app use, Local threads included, keeps the spares warm, so no cloud thread boots (ADRs 0159, 0164). */
  async noteActivity(): Promise<void> {
    if (Date.now() - this.activityAt < 30_000) return;
    this.activityAt = Date.now();
    await this.warmSandbox(this.recentCloudProject() ?? PERSONAL_PROJECT_ID, "app_activity");
  }

  /** Reports once per UTC day that this account sent a message, Local or Cloud, with past days' active minutes. Failures retry after 10 minutes. */
  noteActiveDay(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (this.active.day === day || Date.now() - this.active.at < 600_000) return;
    this.active.at = Date.now();
    void (async () => {
      const minutes = await unsentMinutes(this.rt.host.deps);
      const saved = await this.rt.sandboxes.active(minutes);
      this.active.day = day;
      await markMinutesSent(this.rt.host.deps, saved ? minutes : {});
    })().catch(() => {});
  }

  async selectOnboardingProject(projectId: string): Promise<void> {
    if (!this.rt.host.getProject(projectId)) throw new ApiError(404, "project_not_found", "Project not found");
    await this.rt.changeConnection(async () => {
      const saved = await this.rt.savedConnection();
      if (!saved?.account || !saved.token || saved.onboarding?.projectSelected) return;
      await this.rt.saveConnection({ ...saved, onboarding: { ...saved.onboarding, projectSelected: true } });
    });
    this.onboardingDue = 0;
    void this.reportOnboarding();
  }

  async rememberCloudMessage(sessionId: string, requestId: string, epoch: number): Promise<void> {
    await this.rt.changeConnection(async () => {
      const saved = await this.rt.savedConnection();
      if (!saved?.account || !saved.token || saved.onboarding?.firstMessage || this.rt.epoch !== epoch) return;
      await this.rt.saveConnection({ ...saved, onboarding: { ...saved.onboarding, projectSelected: true, firstMessage: { sessionId, requestId } } });
    });
    this.onboardingDue = 0;
    void this.reportOnboarding();
  }

  async reportOnboarding(): Promise<void> {
    if (this.rt.stopped || this.reportingOnboarding || Date.now() < this.onboardingDue) return;
    this.reportingOnboarding = true;
    this.onboardingDue = Date.now() + 30_000;
    const epoch = this.rt.epoch;
    try {
      const saved = await this.rt.savedConnection();
      if (!saved?.account || !saved.token || !saved.url) return;
      const reported = saved.onboarding?.reported ?? [];
      if (reported.length === 3) return;
      const website = saved.websiteUrl ?? (saved.url.startsWith("https:") ? HOSTED_WEBSITE : null);
      if (!website) return;
      const projectSelected = saved.onboarding?.projectSelected || bindings(this.rt.host.db).some((item) => item.coreUrl === saved.url);
      const first = saved.onboarding?.firstMessage ?? this.rt.host.db.select({ sessionId: cloudroomThreads.sessionId, requestId: cloudroomCommands.id })
        .from(cloudroomCommands).innerJoin(cloudroomThreads, eq(cloudroomThreads.threadId, cloudroomCommands.threadId))
        .where(and(eq(cloudroomThreads.coreUrl, saved.url), eq(cloudroomCommands.command, "prompt"), inArray(cloudroomCommands.state, ["accepted", "completed"]))).limit(1).get();
      const milestones = ["connected", ...(projectSelected ? ["project"] : []), ...(first?.sessionId ? ["message"] : [])] as ("connected" | "project" | "message")[];
      if (milestones.every((item) => reported.includes(item))) return;
      if (!reported.includes("connected")) await (await this.rt.client()).ready();
      if (this.rt.stopped || epoch !== this.rt.epoch) return;
      const response = await fetch(`${website}/api/desktop/onboarding`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${saved.account.id}:${saved.token}`).toString("base64")}` },
        body: JSON.stringify({ connected: true, projectSelected: Boolean(projectSelected), ...(first?.sessionId ? { firstMessage: first } : {}) }),
      });
      if (!response.ok) { await response.body?.cancel(); return; }
      const confirmed = z.object({
        macConnectedAt: z.string().datetime({ offset: true }),
        projectSelectedAt: z.string().datetime({ offset: true }).nullable(),
        firstMessageAt: z.string().datetime({ offset: true }).nullable(),
      }).parse(await response.json());
      if (this.rt.stopped || epoch !== this.rt.epoch) return;
      await this.rt.changeConnection(async () => {
        const current = await this.rt.savedConnection();
        if (!current?.token || current.token !== saved.token || current.account?.id !== saved.account!.id || epoch !== this.rt.epoch) return;
        await this.rt.saveConnection({
          ...current,
          onboarding: {
            ...current.onboarding,
            reported: ["connected", ...(confirmed.projectSelectedAt ? ["project"] : []), ...(confirmed.firstMessageAt ? ["message"] : [])],
          },
        });
      });
    } catch {
    } finally { this.reportingOnboarding = false; }
  }

  private async previews() {
    const { detail, ...status } = await previewStatus(this.rt.host.deps);
    if (status.state === "offline" && detail) reportMacHelperProblem(detail);
    return { ...status, explained: Boolean(detail), issue: this.previewIssue };
  }

  async reportMacAccess(): Promise<void> {
    if (Date.now() < this.macReportDue) return;
    this.macReportDue = Date.now() + 15_000;
    const sandboxes = this.rt.sandboxes.awakeSandboxes().filter(({ thread }) => this.rt.host.getThread(thread));
    if (!sandboxes.length) return this.macReports.clear();
    const status = await previewStatus(this.rt.host.deps, 60_000);
    const problem = status.state === "offline" && status.detail ? status.message : null;
    // Windows hides Mac access: "off" keeps older Cores' answer, `unsupported` tells newer ones there is no setting (#871).
    const report = macAccessSupported ? { access: await macAccess(this.rt.host.deps) ?? "off", problem } : { access: "off", problem, unsupported: true };
    const key = JSON.stringify(report), sent = this.macReports;
    this.macReports = new Map();
    for (const { url, token } of sandboxes) {
      const id = `${url} ${token}`, last = sent.get(id);
      if (last && (last.at === Infinity || (last.report === key && Date.now() - last.at < 60_000))) { this.macReports.set(id, last); continue; }
      this.macReports.set(id, { report: key, at: Date.now() });
      void new CloudroomClient({ url, token, timeoutMs: 5000 }).reportMac(report).then((check) => {
        // An agent there couldn't reach this Mac: check now, as `room-cli cloud check` does, at most once a minute (#608).
        if (!check || Date.now() < this.macCheckDue) return;
        this.macCheckDue = Date.now() + 60_000;
        void checkPreviewsNow(this.rt.host.deps).catch(() => {});
      }, (error: unknown) => {
        if (error instanceof CloudroomError && (error.status === 404 || error.status === 409)) this.macReports.set(id, { report: key, at: Infinity });
      });
    }
  }

  /** A new Mac access level reaches the helper in the background, queued like every other setup so two never overlap.
   *  Saving it never waits on the helper or fails because of it; Settings shows why the helper can't start (#109). */
  applyMacAccess(): void {
    const epoch = this.rt.epoch;
    void this.rt.changeConnection(async () => {
      if (this.rt.stopped || epoch !== this.rt.epoch || !await previewsSetUp(this.rt.host.deps)) return;
      await setupPreviews(this.rt.host.deps);
      if (epoch === this.rt.epoch) { this.previewIssue = null; this.previewFailures = 0; }
    }).catch((error: unknown) => { if (epoch === this.rt.epoch) this.previewIssue = publicError(error); });
  }

  ensurePreviews(capabilities: Capabilities): Promise<void> | undefined {
    if (!capabilities.previews || this.rt.stopped || this.previewSetupEpoch === this.rt.epoch || Date.now() < this.previewRetryAt) return;
    const epoch = this.rt.epoch;
    this.previewSetupEpoch = epoch;
    this.previewRetryAt = Date.now() + 30_000;
    return this.rt.changeConnection(async () => {
      if (this.rt.stopped || epoch !== this.rt.epoch) return;
      await setupPreviews(this.rt.host.deps);
      if (epoch === this.rt.epoch) { this.previewIssue = null; this.previewFailures = 0; }
    }).catch(async (error: unknown) => {
      if (epoch !== this.rt.epoch) return;
      // Retry after 1, 2, 4, then every 5 minutes: a helper that can't start never restarts in a tight loop (#109).
      this.previewRetryAt = Date.now() + Math.min(30_000 * 2 ** ++this.previewFailures, 300_000);
      this.previewIssue = publicError(error);
      // Twice in a row, so a slow start at login never counts.
      const level = macAccessSupported ? await macAccess(this.rt.host.deps).catch(() => null) : null;
      if (this.previewFailures >= 2 && level && level !== "off" && !await helperRunning(this.rt.host.deps)) reportMacHelperDown(this.previewIssue);
    }).finally(() => { if (this.previewSetupEpoch === epoch) this.previewSetupEpoch = -1; });
  }

  async status() {
    const lastCloudAt = this.rt.host.lastCloudUpdatedAt();
    const recentThreads = await this.rt.host.recentThreads();
    let account: CloudroomAccount | null = null;
    let projectId: string | null = null;
    let storage: Storage | null = null;
    // A core connected by URL and token, with no Cloudroom account: the user hosts it (docs/cloudroom.md).
    let selfHosted = false;
    let signedOut = false;
    try {
      const saved = await this.rt.savedConnection();
      signedOut = !saved?.account || !(saved.token || saved.sandboxToken);
      account = saved?.token ? saved.account ?? null : null;
      selfHosted = Boolean(saved?.token && !saved.account);
      projectId = saved?.projectId ?? null;
      if (saved?.sandboxToken && saved.account && await this.rt.newThreadsInSandboxes()) {
        // Without a VM, nothing above asked the website's mode, which carries the plan and queue (#864): ask in the
        // background, at most once a minute, so status never waits on it.
        if (!saved.token) this.rt.sandboxes.usageLimited();
        // New threads start in sandboxes, which sleep between tasks; report their latest capabilities, never a VM's.
        // Null harnesses mean unknown: the composer then lets the sandbox decide instead of blocking.
        // Nothing to learn while in the cloud queue: no sandbox runs, so skip the website call.
        if (!this.rt.sandboxes.cloudQueue()) void this.rt.learnSandboxCapabilities().catch(() => {});
        const capabilities = await this.rt.savedCapabilities();
        // The preview helper reaches every awake sandbox through the website (docs/scopes/sandboxes.md).
        if (capabilities) void this.ensurePreviews(capabilities);
        return {
          ready: true, account: saved.account, projectId, storage: null, harnesses: capabilities?.harnesses ?? null, sync: null,
          previews: capabilities?.previews ? await this.previews() : null,
          workspaces: true, teleport: capabilities?.teleport ?? false, repository: null,
          model: capabilities?.harnesses.find((h) => h.id === "codex")?.model ?? null,
          steer: capabilities?.steer ?? false, rewind: capabilities?.rewind ?? false, attachments: capabilities?.attachments ?? false,
          compact: capabilities?.compact ?? false, queue_edit: capabilities?.queue_edit ?? false, queue_cancel: capabilities?.queue_cancel ?? false,
          queue_reorder: capabilities?.queue_reorder ?? false, error: null, cloudQueue: this.rt.sandboxes.cloudQueue(), cloudPaused: this.rt.sandboxes.cloudPaused(), usedCloud: lastCloudAt !== null, lastCloudAt, recentThreads,
          plan: this.rt.sandboxes.currentPlan(), planUsage: this.rt.sandboxes.planUsage(), deepapi: this.rt.sandboxes.deepapiState(),
        };
      }
      const connection = await this.rt.connection();
      const client = new CloudroomClient({ ...connection, timeoutMs: 5000 });
      storage = await this.rt.storage(client);
      const capabilities = await this.rt.capabilities(client, storage);
      this.rt.lastCapabilities = capabilities;
      await client.ready();
      void this.ensurePreviews(capabilities);
      return {
        ready: true, account, signedOut, selfHosted, projectId, storage, harnesses: capabilities.harnesses,
        sync: capabilities.sync ? { ...await syncStatus(this.rt.host.deps), issue: this.syncIssue } : null,
        previews: capabilities.previews ? await this.previews() : null,
        workspaces: capabilities.workspaces, teleport: capabilities.teleport, repository: capabilities.repository,
        model: capabilities.harnesses.find((h) => h.id === "codex")?.model ?? null,
        steer: capabilities.steer, rewind: capabilities.rewind, attachments: capabilities.attachments,
        compact: capabilities.compact, queue_edit: capabilities.queue_edit, queue_cancel: capabilities.queue_cancel,
        queue_reorder: capabilities.queue_reorder, error: null, usedCloud: lastCloudAt !== null, lastCloudAt, recentThreads,
      };
    } catch (error) {
      return { ready: false, account, signedOut, selfHosted, projectId, storage, workspaces: false, repository: null, model: null, error: publicError(error) };
    }
  }
}
