import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { z } from "zod";
import { cloudLoginName, cloudLoginProvider, COMPUTER, COMPUTER_TITLE, type CloudLoginProvider } from "@cloudroom/domain";
import { findCliExecutable } from "@cloudroom/process-utils";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { ACCOUNT_CHANGED } from "./claude-token.js";
import { authRequiredMessages, CloudroomClient, CloudroomConnectionError, CloudroomError, type CodexAuthStatus } from "./client.js";
import { stopPreviews } from "./previews.js";
import {
  accountSchema,
  connectionSchema,
  HOSTED_WEBSITE,
  ownerOf,
  publicError,
  sandboxAccountOf,
  websiteSchema,
  type CloudroomAccount,
  type SavedConnection,
} from "./protocol.js";
import type { CloudRuntime } from "./runtime.js";
import {
  cancelMacCodexLogin,
  cursorKeyRejected,
  macCodexDigest,
  macCodexLogin,
  macCodexLoginExpired,
  macCursorLogin,
  revokeDesktopToken,
  sandboxThread,
  startMacCodexLogin,
} from "./sandboxes.js";
import { cliPlace, reportAgentConnect } from "./setup-telemetry.js";
import { binding, bindings, stampBindings } from "./store.js";
import { cloudSkills, copyLogins, importCodexLogin, importPiLogin, macPiSetup, markLogin, setCopyMacLogin, skillInCloud, stopSync } from "./sync.js";

export interface AuthHooks {
  start: () => void;
  stop: () => void;
  retryStart: (threadId: string) => Promise<void>;
}

/**
 * Isolated account & agent-login module (Claude, Codex, Cursor, Pi, login sync).
 * Follows cloudroom-setup rules: keep login paths strictly stable and isolated.
 */
export class CloudAccountAuth {
  private claudeConnected: boolean | null = null;
  private readonly resumingStarts = new Set<string>();
  private signInCopyAt = 0;
  /** The Mac Codex login last resent after a Cloud refusal: each one is tried once, then only a new sign-in helps. */
  private codexTried: string | null = null;
  private healingCodex = false;
  /** A Codex sign-in started here on the cloud VM (not a sandbox), so the status that sees it connected resumes. */
  private codexSigningIn = false;
  private loopLogins: { at: number; counts: Partial<Record<CloudLoginProvider, number>> } | null = null;

  constructor(private readonly rt: CloudRuntime, private readonly hooks: AuthHooks) {}

  resetOnStop(): void { this.claudeConnected = null; }

  async beforeWake(): Promise<void> {
    void this.uploadMacConfig();
    const logins = this.syncLogins();
    if (!this.rt.sandboxes.loginsCopied) await logins;
  }

  /** A sandbox's Pi gets this Mac's custom providers and packages, if the user allowed copying logins (ADR 0130).
   *  Never blocks a start: Pi reports a missing provider itself. */
  async copyPiSetup(client: CloudroomClient, sandbox: boolean): Promise<void> {
    if (!sandbox) return importPiLogin(this.rt.host.deps);
    try {
      if (await copyLogins(this.rt.host.deps) !== true) return;
      const setup = await macPiSetup(this.rt.host.deps);
      if (setup) await client.piSetup(setup);
    } catch (error) {
      this.rt.host.warn("Pi providers could not be copied to the cloud", error);
    }
  }

  /** Saves a VM connection, the desktop token for cloud sandboxes, or both (docs/scopes/sandboxes.md). */
  configure(raw: unknown, account?: CloudroomAccount, signal?: AbortSignal, websiteUrl?: string, sandboxToken?: string): Promise<void> {
    return this.rt.changeConnection(async () => {
      signal?.throwIfAborted();
      const parsed = raw === null ? null : connectionSchema.safeParse(raw);
      if (parsed && !parsed.success) throw new ApiError(400, "invalid_request", "Enter the Core's full address and the API token from /etc/cloudroom/core.env.");
      const connection = parsed?.data ?? null;
      if (!connection && !(sandboxToken && account)) throw new ApiError(400, "invalid_request", "A VM connection or cloud sandboxes are required.");
      if (connection) connection.url = new URL(connection.url).href.replace(/\/$/, "");
      if (connection?.projectId && !this.rt.host.getProject(connection.projectId)) throw new ApiError(404, "project_not_found", "Project not found");
      const existing = await this.rt.savedConnection();
      const previousAccount = existing?.account && existing.account.id !== account?.id ? existing.account.id : null;
      const savedBindings = bindings(this.rt.host.db).filter((saved) => !sandboxThread(saved.coreUrl) && (saved.accountId ? saved.accountId === account?.id : !previousAccount));
      if (connection && savedBindings.some((saved) => saved.coreUrl !== connection.url)) {
        throw new ApiError(409, "cloudroom_connection_in_use", "Existing cloud threads belong to another core. Use a separate app profile; history has not been changed.");
      }
      if (connection && savedBindings.length && existing?.projectId && connection.projectId && existing.projectId !== connection.projectId) {
        throw new ApiError(409, "cloudroom_project_in_use", "Existing legacy cloud threads keep their current project binding.");
      }
      if (connection && !account) {
        const client = new CloudroomClient(connection);
        try {
          this.rt.lastCapabilities = await this.rt.capabilities(client);
          await client.ready();
        } catch (error) {
          // The user typed these, so say what to fix instead of the client's internal error.
          if (error instanceof CloudroomError && error.status === 401) {
            throw new ApiError(400, "invalid_request", "Your Core refused the API token (authentication failed). Copy it again from /etc/cloudroom/core.env.");
          }
          if (error instanceof CloudroomConnectionError || (error instanceof DOMException && error.name === "AbortError")) {
            throw new ApiError(400, "invalid_request", `Can't reach your Core at ${connection.url}. Check the address, and that Core is running.`);
          }
          throw error;
        }
      }
      signal?.throwIfAborted();
      this.hooks.stop();
      if (previousAccount) {
        // Its sign-out revoked this Mac's helper; if it never signed out, revoke now, while its login is still saved (#109).
        await stopPreviews(this.rt.host.deps).catch(() => {});
        stampBindings(this.rt.host.db, previousAccount);
        this.rt.sandboxes.reset();
        this.rt.codexAccounts.reset();
      }
      await this.rt.saveConnection({
        ...(connection ?? {}),
        ...(account ? { account: accountSchema.parse(account) } : {}),
        ...(websiteUrl ? { websiteUrl: websiteSchema.parse(websiteUrl) } : {}),
        ...(sandboxToken ? { sandboxToken } : {}),
        ...(account && existing?.account?.id === account.id && existing.url === connection?.url ? { onboarding: existing.onboarding } : {}),
      });
      // Again once the new account is saved, so a request the old one sent during the save can't fill its state (#1940).
      if (previousAccount) this.rt.sandboxes.reset();
      if (signal?.aborted) {
        if (existing) await this.rt.saveConnection(existing); else await rm(this.rt.connectionPath, { force: true });
        if (existing?.token || existing?.sandboxToken) this.hooks.start();
        signal.throwIfAborted();
      }
      this.hooks.start();
    });
  }

  /** Signs out. `refused` is a token the website just refused as signed out (a password reset, say): the app then
   *  signs out only if that is still the saved token, so a late answer never ends a newer sign-in. */
  disconnect(refused?: string): Promise<void> {
    if (!refused) this.hooks.stop();
    return this.rt.changeConnection(async () => {
      const saved = await this.rt.savedConnection();
      if (refused && saved?.sandboxToken !== refused) return;
      this.hooks.stop();
      // The website already ended a refused sign-in: a failed preview stop is logged, never left half signed out.
      await stopPreviews(this.rt.host.deps).catch((error: unknown) => {
        if (!refused) throw error;
        this.rt.host.warn("Previews could not be stopped after the website ended the sign-in", error);
      });
      if (saved) {
        const { token: _token, gateToken: _gateToken, sandboxToken, ...binding } = saved;
        await this.rt.saveConnection(binding);
        // A refused token is already gone from the website.
        if (!refused && sandboxToken && saved.account) {
          revokeDesktopToken({ website: saved.websiteUrl ?? HOSTED_WEBSITE, userId: saved.account.id, token: sandboxToken });
        }
      }
      this.rt.sandboxes.reset();
      this.rt.codexAccounts.reset();
      await this.rt.sandboxes.removeDeepapiKey().catch((error) => this.rt.host.warn("The DeepAPI key could not be removed from this Mac", error));
      await stopSync(this.rt.host.deps);
    });
  }

  /** Sandbox accounts keep logins on the website, and every sandbox receives them when it wakes (ADR 0145).
   *  This includes accounts that still have a VM: their new threads run in sandboxes. */
  private async sandboxLogin(name: "claude" | "codex" | "cursor"): Promise<CodexAuthStatus | null> {
    if (!await this.rt.newThreadsInSandboxes()) return null;
    const logins = await this.rt.sandboxes.logins().catch((error: unknown) => { throw new ApiError(503, `${name}_auth_unavailable`, publicError(error)); });
    return { state: logins[name] ? "connected" : "missing", email: null, plan: null, message: null, login_id: null, verification_url: null, user_code: null };
  }

  async uploadMacConfig(): Promise<void> {
    if (!await this.rt.sandboxMode()) return;
    await Promise.all([
      this.rt.sandboxes.copyMacConfig(skillInCloud(await cloudSkills(this.rt.host.deps))).catch((error) => this.rt.host.warn("Skills could not be copied to cloud sandboxes", error)),
      this.rt.sandboxes.refreshMacMcp().catch((error) => this.rt.host.warn("MCP servers could not be copied to cloud sandboxes", error)),
    ]);
  }

  /** Copies logins both ways when the user allowed it (ADRs 0130, 0175), and the DeepAPI key to this Mac
   *  (ADR 20261111-214204). Only the Mac → cloud copy is awaited. */
  async syncLogins(cloudChanged = false): Promise<void> {
    if (!await this.rt.sandboxMode()) return;
    void this.rt.sandboxes.copyDeepapiKey().catch((error) => this.rt.host.warn("The DeepAPI key could not be copied to this Mac", error));
    if (await copyLogins(this.rt.host.deps) !== true) return;
    void this.rt.sandboxes.copyCloudLogins(cloudChanged).catch((error) => this.rt.host.warn("Cloud logins could not be copied to this Mac", error));
    await this.rt.sandboxes.copyMacLogins().catch((error) => this.rt.host.warn("Logins could not be copied to cloud sandboxes", error));
  }

  /** A sign-in in Settings just ended: copy this Mac's logins now, even if a wake copied them seconds ago, so a child the
   *  website starts next has them, not only after this Mac's next wake (#1708). At most once a minute; unchanged logins
   *  are not sent again. */
  async copyLoginsNow(): Promise<void> {
    if (Date.now() - this.signInCopyAt < 60_000) return;
    this.signInCopyAt = Date.now();
    if (!await this.rt.sandboxMode() || await copyLogins(this.rt.host.deps) !== true) return;
    await this.rt.sandboxes.copyMacLogins(true).catch((error) => this.rt.host.warn("Logins could not be copied to cloud sandboxes", error));
  }

  /** `follow` marks the Accounts plugin keeping Cloud on the account in use, not the user connecting (ADR 0327). */
  /** `owner` is the `loginOwner()` a Connect Claude sign-in started under: its token is written only there (#1924). */
  async claudeAuth(action?: "login" | "cancel" | "complete" | "token" | "key", requestId?: string, code?: string, state?: string, follow = false, owner?: string | null) {
    const status = await this.claudeAuthStatus(action, requestId, code, state, follow, owner);
    const connected = status.state === "connected";
    // The code sign-in finishes in the background, so a status check that first sees Claude connected also resumes.
    if (connected && (action || !this.claudeConnected)) this.resumeStarts("claude-code");
    this.claudeConnected = connected;
    return status;
  }

  /** After an Accounts switch, the agent's awake sessions restart once idle, so their next message uses the new login (ADR 0197).
   *  Asleep sandboxes stay asleep; they read the new login when they wake. */
  restartAwake(providerId: "claude-code" | "codex"): void {
    for (const saved of bindings(this.rt.host.db)) {
      const thread = this.rt.host.getThread(saved.threadId);
      const sessionId = saved.sessionId;
      if (!sessionId || thread?.providerId !== providerId || thread.archivedAt || thread.deletedAt) continue;
      void this.rt.client(saved, false).then((client) => client.sleep(sessionId, randomUUID())).catch(() => {});
    }
  }

  /** Starts that waited for this agent's sign-in continue on their own. Later tries cover a login still reaching an awake sandbox. */
  private resumeStarts(providerId: CloudLoginProvider): void {
    const waiting = (threadId: string) => {
      const saved = binding(this.rt.host.db, threadId);
      const thread = this.rt.host.getThread(threadId);
      return Boolean(saved && !saved.sessionId && authRequiredMessages.has(saved.error ?? "") && thread?.providerId === providerId && !thread.archivedAt && !thread.deletedAt);
    };
    for (const { threadId } of bindings(this.rt.host.db)) {
      if (this.resumingStarts.has(threadId) || !waiting(threadId)) continue;
      this.resumingStarts.add(threadId);
      void (async () => {
        for (const wait of [0, 3_000, 10_000]) {
          await new Promise((resolve) => setTimeout(resolve, wait).unref());
          if (this.rt.stopped || !waiting(threadId)) return;
          await this.hooks.retryStart(threadId).catch((error) => this.rt.host.warn(`Cloud start could not continue after ${cloudLoginName(providerId)} sign-in`, error, { threadId }));
        }
      })().finally(() => this.resumingStarts.delete(threadId));
    }
  }

  /** Cloud refused Codex, but this Mac's login may still work: send it again, once per Mac login (cheap checks first, so
   *  the banner's poll costs nothing once tried). Answers whether it was sent. */
  private async resendMacCodex(): Promise<boolean> {
    const digest = await macCodexDigest();
    if (!digest || digest === this.codexTried) return false;
    if (!await this.rt.newThreadsInSandboxes() || await copyLogins(this.rt.host.deps) !== true) return false;
    this.codexTried = digest;
    if (await macCodexLoginExpired()) return false;
    const sent = await this.rt.sandboxes.resendMacCodexLogin();
    if (sent) this.codexTried = sent;
    return Boolean(sent);
  }

  /** Self-heal: when Cloud refuses Codex, resend this Mac's working login and continue the waiting starts, with no click.
   *  Skipped while Cloud uses a website Codex account: only the website renews those (ADR 0195). */
  healCodex(): void {
    if (this.healingCodex) return;
    this.healingCodex = true;
    void (async () => {
      const digest = await macCodexDigest();
      if (!digest || digest === this.codexTried || await this.rt.codexAccounts.selected()) return;
      if (await this.resendMacCodex()) this.codexFixed();
    })().catch((error) => this.rt.host.warn("This Mac's Codex login could not be resent to Cloud", error)).finally(() => { this.healingCodex = false; });
  }

  /** Codex works in Cloud again: waiting starts continue, and the banner asks the website about paused loops again. */
  private codexFixed(): void {
    this.loopLogins = null;
    this.resumeStarts("codex");
  }

  /** Cloud loops the website paused because an agent's Cloud login was refused. Read at most every 15 minutes. */
  private async loopLoginIssues(): Promise<Partial<Record<CloudLoginProvider, number>>> {
    const now = Date.now();
    if (this.loopLogins && now - this.loopLogins.at < 15 * 60_000) return this.loopLogins.counts;
    const last = this.loopLogins?.counts ?? {};
    this.loopLogins = { at: now, counts: last };
    const listed = z.object({
      automations: z.array(z.object({
        enabled: z.boolean(),
        last_error: z.string().nullable().catch(null),
        last_run_at: z.string().nullable().catch(null),
        created_at: z.string().catch(""),
      }).passthrough()),
    }).safeParse(await this.rt.sandboxes.automations({ action: "list" }).catch(() => null));
    if (!listed.success) return last;
    const counts: Partial<Record<CloudLoginProvider, number>> = {};
    for (const loop of listed.data.automations) {
      const paused = !loop.enabled && /^Paused after \d+ failed runs\./.test(loop.last_error ?? "");
      // Like the sidebar's paused label: pauses older than a week stay quiet.
      const recent = now - Date.parse(loop.last_run_at ?? loop.created_at) < 7 * 86_400_000;
      const provider = paused && recent ? cloudLoginProvider((loop.last_error ?? "").replace(/^Paused after \d+ failed runs\.\s*(?:Last error: |The last run failed: )?/, "")) : null;
      if (provider) counts[provider] = (counts[provider] ?? 0) + 1;
    }
    if (this.loopLogins.at === now) this.loopLogins = { at: now, counts };
    return counts;
  }

  /** Agents Cloud refused for a missing or dead login: their threads waiting here and the Cloud loops paused (the banner).
   *  Seeing Codex refused also tries the self-heal. */
  async cloudLogins(): Promise<{ provider: CloudLoginProvider; threads: number; loops: number }[]> {
    const issues = new Map<CloudLoginProvider, { provider: CloudLoginProvider; threads: number; loops: number }>();
    const issue = (provider: CloudLoginProvider) => issues.get(provider) ?? issues.set(provider, { provider, threads: 0, loops: 0 }).get(provider)!;
    for (const saved of bindings(this.rt.host.db)) {
      if (saved.sessionId || !authRequiredMessages.has(saved.error ?? "")) continue;
      const thread = this.rt.host.getThread(saved.threadId);
      const provider = cloudLoginProvider(saved.error);
      if (thread && provider && !thread.archivedAt && !thread.deletedAt) issue(provider).threads += 1;
    }
    for (const [provider, loops] of Object.entries(await this.loopLoginIssues()) as [CloudLoginProvider, number][]) issue(provider).loops += loops;
    if (issues.has("codex")) this.healCodex();
    return [...issues.values()];
  }

  async loginOwner(): Promise<string | null> { return ownerOf(await this.rt.savedConnection()); }

  /** Before each write of a Connect Claude token: the saved connection, refused once it isn't the owner's (#1924).
   *  Writes use this snapshot, never a fresh read, so a switch after the check can't redirect them. */
  private async requireOwner(owner: string | null | undefined): Promise<SavedConnection> {
    const saved = await this.rt.savedConnection();
    if (owner === undefined) return saved;
    if (!owner) throw new ApiError(503, "cloudroom_not_configured", "Cloud needs a free Cloudroom account. Sign in to use it.");
    if (owner !== ownerOf(saved)) throw new ApiError(409, "cloudroom_account_changed", ACCOUNT_CHANGED);
    return saved;
  }

  private async claudeAuthStatus(action?: "login" | "cancel" | "complete" | "token" | "key", requestId?: string, code?: string, state?: string, follow = false, owner?: string | null) {
    await this.requireOwner(owner);
    const sandbox = await this.sandboxLogin("claude");
    if (sandbox) {
      if ((action === "token" || action === "key") && code) {
        if (!follow) await markLogin(this.rt.host.deps, "claude", null);
        const value = action === "token" ? { token: code, ...(state ? { plan: state } : {}) } : { apiKey: code };
        const account = sandboxAccountOf(await this.requireOwner(owner));
        if (owner !== undefined && !account) throw new ApiError(409, "cloudroom_account_changed", ACCOUNT_CHANGED);
        if (!await this.rt.sandboxes.saveLogin("claude", JSON.stringify(value), owner !== undefined && account ? { account, signal: AbortSignal.timeout(120_000) } : undefined, follow)) return sandbox;
      }
      if (action === "login" || action === "complete") {
        throw new ApiError(409, "claude_auth_unsupported", `Cloud sandboxes connect Claude with a one-year token from this ${COMPUTER}. Use Connect Claude.`);
      }
      if ((action === "token" || action === "key") && code) {
        void this.syncLogins(true);
        if ((await this.rt.savedConnection())?.token) await this.vmClaudeAuth(action, requestId, code, state, owner).catch((error) => this.rt.host.warn("Claude could not be connected on the VM", error));
      }
      return action === "token" || action === "key" ? { ...sandbox, state: "connected" as const } : sandbox;
    }
    return this.vmClaudeAuth(action, requestId, code, state, owner);
  }

  private async vmClaudeAuth(action?: "login" | "cancel" | "complete" | "token" | "key", requestId?: string, code?: string, state?: string, owner?: string | null) {
    const client = owner === undefined ? await this.rt.client() : new CloudroomClient(await this.rt.connection(await this.requireOwner(owner)));
    const capabilities = await this.rt.capabilities(client);
    if (!capabilities.claude_auth) throw new ApiError(409, "claude_auth_unsupported", "Update the cloud core to connect Claude from this app.");
    try { return await client.claudeAuth(action, requestId, code, state); }
    catch (error) {
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, "claude_auth_unavailable", `Could not reach Claude sign-in on your VM: ${publicError(error)}`);
    }
  }

  async antigravityLogin(input: Record<string, unknown>) {
    const result = await this.rt.sandboxes.antigravityLogin(input);
    if (result.connected && (input.action === "complete" || input.action === "key")) {
      this.loopLogins = null;
      this.resumeStarts("acp-antigravity");
    }
    return result;
  }

  async cursorAuth(action?: "login" | "cancel" | "key", requestId?: string, apiKey?: string) {
    const status = await this.cursorAuthStatus(action, requestId, apiKey);
    // A new Cursor login: the starts that waited for it continue by themselves.
    if (status.state === "connected" && (action === "login" || action === "key")) {
      this.loopLogins = null;
      this.resumeStarts("acp-cursor");
    }
    return status;
  }

  private async cursorAuthStatus(action?: "login" | "cancel" | "key", requestId?: string, apiKey?: string) {
    const sandbox = await this.sandboxLogin("cursor");
    if (sandbox) {
      // Signing in copies this Mac's Cursor login; clicking is the consent, even when automatic copying is off.
      if (action === "login") {
        const login = await macCursorLogin();
        if (!login) throw new ApiError(409, "cursor_auth_required", `Cursor is not signed in on this ${COMPUTER}. Run \`cursor-agent login\` in your terminal, then click Sign in with Cursor again, or use a Cursor API key.`);
        await this.rt.sandboxes.saveLogin("cursor", login);
        return { ...sandbox, state: "connected" as const };
      }
      if (action !== "key") return sandbox.state === "connected" ? sandbox : { ...sandbox, message: `Cloud threads use this ${COMPUTER}'s Cursor login, or a Cursor user API key.` };
      const key = apiKey?.trim() ?? "";
      if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw new ApiError(400, "invalid_request", "Enter a valid Cursor API key.");
      if (await cursorKeyRejected(key)) throw new ApiError(400, "invalid_request", "Cursor says this API key is invalid. Check it and try again.");
      await this.rt.sandboxes.saveLogin("cursor", JSON.stringify({ apiKey: key }));
      if ((await this.rt.savedConnection())?.token) await this.vmCursorAuth(action, requestId, key).catch((error) => this.rt.host.warn("Cursor could not be connected on the VM", error));
      return { ...sandbox, state: "connected" as const };
    }
    return this.vmCursorAuth(action, requestId, apiKey);
  }

  /** The Accounts plugin's Cursor account in use: its key becomes the Cloud login, and this Mac's own Cursor login stops
   *  copying over it. `null` (This Mac) copies this Mac's login again, and fails when it has none. */
  cursorAccount(requestId: string, apiKey: string | null) {
    return this.rt.sandboxes.withLogins(async () => {
      if (apiKey === null) {
        if (!await macCursorLogin()) throw new ApiError(409, "cursor_auth_required", `Cursor is not signed in on this ${COMPUTER}. Run \`cursor-agent login\`, then pick This ${COMPUTER_TITLE} again.`);
        await setCopyMacLogin(this.rt.host.deps, "cursor", true);
        return this.cursorAuth("login", requestId);
      }
      const status = await this.cursorAuth("key", requestId, apiKey);
      await setCopyMacLogin(this.rt.host.deps, "cursor", false);
      return status;
    });
  }

  private async vmCursorAuth(action?: "login" | "cancel" | "key", requestId?: string, apiKey?: string) {
    const client = await this.rt.client();
    const capabilities = await this.rt.capabilities(client);
    if (!capabilities.cursor_auth) throw new ApiError(409, "cursor_auth_unsupported", "Update the cloud core to connect Cursor from this app.");
    try { return await client.cursorAuth(action, requestId, apiKey); }
    catch (error) {
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, error instanceof CloudroomError ? error.code ?? "cursor_auth_unavailable" : "cursor_auth_unavailable", publicError(error));
    }
  }

  async piApiKey(provider: string, apiKey: string) {
    const client = await this.rt.client();
    try { return await client.piApiKey(provider, apiKey); }
    catch (error) {
      if (error instanceof CloudroomError && error.status === 404) throw new ApiError(409, "pi_auth_unsupported", "Update the cloud core to set Pi keys from this app.");
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, error instanceof CloudroomError ? error.code ?? "pi_auth_unavailable" : "pi_auth_unavailable", publicError(error));
    }
  }

  async codexAuth(action?: "login" | "cancel", requestId?: string) {
    const sandbox = await this.sandboxLogin("codex");
    if (sandbox) {
      let copied = false;
      if (action === "cancel") cancelMacCodexLogin();
      if (action === "login") {
        await markLogin(this.rt.host.deps, "codex", null);
        const account = sandbox.state === "connected" ? await this.rt.codexAccounts.selected() : null;
        if (account) throw new ApiError(409, "codex_account_rejected", `Cloud uses your Codex account ${account}. Sign in to it again with Add in Settings → Agents → Codex, or pick This ${COMPUTER_TITLE} there.`);
        if (await copyLogins(this.rt.host.deps) !== true) {
          reportAgentConnect("codex", "failed", { code: "copy_logins_off" });
          throw new ApiError(409, "codex_auth_unsupported", `Cloud sandboxes use this ${COMPUTER}'s Codex login. Turn on "Auth my agents in the cloud automatically" in Settings → Cloud, then try again.`);
        }
        // Cloud lacks the login or refused it: resend this Mac's working one (once per login). Otherwise sign in on this
        // Mac first, then the next status check copies the new login.
        if (await this.resendMacCodex()) copied = true;
        else startMacCodexLogin(this.rt.host.deps as LoggedWorkSessionDeps);
      }
      const run = macCodexLogin();
      if (run?.done && !run.error) {
        await this.rt.sandboxes.copyMacLogins(true);
        copied = true;
      }
      const status = copied ? (await this.sandboxLogin("codex"))! : sandbox;
      if (run?.installingSince) return { ...status, state: "waiting" as const, login_id: "mac", verification_url: null, message: null, installing_since: run.installingSince };
      if (run && !run.done) return { ...status, state: "waiting" as const, login_id: "mac", verification_url: run.url, message: "Finish signing in to ChatGPT in your browser." };
      if (run?.error) {
        reportAgentConnect("codex", "failed", { code: "login_failed", message: run.error, cliPlace: cliPlace(findCliExecutable("codex")) });
        return { ...status, state: "error" as const, message: run.error };
      }
      if (status.state === "connected" && (action === "login" || run?.done)) reportAgentConnect("codex", "ok", { cliPlace: cliPlace(findCliExecutable("codex")) });
      // A new login reached Cloud: the starts that waited for it continue by themselves, with no "Continue to task".
      if (copied && status.state === "connected") this.codexFixed();
      return status;
    }
    try {
      const client = await this.rt.client();
      const capabilities = await this.rt.capabilities(client);
      if (!capabilities.codex_auth) throw new ApiError(409, "codex_auth_unsupported", "Update the cloud core to connect Codex from this app.");
      if (capabilities.codex_auth_import && action !== "cancel") await importCodexLogin(this.rt.host.deps);
      const status = await client.codexAuth(action, requestId);
      if (action) this.codexSigningIn = action === "login" && status.state === "waiting";
      if (status.state === "connected" && (action === "login" || this.codexSigningIn)) {
        this.codexSigningIn = false;
        this.codexFixed();
      }
      return status;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error instanceof CloudroomError && error.status === 409 ? 409 : 503, error instanceof CloudroomError ? error.code ?? "codex_auth_unavailable" : "codex_auth_unavailable", publicError(error));
    }
  }
}
