// Thin Cloudroom service facade wiring the modular Cloudroom engine:
//   host-bridge.ts -> protocol.ts -> runtime.ts ->
//   {account-auth, status-previews, transfers, children, lifecycle, queue, messaging, stream, delivery}.ts
import type { DbConnection, DbTransaction } from "@cloudroom/db";
import type { PromptInput, ReasoningLevel, Thread } from "@cloudroom/domain";
import type { CreateThreadRequest, EditMessageRequest, ForkThreadRequest, SendMessageRequest } from "@cloudroom/server-contract";
import type { AppDeps } from "../../types.js";
import { CloudAccountAuth } from "./account-auth.js";
import { CloudChildren } from "./children.js";
import type { CloudroomClient, VmRun } from "./client.js";
import { CloudDelivery } from "./delivery.js";
import { CloudHostBridge, importedThreadIds, type CloudHostDeps } from "./host-bridge.js";
import { CloudLifecycle } from "./lifecycle.js";
import { CloudMessaging } from "./messaging.js";
import type { ProjectCopyJob } from "./project-copy.js";
import {
  cloudPromptLimit,
  configuredWebsite,
  HOSTED_WEBSITE,
  isCloudThread,
  promptPayload,
  requireNativeThread,
  trustedWebsite,
  type CloudroomAccount,
} from "./protocol.js";
import { CloudQueue } from "./queue.js";
import { CloudRuntime } from "./runtime.js";
import { sandboxThread, type SandboxTrigger, type SandboxWakeTrigger } from "./sandboxes.js";
import { CloudStatusPreviews } from "./status-previews.js";
import { binding, type Binding } from "./store.js";
import { CloudStream } from "./stream.js";
import { CloudTransfers } from "./transfers.js";

export {
  cloudPromptLimit,
  configuredWebsite,
  HOSTED_WEBSITE,
  importedThreadIds,
  isCloudThread,
  promptPayload,
  requireNativeThread,
  trustedWebsite,
  type CloudroomAccount,
};

const services = new WeakMap<DbConnection, CloudroomService>();

export function cloudroom(deps: CloudHostDeps): CloudroomService {
  let service = services.get(deps.db);
  if (!service) { service = new CloudroomService(deps); services.set(deps.db, service); }
  return service;
}

/** Where a cloud thread runs, for usage events: its own sandbox or the older shared VM. */
export function cloudExecution(deps: Pick<AppDeps, "db">, threadId: string): "cloud_sandbox" | "cloud_vm" {
  return sandboxThread(binding(deps.db, threadId)?.coreUrl ?? "") ? "cloud_sandbox" : "cloud_vm";
}

class CloudroomService {
  private readonly host: CloudHostBridge;
  private readonly rt: CloudRuntime;
  private readonly auth: CloudAccountAuth;
  private readonly statusPreviews: CloudStatusPreviews;
  private readonly transfers: CloudTransfers;
  private readonly children: CloudChildren;
  private readonly lifecycle: CloudLifecycle;
  private readonly queueEngine: CloudQueue;
  private readonly messaging: CloudMessaging;
  private readonly stream: CloudStream;
  private readonly delivery: CloudDelivery;

  readonly gpuApprovals: CloudRuntime["gpuApprovals"];
  readonly sandboxes: CloudRuntime["sandboxes"];
  readonly codexAccounts: CloudRuntime["codexAccounts"];
  readonly threadStates: CloudRuntime["threadStates"];
  readonly sync: CloudRuntime["sync"];

  constructor(deps: CloudHostDeps) {
    this.host = new CloudHostBridge(deps);
    this.rt = new CloudRuntime(this.host);
    this.gpuApprovals = this.rt.gpuApprovals;
    this.sandboxes = this.rt.sandboxes;
    this.codexAccounts = this.rt.codexAccounts;
    this.threadStates = this.rt.threadStates;
    this.sync = this.rt.sync;

    this.auth = new CloudAccountAuth(this.rt, {
      start: () => this.delivery.start(),
      stop: () => this.delivery.stop(),
      retryStart: (threadId) => this.messaging.retryStart(threadId),
    });
    this.statusPreviews = new CloudStatusPreviews(this.rt, {
      syncLogins: () => this.auth.syncLogins(),
      uploadMacConfig: () => this.auth.uploadMacConfig(),
    });
    this.transfers = new CloudTransfers(this.rt, {
      deliver: (threadId) => this.delivery.deliver(threadId),
      progress: (threadId, steps, block) => this.messaging.progress(threadId, steps, block),
    });
    this.children = new CloudChildren(this.rt, {
      deliver: (threadId) => this.delivery.deliver(threadId),
      follow: (saved, client) => this.stream.follow(saved, client),
      create: (request, awaitingCore) => this.messaging.create(request, awaitingCore),
      enqueue: (threadId, id, action, input, at) => this.queueEngine.enqueue(threadId, id, action, input, at),
      currentReasoning: (threadId, saved) => this.queueEngine.currentReasoning(threadId, saved),
    });
    this.lifecycle = new CloudLifecycle(this.rt, this.children, this.transfers, {
      start: () => this.delivery.start(),
      deliver: (threadId) => this.delivery.deliver(threadId),
      follow: (saved, client) => this.stream.follow(saved, client),
      readHistory: (threadId, again) => this.stream.readHistory(threadId, again),
      enqueue: (threadId, id, action, input, at) => this.queueEngine.enqueue(threadId, id, action, input, at),
      currentReasoning: (threadId, saved) => this.queueEngine.currentReasoning(threadId, saved),
      keyFields: (source) => this.messaging.keyFields(source),
      copyPiSetup: (client, sandbox) => this.auth.copyPiSetup(client, sandbox),
    });
    this.queueEngine = new CloudQueue(this.rt, {
      deliver: (threadId) => this.delivery.deliver(threadId),
      send: (thread, payload) => this.messaging.send(thread, payload),
      control: (threadId, action, offline) => this.messaging.control(threadId, action, offline),
    });
    this.messaging = new CloudMessaging(this.rt, this.auth, this.statusPreviews, this.children, this.lifecycle, this.queueEngine, {
      start: () => this.delivery.start(),
      deliver: (threadId) => this.delivery.deliver(threadId),
      deliverWhenAwake: (threadId) => this.delivery.deliverWhenAwake(threadId),
      asleep: (threadId) => this.stream.asleep(threadId),
    });
    this.stream = new CloudStream(this.rt, this.transfers, this.children, {
      currentUserArchive: (saved, client, sessionId, signal) => this.lifecycle.currentUserArchive(saved, client, sessionId, signal),
    });
    this.delivery = new CloudDelivery(this.rt, this.auth, this.statusPreviews, this.transfers, this.children, this.lifecycle, this.queueEngine, this.messaging, this.stream);

    this.rt.hooks.beforeWake = () => this.auth.beforeWake();
    this.rt.hooks.onWakeNoted = () => this.statusPreviews.onWakeNoted();
    this.rt.hooks.adoptRun = (run) => this.children.adoptRun(run);
    this.rt.hooks.disconnectRefused = (token) => this.auth.disconnect(token);
    this.rt.hooks.restartAwake = (providerId) => this.auth.restartAwake(providerId);
    this.rt.hooks.syncLabel = (threadId, change, tries, resend) => this.children.syncLabel(threadId, change, tries, resend);
    this.rt.hooks.renameShared = (threadId) => this.children.renameShared(threadId);
    this.rt.hooks.queueSnapshot = (threadId) => this.queueEngine.queue(threadId);
    this.rt.hooks.measureDisk = (threadId, client) => this.stream.measureDisk(threadId, client);
    this.rt.hooks.restore = (threadId, retry) => this.lifecycle.restore(threadId, retry);
  }

  get teleportRecovery() { return this.host.hooks.teleportRecovery; }
  set teleportRecovery(fn) { this.host.hooks.teleportRecovery = fn; }
  get archiveRequest() { return this.host.hooks.archiveRequest; }
  set archiveRequest(fn) { this.host.hooks.archiveRequest = fn; }
  get childTurnEnded() { return this.host.hooks.childTurnEnded; }
  set childTurnEnded(fn) { this.host.hooks.childTurnEnded = fn; }
  get moveRequest() { return this.host.hooks.moveRequest; }
  set moveRequest(fn) { this.host.hooks.moveRequest = fn; }

  // Runtime & connections
  me() { return this.rt.me(); }
  quietly<T>(threadId: string | null, apply: () => T) { return this.rt.quietly(threadId, apply); }
  adopted(threadId: string, awake: boolean) { this.rt.adopted(threadId, awake); }
  resendLabel(threadId: string, change: string) { this.rt.resendLabel(threadId, change); }
  isHome(threadId: string, depth?: number) { return this.rt.isHome(threadId, depth); }
  detach(threadId: string) { this.rt.detach(threadId); }
  newThreadsInSandboxes() { return this.rt.newThreadsInSandboxes(); }
  threadClient(threadId: string, wake?: boolean, trigger?: SandboxWakeTrigger) { return this.rt.threadClient(threadId, wake, trigger); }
  terminalConnection(threadId: string) { return this.rt.terminalConnection(threadId); }
  requireOwnThread(saved: Binding) { return this.rt.requireOwnThread(saved); }
  threadOwnerCheck() { return this.rt.threadOwnerCheck(); }
  clearDisk(threadId: string) { return this.rt.clearDisk(threadId); }
  runOnVm(input: VmRun, threadId?: string, signal?: AbortSignal) { return this.rt.runOnVm(input, threadId, signal); }
  threadWorkspace(threadId: string, signal?: AbortSignal) { return this.rt.threadWorkspace(threadId, signal); }
  runInCheckout(threadId: string, script: string, stdin?: Buffer, signal?: AbortSignal) { return this.rt.runInCheckout(threadId, script, stdin, signal); }
  wakeAhead(threadId: string, trigger: SandboxWakeTrigger) { return this.rt.wakeAhead(threadId, trigger); }
  preload(threadIds: string[]) { return this.rt.preload(threadIds); }

  // Account & logins
  configure(raw: unknown, account?: CloudroomAccount, signal?: AbortSignal, websiteUrl?: string, sandboxToken?: string) { return this.auth.configure(raw, account, signal, websiteUrl, sandboxToken); }
  disconnect(refused?: string) { return this.auth.disconnect(refused); }
  copyLoginsNow() { return this.auth.copyLoginsNow(); }
  claudeAuth(action?: "login" | "cancel" | "complete" | "token" | "key", requestId?: string, code?: string, state?: string, follow?: boolean, owner?: string | null) { return this.auth.claudeAuth(action, requestId, code, state, follow, owner); }
  antigravityLogin(input: Record<string, unknown>) { return this.auth.antigravityLogin(input); }
  restartAwake(providerId: "claude-code" | "codex") { this.auth.restartAwake(providerId); }
  cloudLogins() { return this.auth.cloudLogins(); }
  loginOwner() { return this.auth.loginOwner(); }
  cursorAuth(action?: "login" | "cancel" | "key", requestId?: string, apiKey?: string) { return this.auth.cursorAuth(action, requestId, apiKey); }
  cursorAccount(requestId: string, apiKey: string | null) { return this.auth.cursorAccount(requestId, apiKey); }
  piApiKey(provider: string, apiKey: string) { return this.auth.piApiKey(provider, apiKey); }
  codexAuth(action?: "login" | "cancel", requestId?: string) { return this.auth.codexAuth(action, requestId); }

  // Status, warming, onboarding & previews
  status() { return this.statusPreviews.status(); }
  warmSandbox(projectId: string, trigger?: SandboxTrigger) { return this.statusPreviews.warmSandbox(projectId, trigger); }
  noteActivity() { return this.statusPreviews.noteActivity(); }
  noteActiveDay() { this.statusPreviews.noteActiveDay(); }
  selectOnboardingProject(projectId: string) { return this.statusPreviews.selectOnboardingProject(projectId); }
  retryPreviews() { this.statusPreviews.retryPreviews(); }
  applyMacAccess() { this.statusPreviews.applyMacAccess(); }

  // Transfers & Teleport
  teleportUrl(threadId: string) { return this.transfers.teleportUrl(threadId); }
  forgetTeleportSandbox(threadId: string, error: unknown) { return this.transfers.forgetTeleportSandbox(threadId, error); }
  teleportClient(threadId?: string, trigger?: SandboxWakeTrigger) { return this.transfers.teleportClient(threadId, trigger); }
  followTeleport(threadId: string) { this.transfers.followTeleport(threadId); }
  freezeForTeleport(threadId: string, client: CloudroomClient, session: string) { return this.transfers.freezeForTeleport(threadId, client, session); }
  continueFromCopy(threadId: string) { return this.transfers.continueFromCopy(threadId); }
  moveToCloud(threadId: string) { return this.transfers.moveToCloud(threadId); }
  retryCopy(threadId: string) { return this.transfers.retryCopy(threadId); }
  copyInto(client: CloudroomClient, job: ProjectCopyJob, done?: () => void) { this.transfers.copyInto(client, job, done); }
  resumeCopy(threadId: string, client: CloudroomClient) { this.transfers.resumeCopy(threadId, client); }

  // Children & parent links
  changeParent(threadId: string, parent: string | null, apply: () => Promise<void>) { return this.children.changeParent(threadId, parent, apply); }

  // Lifecycle (archive, restore, delete, side chat, harness switch, project move)
  archived(threadId: string) { this.lifecycle.archived(threadId); }
  archive(threadId: string) { this.lifecycle.archive(threadId); }
  runningInCloud(threadIds: string[], signal: AbortSignal) { return this.lifecycle.runningInCloud(threadIds, signal); }
  archiveInTurn(threadIds: string[]) { this.lifecycle.archiveInTurn(threadIds); }
  pauseProjectLoops(projectId: string) { return this.lifecycle.pauseProjectLoops(projectId); }
  remove(threadId: string) { this.lifecycle.remove(threadId); }
  restore(threadId: string, retry?: boolean) { return this.lifecycle.restore(threadId, retry); }
  restoredSince(threadId: string, at: number) { return this.rt.restoredSince(threadId, at); }
  sideChat(source: Thread, request: ForkThreadRequest) { return this.lifecycle.sideChat(source, request); }
  switchHarness(thread: Thread, target: { providerId: string; model: string; reasoningLevel: ReasoningLevel | null }, prepare: (seed: boolean) => Promise<(tx: DbTransaction) => void>) { return this.lifecycle.switchHarness(thread, target, prepare); }
  moveProject(thread: Thread, projectId: string, prepare: (seed: boolean) => Promise<(tx: DbTransaction) => void>) { return this.lifecycle.moveProject(thread, projectId, prepare); }

  // Messaging, queue & controls
  create(request: CreateThreadRequest, awaitingCore?: boolean, fork?: { sourceThreadId: string; endSequence: number }) { return this.messaging.create(request, awaitingCore, fork); }
  keyList(threadId: string) { return this.messaging.keyList(threadId); }
  threadStatus(threadId: string) { return this.messaging.threadStatus(threadId); }
  updateReasoningOverride(thread: Thread, reasoningLevel: ReasoningLevel | null) { return this.messaging.updateReasoningOverride(thread, reasoningLevel); }
  changeModel(thread: Thread, model: string, reasoningLevel: ReasoningLevel | null, checkIdleSession?: () => void) { return this.messaging.changeModel(thread, model, reasoningLevel, checkIdleSession); }
  messageDelivery(threadId: string, rawId: string) { return this.messaging.messageDelivery(threadId, rawId); }
  send(thread: Thread, payload: SendMessageRequest) { return this.messaging.send(thread, payload); }
  control(threadId: string, action: "stop" | "resume", offline?: boolean) { return this.messaging.control(threadId, action, offline); }
  queueMessage(thread: Thread, payload: SendMessageRequest) { return this.queueEngine.queueMessage(thread, payload); }
  queue(threadId: string, unsent = false) { return this.queueEngine.queue(threadId, unsent); }
  editQueued(thread: Thread, queuedMessageId: string, payload: { input: PromptInput[]; expectedUpdatedAt: number }) { return this.queueEngine.editQueued(thread, queuedMessageId, payload); }
  cancelQueued(thread: Thread, queuedMessageId: string) { return this.queueEngine.cancelQueued(thread, queuedMessageId); }
  reorderQueued(thread: Thread, request: { queuedMessageId: string; previousQueuedMessageId: string | null; nextQueuedMessageId: string | null }) { return this.queueEngine.reorderQueued(thread, request); }
  sendQueued(thread: Thread, queuedMessageId: string) { return this.queueEngine.sendQueued(thread, queuedMessageId); }
  compact(thread: Thread, then?: string) { return this.messaging.compact(thread, then); }
  goal(thread: Thread, goal: { status?: "active" | "paused"; objective?: string; clear?: boolean }) { return this.messaging.goal(thread, goal); }
  editMessage(thread: Thread, payload: EditMessageRequest) { return this.messaging.editMessage(thread, payload); }
  retryStart(threadId: string) { return this.messaging.retryStart(threadId); }

  // Delivery engine
  start() { this.delivery.start(); }
  stop() { this.delivery.stop(); }
}
