import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import type { CodexAuthStatus } from "./client.js";
import { cloudroom } from "./commands.js";
import { macGithubAccount, macGithubToken, sandboxGithubLogin, type GithubAccount, type SandboxAccount } from "./sandboxes.js";

// Cloudroom's GitHub App "Cloudroom Agents" (docs/external/github.md, ADR 20261123-114456, #2084).
// Its device flow uses this Client ID with no scope: the token reaches only the repos the user picks on `install`
// (all repositories or selected ones). The old OAuth App stays only for website sign-in and already-saved logins.
const GITHUB_APP = { clientId: "Iv23lilRDA0DFyES7mNr", install: "https://github.com/apps/cloudroom-agents/installations/new" };
const PICK_REPOS_MS = 15 * 60_000;
const idle: CodexAuthStatus = { state: "missing", email: null, plan: null, message: null, login_id: null, verification_url: null, user_code: null };
const codeSchema = z.object({ device_code: z.string().min(1).max(256), user_code: z.string().regex(/^[A-Z0-9-]{1,32}$/), verification_uri: z.string().startsWith("https://github.com/"), expires_in: z.number().positive(), interval: z.number().positive() });

type Login = { id: string; abort: AbortController; status: CodexAuthStatus | null };
let login: Login | null = null;
let failure: CodexAuthStatus | null = null;
// A failed switch (to picked repos, or another account) leaves the older login working. The card still says what
// failed, for this long.
let failedAt = 0;
const FAILURE_SHOWN_MS = 10 * 60_000;

async function github(path: string, form: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`https://github.com/${path}`, {
    method: "POST", redirect: "error", headers: { Accept: "application/json" },
    body: new URLSearchParams(form), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  return z.record(z.string(), z.unknown()).parse(await response.json());
}

const reason = (value: Record<string, unknown> | null) => typeof value?.error === "string" && /^[a-z_]{1,64}$/.test(value.error) ? ` (${value.error})` : "";

export function cancelGithubLogin(): void {
  login?.abort.abort();
  login = null;
  failure = null;
}

export type GithubAuthStatus = CodexAuthStatus & { local_github?: { login: string | null } | null };

/** GitHub login for cloud sandboxes. Cloud's saved login is the source of truth; local `gh` is detected locally
 *  and never uploaded until the user clicks Use @handle (ADR 20261124-215124). Device login always uses the
 *  Cloudroom Agents GitHub App and waits for the user to pick repos on GitHub (all or selected) unless installed. */
export async function githubAuth(deps: AppDeps, action?: "login" | "cancel", requestId = ""): Promise<GithubAuthStatus> {
  if (action === "login") return start(deps, requestId);
  if (action === "cancel" && login?.id === requestId) cancelGithubLogin();
  if (login?.status) return login.status;
  const connected: GithubAuthStatus = { ...idle, state: "connected", message: failure && Date.now() - failedAt < FAILURE_SHOWN_MS ? failure.message : null };
  const logins = await cloudroom(deps).sandboxes.logins().catch((error: unknown) => {
    throw new ApiError(503, "github_auth_unavailable", error instanceof Error ? error.message : String(error));
  });
  if (logins.github) return connected;
  const local_github = await macGithubAccount();
  return { ...(failure ?? idle), local_github };
}

/** Verifies a local `gh` token against GitHub on explicit click and copies it to Cloud once (ADR 20261124-215124). */
export async function copyMacGithub(deps: AppDeps, expectedLogin?: string | null): Promise<GithubAuthStatus> {
  const account = await cloudroom(deps).sandboxes.account();
  if (!account) throw new ApiError(409, "github_auth_unavailable", "Sign in to Cloudroom first.");
  const token = await macGithubToken();
  if (!token) throw new ApiError(409, "github_auth_unavailable", "No GitHub CLI login was found on this computer. Sign in with Connect GitHub instead.");
  const response = await fetch("https://api.github.com/user", {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (response?.status === 401) throw new ApiError(409, "github_auth_invalid", "Your local GitHub CLI login has expired or was revoked. Run `gh auth login` or sign in with another account.");
  const user = response?.ok ? z.object({ login: z.string().min(1) }).safeParse(await response.json().catch(() => null)) : null;
  if (!user?.success) throw new ApiError(503, "github_auth_unavailable", "Could not verify your local GitHub CLI login right now. Try again or sign in with another account.");
  if (expectedLogin && user.data.login.toLowerCase() !== expectedLogin.toLowerCase()) {
    throw new ApiError(409, "github_auth_mismatch", `Your local GitHub CLI switched to @${user.data.login}. Reload and confirm again.`);
  }
  const entry = await sandboxGithubLogin(token);
  cancelGithubLogin();
  await cloudroom(deps).sandboxes.saveLogin("github", entry, { account, signal: AbortSignal.timeout(30_000) }, false, true).catch((error: unknown) => {
    throw new ApiError(503, "github_auth_unavailable", error instanceof Error ? error.message : String(error));
  });
  return { ...idle, state: "connected" };
}

/** The GitHub account cloud sandboxes use, or null when it can't be told. */
export const githubAccount = (deps: AppDeps): Promise<GithubAccount | null> =>
  cloudroom(deps).sandboxes.githubAccount().catch(() => null);

/** Removes the GitHub login from cloud sandboxes. */
export async function disconnectGithub(deps: AppDeps): Promise<void> {
  cancelGithubLogin();
  await cloudroom(deps).sandboxes.removeLogin("github").catch((error: unknown) => {
    throw new ApiError(503, "github_auth_unavailable", error instanceof Error ? error.message : String(error));
  });
}

async function start(deps: AppDeps, requestId: string): Promise<CodexAuthStatus> {
  const account = await cloudroom(deps).sandboxes.account();
  if (!account) throw new ApiError(409, "github_auth_unavailable", "Sign in to Cloudroom first.");
  if (login?.id === requestId && login.status) return login.status;
  cancelGithubLogin();
  const current: Login = { id: requestId, abort: new AbortController(), status: null };
  login = current;
  let value: Record<string, unknown> | null = null;
  try {
    value = await github("login/device/code", { client_id: GITHUB_APP.clientId }, current.abort.signal);
    const code = codeSchema.parse(value);
    current.status = { ...idle, state: "waiting", login_id: requestId, verification_url: code.verification_uri, user_code: code.user_code };
    void poll(deps, current, account, { deviceCode: code.device_code, interval: code.interval, deadline: Date.now() + code.expires_in * 1000 });
    return current.status;
  } catch {
    if (login === current) login = null;
    if (current.abort.signal.aborted) throw new ApiError(409, "github_auth_cancelled", "GitHub sign-in was cancelled.");
    throw new ApiError(503, "github_auth_unavailable", `GitHub sign-in could not start${reason(value)}. Try again.`);
  }
}

/** Waits until the GitHub App is installed, and not suspended, on at least one account the token's owner can reach:
 *  until then the token reads no private repo. The status sends the person to GitHub's page for it, with no code to
 *  type. False when time runs out. Someone whose account or organization already has the app skips the wait. */
async function reposPicked(current: Login, token: string): Promise<boolean> {
  const signal = current.abort.signal, deadline = Date.now() + PICK_REPOS_MS;
  for (let first = true; Date.now() < deadline; first = false) {
    const response = await fetch("https://api.github.com/user/installations?per_page=100", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    }).catch(() => null);
    signal.throwIfAborted();
    if (response?.status === 401) throw new Error("GitHub rejected the new login.");
    const found = response?.ok ? z.object({ installations: z.array(z.object({ suspended_at: z.string().nullish() })) }).safeParse(await response.json().catch(() => null)) : null;
    if (found?.success && found.data.installations.some((install) => !install.suspended_at)) return true;
    if (first) current.status = { ...idle, state: "waiting", login_id: current.id, verification_url: GITHUB_APP.install };
    await sleep(3000, undefined, { signal, ref: false });
  }
  return false;
}

type Flow = { deviceCode: string; interval: number; deadline: number };
async function poll(deps: AppDeps, current: Login, account: SandboxAccount, { deviceCode, interval, deadline }: Flow): Promise<void> {
  const signal = current.abort.signal;
  const end = (status: CodexAuthStatus | null) => { if (login === current) { login = null; failure = status; failedAt = Date.now(); } };
  try {
    while (Date.now() < deadline) {
      await sleep(interval * 1000, undefined, { signal, ref: false });
      // A network blip only skips one check; the code stays valid until its deadline.
      const value = await github("login/oauth/access_token", { client_id: GITHUB_APP.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }, signal).catch(() => null);
      if (signal.aborted) return;
      if (!value || value.error === "authorization_pending") continue;
      if (value.error === "slow_down") { interval = Math.max(interval + 5, Number(value.interval) || 0); continue; }
      if (value.error === "expired_token") break;
      const token = typeof value.access_token === "string" && /^[\x21-\x7e]{1,4096}$/.test(value.access_token) ? value.access_token : null;
      if (!token) return end({ ...idle, state: "error", message: value.error === "access_denied" ? "GitHub sign-in was declined." : `GitHub sign-in failed${reason(value)}. Try again.` });
      if (!await reposPicked(current, token)) return end({ ...idle, state: "expired", message: "No repos were picked on GitHub. Try again. If your organization has to approve Cloudroom Agents, ask an owner first." });
      const entry = await sandboxGithubLogin(token);
      signal.throwIfAborted();
      await cloudroom(deps).sandboxes.saveLogin("github", entry, { account, signal }, false, true);
      return end(null);
    }
    end({ ...idle, state: "expired", message: "The GitHub code expired. Try again." });
  } catch (error) {
    if (!signal.aborted) end({ ...idle, state: "error", message: `GitHub signed in, but the login could not be saved for cloud sandboxes: ${error instanceof Error ? error.message : String(error)}` });
  }
}
