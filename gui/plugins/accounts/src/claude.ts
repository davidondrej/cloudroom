import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PluginClaudeSetupTokenRun } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  execPortableFile,
  findCliExecutable,
  killPortableProcess,
  spawnPortableProcess,
} from "@cloudroom/process-utils";
import {
  NO_TERMINAL,
  readClaudeToken,
  readOpenedUrl,
  spawnInTerminal,
  writeBrowserOpener,
} from "@cloudroom/process-utils/claude-token";
import type { UsageWindow } from "./contract.js";
import { readReset, SignInAgainError, type Secret } from "./tokens.js";

const YEAR_MS = 365 * 24 * 60 * 60_000;
const LIMITS = "anthropic-ratelimit-unified";
const windows = process.platform === "win32";

function claudeBinary(): string | null {
  if (windows) return findCliExecutable("claude");
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    const binary = path.join(dir, "claude");
    try {
      accessSync(binary, constants.X_OK);
      return binary;
    } catch {}
  }
  return null;
}

// A stray token or API key would win over the account's own login. No profile means the Mac's own login.
export function profileEnv(profile?: string): NodeJS.ProcessEnv {
  if (profile !== undefined && !path.isAbsolute(profile))
    throw new Error("Claude profile folder must be absolute.");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(profile ? { CLAUDE_CONFIG_DIR: profile } : {}),
  };
  for (const key of [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_SUBSCRIPTION_TYPE",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  ])
    delete env[key];
  return env;
}

interface Run {
  url: string | null;
  result: string | null;
  error: string | null;
  stop: () => void;
}

function windowsLogin(binary: string, profile: string): Run {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cloudroom-claude-"));
  const browser = writeBrowserOpener(dir);
  const child = spawnPortableProcess({
    command: binary,
    args: ["auth", "login", "--claudeai"],
    env: { ...profileEnv(profile), BROWSER: browser },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const run: Run = { url: null, result: null, error: null, stop: () => {} };
  let done = false;
  const finish = (error: string | null) => {
    if (run.result === null) run.error ??= error;
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(poll);
    void killPortableProcess(child, "SIGKILL").finally(() =>
      rmSync(dir, { recursive: true, force: true }),
    );
  };
  run.stop = () => finish("Claude sign-in was cancelled.");
  const timer = setTimeout(
    () => finish("Claude sign-in timed out. Try again."),
    10 * 60_000,
  );
  const poll = setInterval(() => {
    run.url ??= readOpenedUrl(dir);
  }, 250);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-65536);
  });
  child.on("error", () => finish("Could not start Claude Code."));
  child.on("close", (code) => {
    if (code === 0 || output.includes("Login successful"))
      run.result ??= profile;
    finish("Claude sign-in did not finish. Try again.");
  });
  return run;
}

export class ClaudeLogin {
  private readonly runs = new Map<string, Run>();

  constructor(
    private readonly setupToken: () =>
      | PluginClaudeSetupTokenRun
      | undefined = () => undefined,
  ) {}

  private windowsToken(): Run {
    const token = this.setupToken();
    if (!token) throw new Error("Update Cloudroom, then try again.");
    return {
      get url() {
        return token.url;
      },
      get result() {
        return token.token;
      },
      get error() {
        return token.error;
      },
      stop: () => token.stop(),
    };
  }

  private async startWindows(
    binary: string,
    profile?: string,
  ): Promise<{ sessionId: string; authorizeUrl: string }> {
    const run = profile ? windowsLogin(binary, profile) : this.windowsToken();
    const sessionId = randomUUID();
    this.runs.set(sessionId, run);
    for (
      let waited = 0;
      !run.url && !run.error && waited < 15_000;
      waited += 250
    )
      await new Promise((resolve) => setTimeout(resolve, 250));
    if (run.url) return { sessionId, authorizeUrl: run.url };
    const error = run.error ?? "Claude did not open its sign-in page.";
    run.stop();
    this.runs.delete(sessionId);
    throw new Error(error);
  }

  async start(
    profile?: string,
  ): Promise<{ sessionId: string; authorizeUrl: string }> {
    const binary = claudeBinary();
    if (!binary)
      throw new Error("Install Claude Code on this computer, then try again.");
    if (windows) return this.startWindows(binary, profile);
    const dir = mkdtempSync(path.join(os.tmpdir(), "cloudroom-claude-"));
    const browser = path.join(dir, "open");
    writeFileSync(browser, `#!/bin/sh\nprintf '%s' "$1" > "$0.url"\n`, {
      mode: 0o700,
    });
    const command = `stty cols 1000; exec "$CLAUDE_BIN" ${profile ? "auth login --claudeai" : "setup-token"}`;
    const child = spawnInTerminal(command, {
      ...(profile ? profileEnv(profile) : process.env),
      CLAUDE_BIN: binary,
      BROWSER: browser,
    });
    if (!child) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(NO_TERMINAL);
    }
    const sessionId = randomUUID();
    const run: Run = { url: null, result: null, error: null, stop: () => {} };
    const finish = (error: string | null) => {
      if (run.result === null) run.error ??= error;
      clearTimeout(timer);
      try {
        process.kill(-child.pid!);
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    };
    run.stop = () => finish("Claude sign-in was cancelled.");
    const timer = setTimeout(
      () => finish("Claude sign-in timed out. Try again."),
      10 * 60_000,
    );
    let output = "";
    let signedIn = false;
    child.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-65536);
      if (profile) {
        signedIn ||= output.includes("Login successful");
        return;
      }
      const token = readClaudeToken(output);
      if (token && run.result === null) {
        run.result = token;
        finish(null);
      }
    });
    child.on("error", () => finish("Could not start Claude Code."));
    child.on("close", () => {
      if (profile && signedIn) run.result ??= profile;
      finish("Claude sign-in did not finish. Try again.");
    });
    this.runs.set(sessionId, run);
    for (
      let waited = 0;
      !run.url && !run.error && waited < 15_000;
      waited += 250
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        run.url = readFileSync(`${browser}.url`, "utf8").trim() || null;
      } catch {}
    }
    if (!run.url) {
      run.stop();
      throw new Error(run.error ?? "Claude did not open its sign-in page.");
    }
    return { sessionId, authorizeUrl: run.url };
  }

  poll(sessionId: string): string | null {
    const run = this.runs.get(sessionId);
    if (!run) throw new Error("This sign-in expired. Start again.");
    if (run.result) {
      this.runs.delete(sessionId);
      return run.result;
    }
    if (run.error) {
      this.runs.delete(sessionId);
      throw new Error(run.error);
    }
    return null;
  }
}

export const claudeSecret = (token: string) => ({
  accessToken: token,
  refreshToken: "",
  expiresAt: Date.now() + YEAR_MS,
});

type ClaudeUsage = {
  windows: UsageWindow[];
  credits: { detail: string | null } | null;
};

const usageWindowSchema = z
  .object({ utilization: z.number().nullish(), resets_at: z.string().nullish() })
  .nullish();
const usageSchema = z.object({
  five_hour: usageWindowSchema,
  seven_day: usageWindowSchema,
  limits: z
    .array(
      z
        .object({
          kind: z.string(),
          scope: z
            .object({
              model: z.object({ display_name: z.string().nullish() }).nullish(),
              surface: z.null().optional(),
            })
            .nullish(),
          percent: z.number().nullish(),
          resets_at: z.string().nullish(),
        })
        .nullable()
        .catch(null),
    )
    .nullish()
    .catch([]),
  extra_usage: z
    .object({
      is_enabled: z.boolean().nullish(),
      monthly_limit: z.number().nullish(),
      used_credits: z.number().nullish(),
      currency: z.string().length(3).nullish(),
    })
    .nullish()
    .catch(null),
});

const loginSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullish(),
  }),
});

// A Keychain read that failed may have shown a macOS popup (a timeout, Deny, a locked Keychain).
// It is not tried again until the app restarts, so the popup can't come back every few minutes.
const keychainFailed = new Set<string>();

async function keychainLogin(profile: string): Promise<string> {
  if (process.platform !== "darwin" || keychainFailed.has(profile)) return "";
  const folder = createHash("sha256")
    .update(profile.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  const text = await promisify(execFile)(
    "security",
    ["find-generic-password", "-s", `Claude Code-credentials-${folder}`, "-w"],
    { timeout: 10_000 },
  ).then(
    ({ stdout }) => stdout.trim(),
    () => {
      keychainFailed.add(profile);
      return "";
    },
  );
  // `security` prints a value with special characters as hex.
  return /^(?:[0-9a-f]{2})+$/iu.test(text)
    ? Buffer.from(text, "hex").toString("utf8")
    : text;
}

// Claude Code keeps a profile's full login in the Keychain on macOS, in an entry named after the folder.
// Elsewhere, or when the Keychain has none, it is a file in the folder. Null when it can't be read or has expired.
async function profileToken(profile: string): Promise<string | null> {
  const file = () =>
    fs.readFile(path.join(profile, ".credentials.json"), "utf8").catch(() => "");
  for (const read of [() => keychainLogin(profile), file]) {
    const login = loginSchema.safeParse(
      await read().then(JSON.parse).catch(() => null),
    ).data?.claudeAiOauth;
    if (login)
      return login.expiresAt != null && Date.now() >= login.expiresAt
        ? null
        : login.accessToken;
  }
  return null;
}

// A full login reads Claude's usage page data: no reply is used, and each model's weekly limit (Fable) shows too.
// Null when the login can't be read, has expired, or is rejected; Claude Code renews it on the account's next turn.
// A short error (429, 5xx, a timeout) throws.
async function profileUsage(profile: string): Promise<ClaudeUsage | null> {
  const token = await profileToken(profile);
  if (!token) return null;
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-code/2.1.0",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) return null;
    throw new Error(`Claude usage failed (HTTP ${response.status}).`);
  }
  const usage = usageSchema.parse(await response.json());
  const windows: UsageWindow[] = [];
  const add = (
    label: string,
    used: number | null | undefined,
    resets: string | null | undefined,
    model?: string,
  ) => {
    if (used == null || windows.some((window) => window.label === label)) return;
    windows.push({
      label,
      usedPercent: Math.min(100, Math.max(0, used)),
      resetsAt: readReset(resets),
      ...(model ? { model } : {}),
    });
  };
  add("Five-hour limit", usage.five_hour?.utilization, usage.five_hour?.resets_at);
  add("Weekly limit", usage.seven_day?.utilization, usage.seven_day?.resets_at);
  for (const limit of usage.limits ?? []) {
    const model = limit?.scope?.model?.display_name?.trim().toLowerCase();
    if (!limit || limit.kind !== "weekly_scoped" || !model) continue;
    // The usage box shows "Weekly · Fable" as "7d fable".
    add(
      `Weekly · ${model.charAt(0).toUpperCase()}${model.slice(1)}`,
      limit.percent,
      limit.resets_at,
      model,
    );
  }
  if (windows.length === 0) return null;
  const extra = usage.extra_usage;
  const limited = [
    usage.five_hour?.utilization,
    usage.seven_day?.utilization,
    ...(usage.limits ?? []).map((limit) => limit?.percent),
  ].some((used) => used != null && used >= 100);
  if (!extra?.is_enabled || !limited) return { windows, credits: null };
  const money = (cents: number) =>
    extra.currency
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: extra.currency,
        }).format(cents / 100)
      : (cents / 100).toFixed(2);
  return {
    windows,
    credits: {
      detail:
        extra.used_credits == null
          ? null
          : extra.monthly_limit == null
            ? `${money(extra.used_credits)} spent`
            : `${money(extra.used_credits)} / ${money(extra.monthly_limit)}`,
    },
  };
}

// One-year setup tokens can't read /api/oauth/usage (it needs user:profile),
// but every Claude reply carries the account's limits in its headers, even a 429.
// OAuth replies need the Claude Code system prompt, or Anthropic answers 429.
// An account with a full login (`profile`) reads /api/oauth/usage first.
// A short error there keeps the last bars (`previous`): this check would drop each model's row.
export async function claudeUsage(
  secret: Secret,
  profile?: string,
  previous?: ClaudeUsage,
): Promise<ClaudeUsage> {
  const full = profile
    ? await profileUsage(profile).catch(() => previous ?? null)
    : null;
  if (full) return full;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (response.status === 401)
    throw new SignInAgainError("Claude rejected this login. Sign in again.");
  const windows = (
    [
      ["Five-hour limit", "5h"],
      ["Weekly limit", "7d"],
    ] as const
  ).flatMap(([label, key]) => {
    const used = response.headers.get(`${LIMITS}-${key}-utilization`);
    if (used === null || !Number.isFinite(Number(used))) return [];
    return [
      {
        label,
        usedPercent: Number(used) * 100,
        resetsAt: readReset(response.headers.get(`${LIMITS}-${key}-reset`)),
      },
    ];
  });
  if (windows.length === 0)
    throw new Error(`Claude usage failed (HTTP ${response.status}).`);
  const overage = response.headers.get(`${LIMITS}-overage-status`);
  const credits =
    response.headers.get(`${LIMITS}-overage-in-use`) === "true" ||
    ((overage === "allowed" || overage === "allowed_warning") &&
      (response.headers.get(`${LIMITS}-status`) === "rejected" ||
        windows.some((window) => window.usedPercent >= 100)));
  return { windows, credits: credits ? { detail: null } : null };
}

export type MacClaude = { email: string; org: string | null };

/** The Mac's own Claude login: null when signed out, undefined when Claude is mid-write and the file can't be read. */
export async function localClaudeAccount(): Promise<
  MacClaude | null | undefined
> {
  let text: string;
  try {
    text = await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const login = z
      .object({
        oauthAccount: z.object({
          emailAddress: z.string(),
          organizationUuid: z.string().nullish(),
        }),
      })
      .safeParse(JSON.parse(text));
    return login.success
      ? {
          email: login.data.oauthAccount.emailAddress,
          org: login.data.oauthAccount.organizationUuid ?? null,
        }
      : null;
  } catch {
    return undefined;
  }
}

const execClaude = (binary: string, args: string[], profile?: string) =>
  windows
    ? execPortableFile(binary, args, {
        env: profileEnv(profile),
        timeoutMs: 30_000,
      })
    : promisify(execFile)(binary, args, {
        env: profileEnv(profile),
        timeout: 30_000,
      });

export async function profileAccount(profile?: string) {
  const binary = claudeBinary();
  if (!binary) throw new Error("Install Claude Code on this computer, then try again.");
  const { stdout } = await execClaude(
    binary,
    ["auth", "status", "--json"],
    profile,
  );
  const status = z
    .object({
      loggedIn: z.literal(true),
      email: z.string().nullish(),
      orgId: z.string().nullish(),
      subscriptionType: z.string().nullish(),
      planTier: z.string().nullish(),
    })
    .parse(JSON.parse(stdout));
  return {
    email: status.email ?? null,
    orgId: status.orgId ?? null,
    plan: status.subscriptionType ?? null,
    tier: status.planTier ?? null,
  };
}

// Anthropic renamed Max 5x to Max and Max 20x to Ultra on 2026-10-30. Claude Code still calls both "max";
// only its plan tier (`max_5x`, `max_20x`) tells them apart.
export function claudePlanName(plan: string | null, tier?: string | null) {
  if (tier === "max_20x") return "Ultra";
  if (tier === "max_5x") return "Max";
  return plan && plan.charAt(0).toUpperCase() + plan.slice(1);
}

export async function signOut(profile: string): Promise<void> {
  const binary = claudeBinary();
  if (binary)
    await execClaude(binary, ["auth", "logout"], profile).catch(() => {});
}

// Every Anthropic reply names the token's organization. Listing models uses no usage.
export async function tokenOrganization(token: string): Promise<string | null> {
  const response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (response.status === 401)
    throw new SignInAgainError("Claude rejected this login. Sign in again.");
  return response.headers.get("anthropic-organization-id");
}
