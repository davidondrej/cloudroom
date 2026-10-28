import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import type { CodexAuthStatus } from "./client.js";
import { cloudroom } from "./commands.js";
import { githubAccountSchema, macGithubToken, sandboxGithubLogin, type GithubAccount, type SandboxAccount } from "./sandboxes.js";
import { copyMacGithub, setCopyMacGithub } from "./sync.js";

// The public Client ID of Cloudroom's GitHub OAuth App, with Device Flow enabled. Sign-in stays off until it is set.
const GITHUB_OAUTH_CLIENT_ID = "Ov23li9OTKaEYO6RAHos";
// Sandboxes run `gh auth login --with-token`, which rejects tokens without read:org.
const SCOPE = "repo read:org workflow";
const idle: CodexAuthStatus = { state: "missing", email: null, plan: null, message: null, login_id: null, verification_url: null, user_code: null };
const codeSchema = z.object({ device_code: z.string().min(1).max(256), user_code: z.string().regex(/^[A-Z0-9-]{1,32}$/), verification_uri: z.string().startsWith("https://github.com/"), expires_in: z.number().positive(), interval: z.number().positive() });

type Login = { id: string; abort: AbortController; status: CodexAuthStatus | null };
let login: Login | null = null;
let failure: CodexAuthStatus | null = null;

async function github(path: string, form: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`https://github.com/${path}`, {
    method: "POST", redirect: "error", headers: { Accept: "application/json" },
    body: new URLSearchParams({ client_id: GITHUB_OAUTH_CLIENT_ID, ...form }), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  return z.record(z.string(), z.unknown()).parse(await response.json());
}

const reason = (value: Record<string, unknown> | null) => typeof value?.error === "string" && /^[a-z_]{1,64}$/.test(value.error) ? ` (${value.error})` : "";

export function cancelGithubLogin(): void {
  login?.abort.abort();
  login = null;
  failure = null;
}

/** GitHub's device flow for cloud sandboxes, for Macs without `gh`. The token goes to the website only, like a copied `gh` login. */
export async function githubAuth(deps: AppDeps, action?: "login" | "cancel", requestId = ""): Promise<CodexAuthStatus> {
  if (action === "login") return start(deps, requestId);
  if (action === "cancel" && login?.id === requestId) cancelGithubLogin();
  if (login?.status) return login.status;
  if (await macGithub(deps)) return { ...idle, state: "connected" };
  const logins = await cloudroom(deps).sandboxes.logins().catch((error: unknown) => {
    throw new ApiError(503, "github_auth_unavailable", error instanceof Error ? error.message : String(error));
  });
  return logins.github ? { ...idle, state: "connected" } : failure ?? idle;
}

/** This Mac's `gh` token while it is the one copied to cloud sandboxes, else "". */
const macGithub = async (deps: AppDeps) => await copyMacGithub(deps) ? macGithubToken() : "";

/** The GitHub account cloud sandboxes use, or null when it can't be told. */
export async function githubAccount(deps: AppDeps): Promise<GithubAccount | null> {
  const token = await macGithub(deps);
  if (!token) return cloudroom(deps).sandboxes.githubAccount().catch(() => null);
  const response = await fetch("https://api.github.com/user", {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const user = response?.ok ? z.object({ login: z.string(), name: z.string().nullable(), avatar_url: z.string().nullable() }).safeParse(await response.json()) : null;
  return user?.success ? githubAccountSchema.parse({ login: user.data.login, name: user.data.name, avatarUrl: user.data.avatar_url }) : null;
}

/** Removes the GitHub login from cloud sandboxes and stops copying this Mac's `gh` login. */
export async function disconnectGithub(deps: AppDeps): Promise<void> {
  cancelGithubLogin();
  // Stop the copy first, so it can't put the login back right after the removal.
  const mac = await copyMacGithub(deps);
  await setCopyMacGithub(deps, false);
  await cloudroom(deps).sandboxes.removeGithubLogin().catch(async (error: unknown) => {
    await setCopyMacGithub(deps, mac);
    throw new ApiError(503, "github_auth_unavailable", error instanceof Error ? error.message : String(error));
  });
}

async function start(deps: AppDeps, requestId: string): Promise<CodexAuthStatus> {
  if (GITHUB_OAUTH_CLIENT_ID.startsWith("REPLACE_WITH")) throw new ApiError(409, "github_auth_unsupported", "Connecting GitHub is not set up in this version of Cloudroom yet.");
  const account = await cloudroom(deps).sandboxes.account();
  if (!account) throw new ApiError(409, "github_auth_unavailable", "Sign in to Cloudroom first.");
  if (login?.id === requestId && login.status) return login.status;
  cancelGithubLogin();
  const current: Login = { id: requestId, abort: new AbortController(), status: null };
  login = current;
  let value: Record<string, unknown> | null = null;
  try {
    value = await github("login/device/code", { scope: SCOPE }, current.abort.signal);
    const code = codeSchema.parse(value);
    current.status = { ...idle, state: "waiting", login_id: requestId, verification_url: code.verification_uri, user_code: code.user_code };
    void poll(deps, current, account, code.device_code, code.interval, Date.now() + code.expires_in * 1000);
    return current.status;
  } catch {
    if (login === current) login = null;
    if (current.abort.signal.aborted) throw new ApiError(409, "github_auth_cancelled", "GitHub sign-in was cancelled.");
    throw new ApiError(503, "github_auth_unavailable", `GitHub sign-in could not start${reason(value)}. Try again.`);
  }
}

async function poll(deps: AppDeps, current: Login, account: SandboxAccount, deviceCode: string, interval: number, deadline: number): Promise<void> {
  const signal = current.abort.signal;
  const end = (status: CodexAuthStatus | null) => { if (login === current) { login = null; failure = status; } };
  try {
    while (Date.now() < deadline) {
      await sleep(interval * 1000, undefined, { signal, ref: false });
      // A network blip only skips one check; the code stays valid until its deadline.
      const value = await github("login/oauth/access_token", { device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }, signal).catch(() => null);
      if (signal.aborted) return;
      if (!value || value.error === "authorization_pending") continue;
      if (value.error === "slow_down") { interval = Math.max(interval + 5, Number(value.interval) || 0); continue; }
      if (value.error === "expired_token") break;
      const token = typeof value.access_token === "string" && /^[\x21-\x7e]{1,4096}$/.test(value.access_token) ? value.access_token : null;
      if (!token) return end({ ...idle, state: "error", message: value.error === "access_denied" ? "GitHub sign-in was declined." : `GitHub sign-in failed${reason(value)}. Try again.` });
      const entry = await sandboxGithubLogin(token);
      signal.throwIfAborted();
      // The account the user just picked wins over this Mac's `gh` login from now on.
      await setCopyMacGithub(deps, false);
      await cloudroom(deps).sandboxes.saveLogin("github", entry, { account, signal });
      return end(null);
    }
    end({ ...idle, state: "expired", message: "The GitHub code expired. Try again." });
  } catch (error) {
    if (!signal.aborted) end({ ...idle, state: "error", message: `GitHub signed in, but the login could not be saved for cloud sandboxes: ${error instanceof Error ? error.message : String(error)}` });
  }
}
