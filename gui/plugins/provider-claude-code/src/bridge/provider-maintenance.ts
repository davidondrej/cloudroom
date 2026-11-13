import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type ProviderHealthResult,
  type ProviderInstallationCommand,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  type ProviderUsage,
  type ProviderUsageResult,
  type ProviderUsageWindow,
  experimental_clampPercent as clampPercent,
  experimental_commandOutput as commandOutput,
  experimental_compareVersions as compareVersions,
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_findCliExecutable as findCliExecutable,
  experimental_formatCommand as formatCommand,
  experimental_installationRunUnavailable as installationRunUnavailable,
  experimental_installationVerification as installationVerification,
  experimental_isClaudeNpmPlaceholder as isClaudeNpmPlaceholder,
  experimental_npmCommand as npmCommand,
  experimental_npmGlobalInstallSource as npmGlobalInstallSource,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_readCliVersion as readCliVersion,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_versionFrom as versionFrom,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { fetchWithProxyFallback } from "./proxy-fallback.js";

const execFileAsync = promisify(execFile);
const USAGE_FETCH_TIMEOUT_MS = 15_000;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";
const CLAUDE_INSTALL_SCRIPT_URL = "https://claude.ai/install.sh";
const CLAUDE_POWERSHELL_INSTALL_SCRIPT_URL = "https://claude.ai/install.ps1";
const CLAUDE_NATIVE_RELEASES_URL =
  "https://downloads.claude.ai/claude-code-releases";
const CLAUDE_MINIMUM_SUPPORTED_VERSION = "2.1.280";
const CLAUDE_RENEWS_MESSAGE =
  "Claude renews its sign-in on its next reply. Usage shows after that.";
// bin/claude.exe is Claude Code's own 500-byte placeholder until its
// postinstall (install.cjs) puts the native binary there. npm 12 skips install
// scripts it wasn't told to allow, so `npm install -g` can leave it (#1074).
const CLAUDE_PLACEHOLDER = path.join(CLAUDE_NPM_PACKAGE, "bin", "claude.exe");
const CLAUDE_PLACEHOLDER_MAX_BYTES = 4096;
// The repair plus the probes after it (15 s) fit the bridge's 30 s request.
const CLAUDE_REPAIR_TIMEOUT_MS = 10_000;

const claudeCredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    /** When the short-lived access token ends, not the login. */
    expiresAt: z.number().nullish(),
    // A malformed value must not hide a working login, so it reads as missing.
    refreshToken: z.string().nullish().catch(null),
    refreshTokenExpiresAt: z.number().nullish().catch(null),
    subscriptionType: z.string().nullish(),
    rateLimitTier: z.string().nullish(),
  }),
});
type ClaudeCredentials = z.infer<
  typeof claudeCredentialsSchema
>["claudeAiOauth"];
const endedLoginSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.literal("") }),
});

const claudeAccountSchema = z.object({
  oauthAccount: z
    .object({
      emailAddress: z.string().email().nullish(),
      accountUuid: z.string().uuid().nullish(),
    })
    .nullish(),
});

export function claudeExecutable(): string {
  return (
    process.env.BB_CLAUDE_CODE_EXECUTABLE?.trim() ||
    findCliExecutable("claude") ||
    "claude"
  );
}

// npm's unfinished stub isn't Claude Code: report it missing, so the
// installer offers a working copy (#1148).
async function resolveClaudePath(command: string): Promise<string | null> {
  const resolved = await resolveExecutablePath(command);
  return resolved !== null && isClaudeNpmPlaceholder(resolved)
    ? null
    : resolved;
}

function claudeInstallerCommand(): ProviderInstallationCommand {
  return downloadedInstallerCommand(CLAUDE_INSTALL_SCRIPT_URL, {
    powershellUrl: CLAUDE_POWERSHELL_INSTALL_SCRIPT_URL,
  });
}

// Windows' native installer leaves claude.exe off PATH, so sign in with the
// path we found. The sign-in terminal runs PowerShell: `&` runs a quoted path,
// and a `'` inside single quotes is doubled (C:\Users\O'Brien).
function claudeLoginCommand(command: string): string {
  return process.platform === "win32" && path.win32.isAbsolute(command)
    ? `& '${command.replaceAll("'", "''")}' /login`
    : "claude /login";
}

function claudeDistTags(value: string | null): {
  latest: string;
  stable: string | null;
} | null {
  if (value === null) return null;
  try {
    const parsed = z
      .object({
        latest: z.string().min(1),
        stable: z.string().min(1).optional(),
      })
      .safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    const latest = versionFrom(parsed.data.latest);
    if (latest === null) return null;
    return {
      latest,
      stable:
        parsed.data.stable === undefined
          ? latest
          : versionFrom(parsed.data.stable),
    };
  } catch {
    return null;
  }
}

async function nativeChannelVersion(channel: "latest" | "stable") {
  try {
    const response = await fetchWithProxyFallback((init) =>
      fetch(`${CLAUDE_NATIVE_RELEASES_URL}/${channel}`, {
        ...init,
        signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
      }),
    );
    return response.ok ? versionFrom(await response.text()) : null;
  } catch {
    return null;
  }
}

async function claudeNativeTags(): Promise<{
  latest: string;
  stable: string | null;
} | null> {
  const [latest, stable] = await Promise.all([
    nativeChannelVersion("latest"),
    nativeChannelVersion("stable"),
  ]);
  return latest === null ? null : { latest, stable };
}

function claudeDoctor(value: string | null): {
  installMethod: "native" | "npm-global" | "package-manager" | "unknown" | null;
  updateChannel: "latest" | "stable" | null;
} {
  const running =
    value === null ? null : /^Running:\s+([^\s(]+)/mu.exec(value)?.[1];
  const channel =
    value === null
      ? null
      : /^Auto-update channel:\s+(latest|stable)\s*$/mu.exec(value)?.[1];
  return {
    installMethod:
      running === "native" || running === "npm-global"
        ? running
        : running !== null && running !== undefined
          ? ["homebrew", "winget", "apt", "dnf", "apk"].includes(running)
            ? "package-manager"
            : "unknown"
          : null,
    updateChannel:
      channel === "latest" || channel === "stable" ? channel : null,
  };
}

// Homebrew installs can't run `claude update`, so upgrade the cask that owns the real file.
async function homebrewUpgradeCommand(
  executablePath: string | null,
): Promise<ProviderInstallationCommand | null> {
  if (executablePath === null || process.platform === "win32") return null;
  const realPath = await fs.realpath(executablePath).catch(() => null);
  const match =
    realPath === null
      ? null
      : /^(.*)\/(Caskroom|Cellar)\/([^/]+)\//u.exec(realPath);
  if (match === null) return null;
  const [, prefix = "", kind, name = ""] = match;
  const brew = path.join(prefix, "bin", "brew");
  if (!(await fs.access(brew).then(() => true, () => false))) return null;
  const args =
    kind === "Caskroom" ? ["upgrade", "--cask", name] : ["upgrade", name];
  return { command: brew, args, displayCommand: formatCommand("brew", args) };
}

/** The npm package folder while `command` is still the placeholder, else null. */
async function claudePlaceholder(command: string): Promise<string | null> {
  if (!path.isAbsolute(command)) return null;
  const real = await fs.realpath(command).catch(() => null);
  if (real === null || !real.endsWith(CLAUDE_PLACEHOLDER)) return null;
  const size = (await fs.stat(real).catch(() => null))?.size ?? 0;
  return size < CLAUDE_PLACEHOLDER_MAX_BYTES
    ? path.dirname(path.dirname(real))
    : null;
}

/** Runs the package's postinstall, as npm would have. True if still a placeholder. */
async function repairClaudePlaceholder(command: string): Promise<boolean> {
  const packageDir = await claudePlaceholder(command);
  if (packageDir === null) return false;
  // The bridge's own Node: Cloudroom's Electron when packaged.
  await execFileAsync(process.execPath, ["install.cjs"], {
    cwd: packageDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: CLAUDE_REPAIR_TIMEOUT_MS,
  }).catch(() => {});
  return (await claudePlaceholder(command)) !== null;
}

async function claudeInstallation(): Promise<{
  status: ProviderInstallationStatus;
  update: ProviderInstallationCommand | null;
}> {
  const command = claudeExecutable();
  const placeholder = await repairClaudePlaceholder(command);
  const [
    resolvedExecutable,
    versionOutput,
    tagsOutput,
    npmGlobal,
    doctorOutput,
    nativeTags,
  ] = await Promise.all([
    resolveClaudePath(command),
    commandOutput(command, ["--version"]),
    commandOutput(npmCommand(), [
      "view",
      CLAUDE_NPM_PACKAGE,
      "dist-tags",
      "--json",
    ]),
    probeNpmGlobalPackage(CLAUDE_NPM_PACKAGE),
    commandOutput(command, ["doctor"]),
    claudeNativeTags(),
  ]);
  const installed =
    !placeholder && (resolvedExecutable !== null || versionOutput !== null);
  const currentVersion = versionFrom(versionOutput);
  const doctor = claudeDoctor(doctorOutput);
  const homebrew = await homebrewUpgradeCommand(resolvedExecutable);
  // A cask follows its own channel: claude-code is stable, claude-code@latest is latest.
  const updateChannel =
    homebrew === null
      ? doctor.updateChannel
      : homebrew.args.at(-1)?.endsWith("@latest")
        ? "latest"
        : "stable";
  const tags =
    homebrew === null && doctor.installMethod === "native"
      ? nativeTags
      : claudeDistTags(tagsOutput);
  const latestVersion =
    updateChannel === null || tags === null ? null : tags[updateChannel];
  const definitelyNeedsUnknownChannelUpdate =
    installed &&
    currentVersion !== null &&
    tags?.stable !== null &&
    tags?.stable !== undefined &&
    compareVersions(tags.latest, currentVersion) > 0 &&
    compareVersions(tags.stable, currentVersion) > 0;
  const needsUpdate =
    installed && currentVersion !== null && latestVersion !== null
      ? compareVersions(latestVersion, currentVersion) > 0
      : definitelyNeedsUnknownChannelUpdate;
  // Claude's own updater handles native, npm, and unknown installs. Other
  // package managers (winget, apt, dnf, apk) need the user, often with sudo.
  const update =
    homebrew ??
    (doctor.installMethod === "package-manager"
      ? null
      : {
          command,
          args: ["update"],
          displayCommand: formatCommand(command, ["update"]),
        });
  const versionUnsupported =
    update !== null &&
    currentVersion !== null &&
    compareVersions(currentVersion, CLAUDE_MINIMUM_SUPPORTED_VERSION) < 0 &&
    (latestVersion === null
      ? updateChannel !== "stable"
      : compareVersions(latestVersion, CLAUDE_MINIMUM_SUPPORTED_VERSION) >= 0);
  const actionKind = !installed
    ? "install"
    : (needsUpdate || versionUnsupported) && update !== null
      ? "update"
      : null;
  return {
    update,
    status: {
      executableName: command,
      executablePath: resolvedExecutable,
      installed,
      installSource: npmGlobalInstallSource({
        installed,
        executablePath: resolvedExecutable,
        npmBin: npmGlobal.npmBin,
      }),
      currentVersion,
      latestVersion,
      minimumSupportedVersion: CLAUDE_MINIMUM_SUPPORTED_VERSION,
      npmPackageName: CLAUDE_NPM_PACKAGE,
      npmGlobalPackageVersion: npmGlobal.npmGlobalPackageVersion,
      installAction:
        actionKind === null
          ? null
          : {
              kind: actionKind,
              label: actionKind === "install" ? "Install" : "Update",
              command:
                actionKind === "install"
                  ? claudeInstallerCommand().displayCommand
                  : (update?.displayCommand ?? ""),
            },
      needsUpdate,
      versionUnsupported,
    },
  };
}

export async function getClaudeProviderInstallationStatus(): Promise<ProviderInstallationStatus> {
  return (await claudeInstallation()).status;
}

export async function getClaudeProviderInstallationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const { status, update } = await claudeInstallation();
  return buildClaudeProviderInstallationRun(status, action, update);
}

function buildClaudeProviderInstallationRun(
  status: ProviderInstallationStatus,
  action: "install" | "update",
  update: ProviderInstallationCommand | null = null,
): ProviderInstallationRunResult {
  const command = action === "install" ? claudeInstallerCommand() : update;
  if (status.installAction?.kind !== action || command === null) {
    return installationRunUnavailable("Claude Code", action, status);
  }
  return {
    available: true,
    command,
    verification: installationVerification(status, action),
  };
}

async function readKeychainCredentials(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const argumentSets = [
    [
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-a",
      os.userInfo().username,
      "-w",
    ],
    ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
  ];
  for (const args of argumentSets) {
    try {
      const { stdout } = await execFileAsync("security", args, {
        timeout: 10_000,
      });
      if (stdout.trim()) return stdout.trim();
    } catch {}
  }
  return null;
}

/** The saved login, null when Claude Code ended it, or undefined when `raw` holds no Claude login. */
function parseCredentials(raw: string): ClaudeCredentials | null | undefined {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  if (/^(?:[0-9a-f]{2})+$/iu.test(trimmed)) {
    candidates.push(Buffer.from(trimmed, "hex").toString("utf8"));
  }
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      const parsed = claudeCredentialsSchema.safeParse(value);
      // A login Claude Code can't renew keeps its tokens as "" (2.1.318).
      if (parsed.success)
        return parsed.data.claudeAiOauth.refreshToken === ""
          ? null
          : parsed.data.claudeAiOauth;
      if (endedLoginSchema.safeParse(value).success) return null;
    } catch {}
  }
  return undefined;
}

async function readCredentials(): Promise<ClaudeCredentials | null> {
  const keychainCredentials = await readKeychainCredentials();
  // Claude Code reads its Keychain item first, so a login it ended there must not come back from an old file.
  const saved =
    keychainCredentials === null
      ? undefined
      : parseCredentials(keychainCredentials);
  if (saved !== undefined) return saved;
  try {
    return (
      parseCredentials(
        await fs.readFile(
          path.join(os.homedir(), ".claude", ".credentials.json"),
          "utf8",
        ),
      ) ?? null
    );
  } catch {
    return null;
  }
}

async function readAccount() {
  try {
    const parsed = claudeAccountSchema.safeParse(
      JSON.parse(
        await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8"),
      ),
    );
    return parsed.success ? (parsed.data.oauthAccount ?? null) : null;
  } catch {
    return null;
  }
}

async function readAccountEmail(): Promise<string | null> {
  return (await readAccount())?.emailAddress ?? null;
}

// Anthropic renamed Max 5x to Max and Max 20x to Ultra on 2026-10-30.
function planLabel(credentials: ClaudeCredentials): string | null {
  if (credentials.rateLimitTier?.endsWith("max_20x")) return "Ultra";
  if (credentials.rateLimitTier?.endsWith("max_5x")) return "Max";
  const subscription = credentials.subscriptionType;
  return subscription
    ? subscription.charAt(0).toUpperCase() + subscription.slice(1)
    : null;
}

/** Claude Code renews an expired access token itself while the refresh token lasts. Older versions store no end for it. */
function canRenew(credentials: ClaudeCredentials, now = Date.now()): boolean {
  return (
    Boolean(credentials.refreshToken) &&
    (credentials.refreshTokenExpiresAt == null ||
      now < credentials.refreshTokenExpiresAt)
  );
}

/**
 * Claude Code's own sign-in check (2.1.318): a login is expired only when Claude Code can't renew it. Claude Code
 * renews 5 minutes early, but the access token works until `expiresAt`. Cloudroom never renews or writes Claude's tokens.
 */
function loginState(
  credentials: ClaudeCredentials,
  now = Date.now(),
): "valid" | "renewable" | "expired" {
  if (credentials.expiresAt == null || now < credentials.expiresAt)
    return "valid";
  return canRenew(credentials, now) ? "renewable" : "expired";
}

function healthResult(
  command: string,
  status: "ready" | "not_installed" | "unauthenticated" | "expired" | "unknown",
  args: {
    accountEmail?: string | null;
    planLabel?: string | null;
    installedVersion?: string | null;
    statusMessage?: string | null;
  } = {},
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: args.accountEmail ?? null,
      planLabel: args.planLabel ?? null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: null,
      canInstall: true,
      canUpdate: status !== "not_installed",
      loginCommand: claudeLoginCommand(command),
    },
  };
}

export async function getClaudeProviderHealth(): Promise<ProviderHealthResult> {
  const command = claudeExecutable();
  if ((await resolveClaudePath(command)) === null) {
    return healthResult(command, "not_installed");
  }
  const version = await readCliVersion(command);
  try {
    const [credentials, email] = await Promise.all([
      readCredentials(),
      readAccountEmail(),
    ]);
    if (!credentials) {
      return healthResult(command, "unauthenticated", {
        installedVersion: version,
      });
    }
    const known = {
      accountEmail: email,
      planLabel: planLabel(credentials),
      installedVersion: version,
    };
    return loginState(credentials) === "expired"
      ? healthResult(command, "expired", known)
      : healthResult(command, "ready", known);
  } catch (error) {
    return healthResult(command, "unknown", {
      installedVersion: version,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

const claudeUsageWindowSchema = z.object({
  utilization: z.number().nullish(),
  resets_at: z.string().nullish(),
});

const claudeScopedUsageLimitSchema = z
  .object({
    kind: z.string(),
    scope: z
      .object({
        model: z
          .object({ display_name: z.string().trim().min(1).nullish() })
          .nullish(),
        surface: z.null().optional(),
      })
      .nullish(),
    percent: z.number().nullish(),
    resets_at: z.string().nullish(),
  })
  .passthrough();

const claudeUsageResponseSchema = z
  .object({
    five_hour: claudeUsageWindowSchema.nullish(),
    seven_day: claudeUsageWindowSchema.nullish(),
    limits: z
      .array(claudeScopedUsageLimitSchema.nullable().catch(null))
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
  })
  .passthrough();

function usageCredits(
  usage: z.infer<typeof claudeUsageResponseSchema>,
): { detail: string | null } | null {
  const extra = usage.extra_usage;
  const limited = [
    usage.five_hour?.utilization,
    usage.seven_day?.utilization,
    ...(usage.limits ?? []).map((limit) => limit?.percent),
  ].some((used) => used != null && used >= 100);
  if (!extra?.is_enabled || !limited) return null;
  const money = (cents: number) =>
    extra.currency
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: extra.currency,
        }).format(cents / 100)
      : (cents / 100).toFixed(2);
  if (extra.used_credits == null) return { detail: null };
  return {
    detail:
      extra.monthly_limit == null
        ? `${money(extra.used_credits)} spent`
        : `${money(extra.used_credits)} / ${money(extra.monthly_limit)}`,
  };
}

function resetIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function usageWindow(
  value: z.infer<typeof claudeUsageWindowSchema> | null | undefined,
  label: string,
  kind: "five-hour" | "weekly",
): ProviderUsageWindow | null {
  if (!value || value.utilization == null) return null;
  return {
    label,
    kind,
    usedPercent: clampPercent(value.utilization),
    resetsAt: resetIso(value.resets_at),
  };
}

function scopedWindows(
  limits:
    | (z.infer<typeof claudeScopedUsageLimitSchema> | null)[]
    | null
    | undefined,
): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  const seen = new Set<string>();
  for (const limit of limits ?? []) {
    const label = limit?.scope?.model?.display_name;
    if (
      limit == null ||
      limit.kind !== "weekly_scoped" ||
      label == null ||
      limit.percent == null ||
      seen.has(label.toLowerCase())
    ) {
      continue;
    }
    seen.add(label.toLowerCase());
    windows.push({
      kind: "weekly",
      model: label.toLowerCase(),
      label,
      usedPercent: clampPercent(limit.percent),
      resetsAt: resetIso(limit.resets_at),
    });
  }
  return windows;
}

function normalizeUsage(
  raw: unknown,
  credentials: ClaudeCredentials,
  email: string | null,
): ProviderUsage {
  const parsed = claudeUsageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Claude usage response was malformed.",
      planLabel: planLabel(credentials),
      accountEmail: email,
    };
  }
  const windows = [
    usageWindow(parsed.data.five_hour, "Current session", "five-hour"),
    usageWindow(parsed.data.seven_day, "Weekly limit", "weekly"),
    ...scopedWindows(parsed.data.limits),
  ].filter((window): window is ProviderUsageWindow => window !== null);
  return {
    status: "ok",
    accountEmail: email,
    planLabel: planLabel(credentials),
    credits: usageCredits(parsed.data),
    plan: credentials.subscriptionType
      ? {
          id: credentials.subscriptionType.toLowerCase(),
          multiplier:
            Number(credentials.rateLimitTier?.match(/max_(\d+)x/u)?.[1]) ||
            null,
        }
      : null,
    windows,
  };
}

export async function getClaudeProviderUsage(): Promise<ProviderUsageResult> {
  const command = claudeExecutable();
  if ((await resolveClaudePath(command)) === null) {
    return { supported: true, usage: { status: "not_installed" } };
  }
  const [credentials, account] = await Promise.all([
    readCredentials(),
    readAccount(),
  ]);
  const email = account?.emailAddress ?? null;
  if (!credentials) {
    return { supported: true, usage: { status: "unauthenticated" } };
  }
  const expired: ProviderUsageResult = {
    supported: true,
    usage: { status: "expired" },
  };
  const login = loginState(credentials);
  if (login === "expired") return expired;
  const known = { planLabel: planLabel(credentials), accountEmail: email };
  // Until Claude Code renews it, the saved access token gets 401.
  const renewing: ProviderUsageResult = {
    supported: true,
    usage: { status: "error", message: CLAUDE_RENEWS_MESSAGE, ...known },
  };
  if (login === "renewable") return renewing;
  try {
    const response = await fetchWithProxyFallback((init) =>
      fetch(CLAUDE_USAGE_URL, {
        ...init,
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.0",
        },
        signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
      }),
    );
    // Claude Code answers a 401 by renewing, so only a login it can't renew is expired.
    if (response.status === 401)
      return canRenew(credentials) ? renewing : expired;
    if (!response.ok) {
      return {
        supported: true,
        usage: {
          status: "error",
          message:
            response.status === 429
              ? "Anthropic temporarily throttled this usage check. This does not mean your Claude limit is exhausted. Try again later."
              : `Claude usage request failed (HTTP ${response.status}).`,
          ...known,
        },
      };
    }
    return {
      supported: true,
      usage: {
        ...normalizeUsage(await response.json(), credentials, email),
        accountKey: account?.accountUuid
          ? `anthropic:account:${account.accountUuid}`
          : null,
      },
    };
  } catch (error) {
    return {
      supported: true,
      usage: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        ...known,
      },
    };
  }
}

export const __testing = {
  buildProviderInstallationRun: buildClaudeProviderInstallationRun,
  normalizeUsage,
};
