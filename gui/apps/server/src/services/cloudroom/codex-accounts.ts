import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { HostDaemonContributedEnvEntry } from "@cloudroom/host-daemon-contract";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH = "https://auth.openai.com";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const SIGN_IN_MS = 10 * 60_000;
const USAGE_MS = 5 * 60_000;
// The website renews a token once it has 5 of its 10 days left, so 4 days left means a renewal was missed.
const TOKEN_MARGIN_MS = 4 * 86_400_000;

const remoteSchema = z.object({
  selected: z.string().nullable(),
  accounts: z.array(z.object({
    id: z.string(), name: z.string().nullable(), email: z.string().nullable(), plan: z.string().nullable(),
    accountId: z.string().nullable(), error: z.string().nullable(), accessToken: z.string().min(1), expiresAt: z.number().nullable(),
  })),
});
type Remote = z.infer<typeof remoteSchema>;
type Cached = Remote & { userId: string; at: number };
type Window = { label: string; usedPercent: number; resetsAt: number | null };
const usageWindowSchema = z.object({ used_percent: z.number(), reset_at: z.number().nullish(), limit_window_seconds: z.number().nullish() }).nullish();
const usageSchema = z.object({
  plan_type: z.string().nullish(),
  rate_limit: z.object({ allowed: z.boolean().nullish(), limit_reached: z.boolean().nullish(), primary_window: usageWindowSchema, secondary_window: usageWindowSchema }).nullish(),
  credits: z.object({ has_credits: z.boolean().nullish(), unlimited: z.boolean().nullish(), balance: z.union([z.string(), z.number()]).nullish() }).nullish().catch(null),
});
type Credits = { detail: string | null } | null;

function creditsInUse(usage: z.infer<typeof usageSchema>, windows: Window[]): Credits {
  const limited = usage.rate_limit?.limit_reached === true || windows.some(window => window.usedPercent >= 100);
  if (!limited || usage.credits?.has_credits !== true || usage.credits.unlimited === true || usage.rate_limit?.allowed === false) return null;
  const balance = usage.credits.balance;
  if (balance == null || balance === "") return { detail: null };
  return { detail: /^[\d.,]+$/u.test(String(balance)) ? `${balance} credits left` : `${balance} left` };
}
const tokensSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), id_token: z.string().min(1) });

export type CodexAccountView = { id: string; name: string | null; email: string | null; plan: string | null; inUse: boolean; error: string | null; credits: Credits; windows: Window[] };
export type CodexAccountsRequest =
  | { action: "list" }
  | { action: "start" }
  | { action: "poll"; sessionId: string }
  | { action: "use"; id: string | null }
  | { action: "remove" | "rename" | "move"; id: string; name?: string; direction?: "up" | "down" };

const planType = (token: string): string | null => {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, Record<string, unknown> | undefined>;
    const plan = claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
    return typeof plan === "string" ? plan : null;
  } catch { return null; }
};
const label = (seconds: number | null | undefined, fallback: string) => seconds === 18_000 ? "Five-hour limit" : seconds === 604_800 ? "Weekly limit" : fallback;

async function postJson(url: string, body: Record<string, string>, form = false): Promise<Response> {
  return fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { accept: "application/json", "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
}

/** Codex accounts live on the website, which alone renews them (ADR 0195). This Mac signs new ones in with OpenAI's
 *  device code, hands their tokens to the website, and keeps only access tokens, in a 0600 file so Local threads keep
 *  working while the website is unreachable. They never reach the renderer. */
export class CodexAccounts {
  private cached: Cached | null | undefined;
  private loading: Promise<Cached | null> | null = null;
  private readonly usage = new Map<string, { windows: Window[]; credits: Credits; error: string | null; at: number }>();
  private readonly signIns = new Map<string, { authId: string; userCode: string; expiresAt: number }>();

  constructor(
    private readonly call: (body: Record<string, unknown>) => Promise<unknown>,
    private readonly user: () => Promise<string | null>,
    private readonly path: string,
    private readonly switched: () => void,
  ) {}

  /** The selected account's sign-in for a Local Codex thread. None means the Mac's own `~/.codex` login. */
  async environment(): Promise<HostDaemonContributedEnvEntry[]> {
    const state = await this.load().catch(() => null);
    const account = state?.accounts.find(each => each.id === state.selected);
    if (!account) return [];
    const reason = `Cloudroom Codex account ${account.email ?? account.id}`, source = { core: "machine-environment" as const };
    return [
      { name: "CLOUDROOM_CODEX_ACCESS_TOKEN", value: account.accessToken, source, reason },
      { name: "CLOUDROOM_CODEX_ACCOUNT_ID", value: account.accountId ?? "", source, reason },
      { name: "CLOUDROOM_CODEX_PLAN_TYPE", value: planType(account.accessToken) ?? "", source, reason },
    ];
  }

  /** The selected account's email, while one is selected. */
  async selected(): Promise<string | null> {
    const state = await this.load().catch(() => null);
    const account = state?.accounts.find(each => each.id === state.selected);
    return account ? account.email ?? account.name ?? "Codex account" : null;
  }

  async request(input: CodexAccountsRequest) {
    if (input.action === "start") return this.start();
    if (input.action === "poll") return this.poll(input.sessionId);
    if (input.action === "list") return this.view(await this.load());
    const before = (await this.load().catch(() => null))?.selected ?? null;
    const state = await this.save(input);
    if (state.selected !== before) this.switched();
    return this.view(state);
  }

  private async view(state: Cached | null): Promise<{ signedIn: boolean; accounts: CodexAccountView[] }> {
    if (!state) return { signedIn: false, accounts: [] };
    await Promise.all(state.accounts.map(account => this.measure(account)));
    return {
      signedIn: true,
      accounts: state.accounts.map(account => {
        const measured = this.usage.get(account.id);
        return {
          id: account.id, name: account.name, email: account.email, plan: account.plan, inUse: account.id === state.selected,
          error: account.error ?? measured?.error ?? null, credits: measured?.credits ?? null,
          windows: (measured?.windows ?? []).map(window => window.resetsAt !== null && window.resetsAt <= Date.now() ? { ...window, usedPercent: 0, resetsAt: null } : window),
        };
      }),
    };
  }

  /** The website's list, at most every 10 minutes with accounts (an hour without), or sooner if a token is close to expiry. */
  private async load(force = false): Promise<Cached | null> {
    const userId = await this.user();
    if (!userId) {
      if (this.cached !== null) { this.cached = null; await rm(this.path, { force: true }).catch(() => {}); }
      return null;
    }
    if (this.cached === undefined) this.cached = await readFile(this.path, "utf8").then(text => JSON.parse(text) as Cached, () => null);
    const cached = this.cached?.userId === userId ? this.cached : null;
    const selected = cached?.accounts.find(each => each.id === cached.selected);
    const fresh = cached && Date.now() - cached.at < (cached.accounts.length ? 10 : 60) * 60_000 && (!selected?.expiresAt || selected.expiresAt - Date.now() > TOKEN_MARGIN_MS);
    if (fresh && !force) return cached;
    this.loading ??= this.remember(userId, { action: "list" }).finally(() => { this.loading = null; });
    return this.loading.catch((error: unknown) => { if (cached && !force) return cached; throw error; });
  }

  private async save(body: Record<string, unknown>): Promise<Cached> {
    const userId = await this.user();
    if (!userId) throw new Error("Sign in to Cloudroom to add Codex accounts. They work in Local and Cloud threads.");
    return this.remember(userId, body);
  }

  private async remember(userId: string, body: Record<string, unknown>): Promise<Cached> {
    const state: Cached = { ...remoteSchema.parse(await this.call(body)), userId, at: Date.now() };
    this.cached = state;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 }).then(() => rename(temp, this.path)).catch(() => rm(temp, { force: true }));
    return state;
  }

  private async measure(account: Remote["accounts"][number]): Promise<void> {
    const previous = this.usage.get(account.id);
    if (previous && Date.now() - previous.at < USAGE_MS) return;
    try {
      const response = await fetch(USAGE_URL, {
        redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { authorization: `Bearer ${account.accessToken}`, "chatgpt-account-id": account.accountId ?? "", originator: "cloudroom", accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Codex usage failed (HTTP ${response.status}).`);
      const usage = usageSchema.parse(await response.json());
      const windows = ([["Primary limit", usage.rate_limit?.primary_window], ["Secondary limit", usage.rate_limit?.secondary_window]] as const)
        .flatMap(([fallback, window]) => window ? [{ label: label(window.limit_window_seconds, fallback), usedPercent: window.used_percent, resetsAt: window.reset_at ? window.reset_at < 1e12 ? window.reset_at * 1_000 : window.reset_at : null }] : []);
      this.usage.set(account.id, { windows, credits: creditsInUse(usage, windows), error: null, at: Date.now() });
    } catch (error) {
      this.usage.set(account.id, { windows: previous?.windows ?? [], credits: previous?.credits ?? null, error: error instanceof Error ? error.message : String(error), at: Date.now() });
    }
  }

  private async start() {
    if (!await this.user()) throw new Error("Sign in to Cloudroom to add Codex accounts. They work in Local and Cloud threads.");
    const response = await postJson(`${AUTH}/api/accounts/deviceauth/usercode`, { client_id: CLIENT_ID });
    if (!response.ok) throw new Error(`OpenAI could not start the Codex sign-in (HTTP ${response.status}).`);
    const started = z.object({ device_auth_id: z.string(), user_code: z.string() }).parse(await response.json());
    const sessionId = randomUUID(), expiresAt = Date.now() + SIGN_IN_MS;
    this.signIns.set(sessionId, { authId: started.device_auth_id, userCode: started.user_code, expiresAt });
    return { sessionId, verificationUri: `${AUTH}/codex/device`, userCode: started.user_code, expiresAt };
  }

  /** Once the user approves the code, the new account's tokens go straight to the website. */
  private async poll(sessionId: string): Promise<{ status: "pending" | "complete" | "error"; message: string | null }> {
    const signIn = this.signIns.get(sessionId);
    if (!signIn || Date.now() > signIn.expiresAt) {
      this.signIns.delete(sessionId);
      return { status: "error", message: "This code expired. Start again." };
    }
    try {
      const response = await postJson(`${AUTH}/api/accounts/deviceauth/token`, { device_auth_id: signIn.authId, user_code: signIn.userCode });
      const body: unknown = await response.json().catch(() => null);
      const approved = z.object({ authorization_code: z.string(), code_verifier: z.string() }).safeParse(body);
      if (!response.ok || !approved.success) {
        if (!/denied|declined/iu.test(JSON.stringify(body ?? ""))) return { status: "pending", message: null };
        this.signIns.delete(sessionId);
        return { status: "error", message: "Codex sign-in was declined." };
      }
      this.signIns.delete(sessionId);
      const exchanged = await postJson(`${AUTH}/oauth/token`, { grant_type: "authorization_code", code: approved.data.authorization_code, redirect_uri: `${AUTH}/deviceauth/callback`, client_id: CLIENT_ID, code_verifier: approved.data.code_verifier }, true);
      if (!exchanged.ok) throw new Error(`OpenAI did not finish the Codex sign-in (HTTP ${exchanged.status}).`);
      await this.save({ action: "add", tokens: tokensSchema.parse(await exchanged.json()) });
      return { status: "complete", message: null };
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
}
