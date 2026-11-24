import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type {
  ProviderHealthResult,
  ProviderInstallationCommand,
  ProviderInstallationRunResult,
  ProviderInstallationStatus,
  ProviderUsage,
  ProviderUsageResult,
  ProviderUsageWindow,
} from "@cloudroom/provider-bridge-protocol";
import {
  clampPercent,
  compareVersions,
  downloadedInstallerCommand,
  formatCommand,
  installationRunUnavailable,
  npmGlobalInstallCommand,
  probeCliVersion,
  resolveExecutablePath,
  versionFrom,
} from "@cloudroom/provider-bridge-protocol/bridge-kit";
import { readAntigravityStatus } from "@cloudroom/process-utils/antigravity-status";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const USAGE_FETCH_TIMEOUT_MS = 15_000;
const CURSOR_DASHBOARD_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService";
const CURSOR_KEYCHAIN_ACCOUNT = "cursor-user";
const CURSOR_ACCESS_TOKEN_SERVICE = "cursor-access-token";
const CURSOR_INSTALL_SCRIPT_URL = "https://cursor.com/install";
const ANTIGRAVITY_INSTALL_SCRIPT_URL =
  "https://antigravity.google/cli/install.sh";
/** Cursor's documented native Windows installer (#1897). */
const CURSOR_WINDOWS_INSTALL_SCRIPT_URL =
  "https://cursor.com/install?win32=true";

function cursorAuthFilePath(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Cursor", "auth.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), ".cursor", "auth.json");
  }
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "cursor", "auth.json");
}

async function readKeychainAccessToken(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "security",
      [
        "find-generic-password",
        "-s",
        CURSOR_ACCESS_TOKEN_SERVICE,
        "-a",
        CURSOR_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { timeout: 10_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const cursorFileCredentialsSchema = z.object({
  accessToken: z.string().min(1).nullish(),
});

async function readAccessToken(): Promise<string | null> {
  const keychain = await readKeychainAccessToken();
  if (keychain) return keychain;
  try {
    const parsed = cursorFileCredentialsSchema.safeParse(
      JSON.parse(await fs.readFile(cursorAuthFilePath(), "utf8")),
    );
    return parsed.success ? (parsed.data.accessToken ?? null) : null;
  } catch {
    return null;
  }
}

function cursorStateDatabasePath(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(
    configHome,
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

function readAccountEmail(): string | null {
  const databasePath = cursorStateDatabasePath();
  if (!existsSync(databasePath)) return null;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA query_only = true");
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("cursorAuth/cachedEmail");
    const parsed = z.object({ value: z.string().email() }).safeParse(row);
    return parsed.success ? parsed.data.value : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export interface AcpMaintenanceDialect {
  loginCommand: string;
  /** `installedExecutable` is the resolved CLI, or null when it is missing. */
  installer(installedExecutable: string | null): ProviderInstallationCommand;
  /** The newest released version, when the agent publishes one. */
  latestVersion?(): Promise<string | null>;
  /** `command` is the agent's resolved executable, for agents asked through their own CLI. */
  readAccount(command: string): Promise<{ email: string | null } | null>;
  readUsage(command: string): Promise<ProviderUsageResult>;
}

const installerUrlSchema = z
  .string()
  .regex(/^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~/-]*)?$/u);

const acpScriptInstallerSchema = z.object({
  scriptUrl: installerUrlSchema,
  /** Windows runs this PowerShell installer instead (#1696). */
  powershellUrl: installerUrlSchema.optional(),
  args: z
    .array(z.string().regex(/^--?[A-Za-z0-9][A-Za-z0-9-]*$/u))
    .max(8)
    .default([]),
});

const acpNpmInstallerSchema = z.object({
  npmPackage: z
    .string()
    .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
});

export const acpInstallerSchema = z.union([
  acpScriptInstallerSchema,
  acpNpmInstallerSchema,
]);
type AcpInstaller = z.infer<typeof acpInstallerSchema>;

export function acpInstallerCommand(
  installer: AcpInstaller,
  platform: NodeJS.Platform = process.platform,
): ProviderInstallationCommand {
  if ("npmPackage" in installer) {
    return npmGlobalInstallCommand(installer.npmPackage);
  }
  if (platform === "win32" && installer.powershellUrl !== undefined) {
    const command = downloadedInstallerCommand(installer.scriptUrl, {
      platform,
      powershellUrl: installer.powershellUrl,
    });
    // Kimi's install.ps1 waits on Read-Host after a failure, and nobody types
    // into the install pty: without this, a failed install holds the lock.
    return { ...command, args: ["-NonInteractive", ...command.args] };
  }
  const script = [
    'tmp=$(mktemp "${TMPDIR:-/tmp}/provider-installation.XXXXXX")',
    "trap 'rm -f \"$tmp\"' EXIT",
    `curl -fsSL ${installer.scriptUrl} -o "$tmp"`,
    ['bash "$tmp"', ...installer.args, "</dev/null"].join(" "),
  ].join(" && ");
  return { command: "sh", args: ["-c", script], displayCommand: script };
}

export interface AcpMaintenanceTarget {
  maintenance: AcpMaintenanceDialect | undefined;
  installer:
    | ((installedExecutable: string | null) => ProviderInstallationCommand)
    | undefined;
  command: string | null;
  /** Older CLIs lack the ACP launch (legacy Kilo 0.x has no `kilo acp`, #1156). */
  minimumVersion?: string;
}

/** Only a version Cloudroom could read can be too old. */
function versionUnsupported(
  version: string | null,
  minimumVersion: string | undefined,
): boolean {
  return (
    version !== null &&
    minimumVersion !== undefined &&
    compareVersions(version, minimumVersion) < 0
  );
}

function loginCommandFor(target: AcpMaintenanceTarget): string | null {
  const login = target.maintenance?.loginCommand ?? null;
  const { command } = target;
  if (login === null || command === null || !path.isAbsolute(command)) {
    return login;
  }
  const onPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .includes(path.dirname(command));
  // Windows resolves `cursor-agent.cmd`; its login runs in PowerShell (#1709).
  const windows = process.platform === "win32";
  const name = windows ? path.parse(command).name : path.basename(command);
  if (onPath || !login.startsWith(`${name} `)) return login;
  const shown = !windows
    ? formatCommand(command, [])
    : /^[\w.:\\~-]+$/u.test(command)
      ? command
      : `& '${command.replaceAll("'", "''")}'`;
  return `${shown}${login.slice(name.length)}`;
}

function healthResult(args: {
  target: AcpMaintenanceTarget;
  status:
    | "ready"
    | "not_installed"
    | "unauthenticated"
    | "unsupported_version"
    | "unknown";
  accountEmail?: string | null;
  installedVersion?: string | null;
  statusMessage?: string | null;
}): ProviderHealthResult {
  const { maintenance, installer } = args.target;
  return {
    supported: true,
    health: {
      status: args.status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: args.accountEmail ?? null,
      planLabel: null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: args.target.minimumVersion ?? null,
      canInstall: installer !== undefined,
      canUpdate: maintenance !== undefined && args.status !== "not_installed",
      loginCommand: loginCommandFor(args.target),
    },
  };
}

// `hermes --version` also runs Hermes's update check (`git fetch` on git
// installs). `hermes-acp --version` skips it, but still repairs a half-done
// update at startup and is missing on older installs. Routine checks only
// confirm Hermes is installed (#929).
const CLIS_WITHOUT_SAFE_VERSION = new Set(["hermes"]);

// cmux's `grok` wrapper prints "grok not found in PATH" when the real CLI is
// missing (#1823). Only that counts as missing, not an unreadable version or
// another agent's missing helper.
const GROK_WRAPPER_MISSING = /(?:^|[^\w.-])grok not found in PATH/u;
async function probeAcpCli(
  command: string,
): Promise<{ version: string | null; missing: boolean }> {
  const name = path.parse(command).name.toLowerCase();
  if (CLIS_WITHOUT_SAFE_VERSION.has(name)) {
    return { version: null, missing: false };
  }
  const { version, failedOutput } = await probeCliVersion(command);
  return {
    version,
    missing: name === "grok" && GROK_WRAPPER_MISSING.test(failedOutput ?? ""),
  };
}

export async function getAcpProviderHealth(
  target: AcpMaintenanceTarget,
): Promise<ProviderHealthResult> {
  const { maintenance, command } = target;
  if (command === null) {
    return healthResult({
      target,
      status: "unknown",
      statusMessage: "The ACP provider has no launch command.",
    });
  }
  const executable = await resolveExecutablePath(command);
  if (executable === null) {
    return healthResult({ target, status: "not_installed" });
  }
  const { version, missing } = await probeAcpCli(command);
  if (missing) return healthResult({ target, status: "not_installed" });
  if (versionUnsupported(version, target.minimumVersion)) {
    return healthResult({
      target,
      status: "unsupported_version",
      installedVersion: version,
      statusMessage: `${command} ${version} is too old for ACP. Update it to ${target.minimumVersion} or newer.`,
    });
  }
  if (maintenance === undefined) {
    return healthResult({
      target,
      status: "ready",
      installedVersion: version,
    });
  }
  try {
    const account = await maintenance.readAccount(executable);
    return healthResult({
      target,
      status: account === null ? "unauthenticated" : "ready",
      accountEmail: account?.email ?? null,
      installedVersion: version,
    });
  } catch (error) {
    return healthResult({
      target,
      status: "unknown",
      installedVersion: version,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getAcpProviderInstallationStatus(
  args: AcpMaintenanceTarget,
): Promise<ProviderInstallationStatus> {
  const executableName = args.command ?? "";
  const found =
    args.command === null ? null : await resolveExecutablePath(args.command);
  const { version: currentVersion, missing } =
    found === null || args.command === null
      ? { version: null, missing: true }
      : await probeAcpCli(args.command);
  const resolvedExecutable = missing ? null : found;
  const installed = resolvedExecutable !== null;
  const unsupported = versionUnsupported(currentVersion, args.minimumVersion);
  const latestVersion =
    currentVersion === null
      ? null
      : ((await args.maintenance?.latestVersion?.()) ?? null);
  const needsUpdate =
    currentVersion !== null &&
    latestVersion !== null &&
    compareVersions(latestVersion, currentVersion) > 0;
  // A too-old or outdated CLI gets its installer again as an Update (#1156).
  const installAction =
    args.installer === undefined ||
    (installed && !unsupported && !needsUpdate)
      ? null
      : installed
        ? {
            kind: "update" as const,
            label: "Update" as const,
            command: args.installer(resolvedExecutable).displayCommand,
          }
        : {
            kind: "install" as const,
            label: "Install" as const,
            command: args.installer(resolvedExecutable).displayCommand,
          };
  return {
    executableName,
    executablePath: resolvedExecutable,
    installed,
    installSource: installed ? "external" : "notInstalled",
    currentVersion,
    latestVersion,
    minimumSupportedVersion: args.minimumVersion ?? null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction,
    needsUpdate,
    versionUnsupported: unsupported,
  };
}

export async function getAcpProviderInstallationRun(
  args: AcpMaintenanceTarget & { action: "install" | "update" },
): Promise<ProviderInstallationRunResult> {
  const status = await getAcpProviderInstallationStatus(args);
  return buildAcpProviderInstallationRun(status, args);
}

function buildAcpProviderInstallationRun(
  status: ProviderInstallationStatus,
  args: Pick<
    AcpMaintenanceTarget,
    "command" | "installer" | "minimumVersion"
  > & {
    action: "install" | "update";
  },
): ProviderInstallationRunResult {
  if (
    status.installAction?.kind !== args.action ||
    args.installer === undefined
  ) {
    return installationRunUnavailable(
      args.command === null ? "This ACP agent" : path.basename(args.command),
      args.action,
      status,
    );
  }
  return {
    available: true,
    command: args.installer(status.executablePath),
    verification:
      args.action === "update" && status.needsUpdate && status.latestVersion
        ? { kind: "version_at_least", version: status.latestVersion }
        : args.action === "update" && args.minimumVersion !== undefined
          ? { kind: "version_at_least", version: args.minimumVersion }
          : { kind: "installed" },
  };
}

const cursorNonNegativeIntegerSchema = z
  .union([
    z.number().int().nonnegative(),
    z.string().regex(/^\d+$/u).transform(Number),
  ])
  .refine(Number.isSafeInteger);

const cursorUsageResponseSchema = z
  .object({
    billingCycleEnd: cursorNonNegativeIntegerSchema.nullish(),
    planUsage: z
      .object({
        totalPercentUsed: z.number().nonnegative().default(0),
        autoPercentUsed: z.number().nonnegative().nullish(),
        apiPercentUsed: z.number().nonnegative().nullish(),
      })
      .nullish(),
    spendLimitUsage: z
      .object({
        overallLimit: cursorNonNegativeIntegerSchema.nullish(),
        overallUsed: cursorNonNegativeIntegerSchema.nullish(),
        individualLimit: cursorNonNegativeIntegerSchema.nullish(),
        individualUsed: cursorNonNegativeIntegerSchema.nullish(),
        pooledLimit: cursorNonNegativeIntegerSchema.nullish(),
        pooledUsed: cursorNonNegativeIntegerSchema.nullish(),
      })
      .nullish(),
  })
  .passthrough();

const cursorPlanResponseSchema = z
  .object({
    planInfo: z.object({ planName: z.string().min(1) }).nullish(),
  })
  .passthrough();

function normalizeUsage(
  rawUsage: unknown,
  rawPlan: unknown,
  accountEmail: string | null = null,
): ProviderUsage {
  const usage = cursorUsageResponseSchema.safeParse(rawUsage);
  if (!usage.success) {
    return {
      status: "error",
      message: "Cursor usage response was malformed.",
      planLabel: null,
      accountEmail,
    };
  }
  const plan = cursorPlanResponseSchema.safeParse(rawPlan);
  const resetsAt =
    usage.data.billingCycleEnd == null
      ? null
      : new Date(usage.data.billingCycleEnd).toISOString();
  const windows: ProviderUsageWindow[] = [];
  const planUsage = usage.data.planUsage;
  // Cursor's own models (Grok, Composer, Auto) and every other model (3P) use separate pools; the total blends them
  // (F#5982). Older responses have only the total.
  const auto = planUsage?.autoPercentUsed;
  const api = planUsage?.apiPercentUsed;
  if (planUsage) {
    windows.push({
      label: "Plan usage",
      usedPercent: clampPercent(
        auto != null && api != null ? auto : planUsage.totalPercentUsed,
      ),
      resetsAt,
    });
  }
  if (auto != null && api != null) {
    windows.push({
      label: "Plan · 3P",
      usedPercent: clampPercent(api),
      resetsAt,
      // Display only: no model id contains "3p", so a full bar never marks Cursor at its limit. Grok still works, and
      // on-demand spend may pay for 3P models.
      model: "3p",
    });
  }
  const spend = usage.data.spendLimitUsage;
  const pair =
    spend?.overallLimit != null
      ? { limit: spend.overallLimit, used: spend.overallUsed ?? 0 }
      : spend?.individualLimit != null
        ? { limit: spend.individualLimit, used: spend.individualUsed ?? 0 }
        : spend?.pooledLimit != null
          ? { limit: spend.pooledLimit, used: spend.pooledUsed ?? 0 }
          : null;
  if (pair && pair.limit > 0) {
    windows.push({
      label: "On-demand spend",
      usedPercent: clampPercent((pair.used / pair.limit) * 100),
      resetsAt,
      cost: { usedUsdCents: pair.used, limitUsdCents: pair.limit },
    });
  }
  return {
    status: "ok",
    accountEmail,
    planLabel: plan.success ? (plan.data.planInfo?.planName ?? null) : null,
    windows,
  };
}

function fetchDashboard(
  method: string,
  accessToken: string,
): Promise<Response> {
  return fetch(`${CURSOR_DASHBOARD_URL}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-cursor-client-type": "cli",
      "x-cursor-client-version": "cli-bb-provider-acp",
    },
    body: "{}",
    signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
  });
}

export async function getAcpProviderUsage(
  args: AcpMaintenanceTarget,
): Promise<ProviderUsageResult> {
  if (args.maintenance === undefined) return { supported: false };
  const executable =
    args.command === null ? null : await resolveExecutablePath(args.command);
  if (executable === null) {
    return { supported: true, usage: { status: "not_installed" } };
  }
  return args.maintenance.readUsage(executable);
}

const LATEST_VERSION_TTL_MS = 60 * 60_000;

/** Asks for a CLI's newest version at most once an hour. Null when it can't be read. */
function hourlyLatestVersion(
  read: () => Promise<string | null>,
): () => Promise<string | null> {
  let cached: { version: string | null; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.version;
    const version = versionFrom(await read().catch(() => null));
    cached = { version, expiresAt: Date.now() + LATEST_VERSION_TTL_MS };
    return version;
  };
}

async function fetchText(url: string): Promise<string | null> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
  });
  return response.ok ? response.text() : null;
}

/** Cursor's install script names the version it installs. */
const readCursorLatestVersion = hourlyLatestVersion(
  async () =>
    (await fetchText(CURSOR_INSTALL_SCRIPT_URL))?.match(
      /\/lab\/([0-9A-Za-z.-]+)\//u,
    )?.[1] ?? null,
);

export const CURSOR_ACP_MAINTENANCE: AcpMaintenanceDialect = {
  loginCommand: "cursor-agent login",
  // Cursor's Windows script first deletes %LOCALAPPDATA%\cursor-agent, running
  // versions included, so an installed CLI updates itself (#1897). CI=1 skips
  // what `update` does first in a terminal: switch cursor-agent to Grok's CLI.
  installer: (installedExecutable) =>
    process.platform === "win32" && installedExecutable !== null
      ? {
          command: "powershell.exe",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            // PowerShell also closes '...' on typographic single quotes.
            `$env:CI = '1'; & '${installedExecutable.replace(/['‘-‛]/gu, "$&$&")}' update; exit $LASTEXITCODE`,
          ],
          displayCommand: "cursor-agent update",
        }
      : downloadedInstallerCommand(CURSOR_INSTALL_SCRIPT_URL, {
          powershellUrl: CURSOR_WINDOWS_INSTALL_SCRIPT_URL,
        }),
  latestVersion: readCursorLatestVersion,
  readAccount: async () => {
    const accessToken = await readAccessToken();
    return accessToken === null ? null : { email: readAccountEmail() };
  },
  readUsage: readCursorUsage,
};

async function readCursorUsage(): Promise<ProviderUsageResult> {
  const accessToken = await readAccessToken();
  if (!accessToken) {
    return { supported: true, usage: { status: "unauthenticated" } };
  }
  try {
    const [usageResponse, planResponse] = await Promise.all([
      fetchDashboard("GetCurrentPeriodUsage", accessToken),
      fetchDashboard("GetPlanInfo", accessToken),
    ]);
    if (usageResponse.status === 401 || planResponse.status === 401) {
      return { supported: true, usage: { status: "expired" } };
    }
    if (!usageResponse.ok) {
      return {
        supported: true,
        usage: {
          status: "error",
          message: `Cursor usage request failed (HTTP ${usageResponse.status}).`,
          planLabel: null,
          accountEmail: readAccountEmail(),
        },
      };
    }
    return {
      supported: true,
      usage: normalizeUsage(
        await usageResponse.json(),
        planResponse.ok ? await planResponse.json() : {},
        readAccountEmail(),
      ),
    };
  } catch (error) {
    return {
      supported: true,
      usage: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        planLabel: null,
        accountEmail: readAccountEmail(),
      },
    };
  }
}

const ANTIGRAVITY_ACCOUNT_TTL_MS = 60_000;
const ANTIGRAVITY_TIER_TTL_MS = 60 * 60_000;
const ANTIGRAVITY_ACP_TIER_TIMEOUT_MS = 8_000;

let antigravityAccount: {
  command: string;
  signedIn: boolean;
  email: string | null;
  expiresAt: number;
} | null = null;
let antigravityUsageCache: {
  command: string;
  result: ProviderUsageResult;
  expiresAt: number;
} | null = null;
let antigravityUsagePending: {
  command: string;
  promise: Promise<ProviderUsageResult>;
} | null = null;
let antigravityTierCache: {
  key: string;
  tier: string | null;
  expiresAt: number;
} | null = null;

const antigravityQuotaBucketSchema = z
  .object({
    remaining_fraction: z.number().min(0).max(1).nullish(),
    reset_time: z.string().min(1).nullish(),
    reset_in_seconds: z.number().nonnegative().nullish(),
    disabled: z.boolean().nullish(),
  })
  .passthrough();

const antigravityStatusLineSchema = z
  .object({
    email: z.string().nullish(),
    plan_tier: z.string().nullish(),
    quota: z.record(z.string(), antigravityQuotaBucketSchema).nullish(),
  })
  .passthrough();

type AntigravityQuotaBucket = z.infer<typeof antigravityQuotaBucketSchema>;

function antigravityResetIso(
  bucket: AntigravityQuotaBucket,
  now = Date.now(),
): string | null {
  if (bucket.reset_time) {
    const parsed = Date.parse(bucket.reset_time);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (bucket.reset_in_seconds != null && bucket.reset_in_seconds > 0) {
    return new Date(now + bucket.reset_in_seconds * 1_000).toISOString();
  }
  return null;
}

/** Normalizes agy's statusLine JSON payload into Cloudroom's compact usage windows (5h + 7d Gemini; 3p only when used > 0%). */
function normalizeAntigravityUsage(
  raw: unknown,
  planTierFallback: string | null = null,
  now = Date.now(),
): ProviderUsage {
  const parsed = antigravityStatusLineSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Antigravity usage response was malformed.",
      planLabel: planTierFallback,
      accountEmail: null,
    };
  }
  const email = parsed.data.email?.trim() || null;
  const planLabel = parsed.data.plan_tier?.trim() || planTierFallback || null;
  const quota = parsed.data.quota ?? {};
  const windows: ProviderUsageWindow[] = [];
  const pushBucket = (key: string, label: string): boolean => {
    const bucket = quota[key];
    if (
      !bucket ||
      bucket.disabled === true ||
      bucket.remaining_fraction == null
    ) {
      return false;
    }
    const usedPercent = clampPercent((1 - bucket.remaining_fraction) * 100);
    windows.push({
      label,
      usedPercent,
      resetsAt: antigravityResetIso(bucket, now),
    });
    return true;
  };
  const hasGemini5h = pushBucket("gemini-5h", "Five-hour limit");
  const hasGemini7d = pushBucket("gemini-weekly", "Weekly limit");
  pushBucket("3p-5h", "Five-hour · 3P");
  pushBucket("3p-weekly", "Weekly · 3P");
  if (!hasGemini5h && !hasGemini7d) {
    for (const [key, bucket] of Object.entries(quota)) {
      if (
        key === "3p-5h" ||
        key === "3p-weekly" ||
        bucket.disabled === true ||
        bucket.remaining_fraction == null
      ) {
        continue;
      }
      windows.push({
        label: key,
        usedPercent: clampPercent((1 - bucket.remaining_fraction) * 100),
        resetsAt: antigravityResetIso(bucket, now),
      });
    }
  }
  return {
    status: "ok",
    accountEmail: email,
    planLabel,
    windows,
  };
}

const probeAntigravityStatusLine = (command: string) => readAntigravityStatus(command);

const antigravityAcpTierSchema = z.object({
  id: z.number().optional(),
  result: z
    .object({
      _meta: z
        .object({
          antigravity: z
            .object({
              tier: z.object({ name: z.string().min(1) }).nullish(),
            })
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/** Reads the subscription tier name (e.g. "Google AI Ultra") from `agy acp`'s session/new metadata, cached per account. */
async function probeAntigravityTier(
  command: string,
  email: string | null,
): Promise<string | null> {
  const key = `${command}\0${email ?? ""}`;
  if (
    antigravityTierCache?.key === key &&
    antigravityTierCache.expiresAt > Date.now()
  ) {
    return antigravityTierCache.tier;
  }
  const tier = await new Promise<string | null>((resolve) => {
    const child = spawn(command, ["acp"], {
      cwd: os.tmpdir(),
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let done = false;
    let buffer = "";
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(
      () => finish(null),
      ANTIGRAVITY_ACP_TIER_TIMEOUT_MS,
    );
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const parsed = antigravityAcpTierSchema.safeParse(JSON.parse(line));
          if (parsed.success && parsed.data.id === 2) {
            finish(parsed.data.result?._meta?.antigravity?.tier?.name ?? null);
            return;
          }
        } catch {}
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      })}\n${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: os.tmpdir(), mcpServers: [] },
      })}\n`,
    );
  });
  antigravityTierCache = {
    key,
    tier,
    expiresAt: Date.now() + ANTIGRAVITY_TIER_TTL_MS,
  };
  return tier;
}

/** agy keeps its sign-in in the OS keyring, so ask agy itself: signed out, `agy models` says "Please sign in" and
 *  exits 1. It asks Google for the list, so the answer is kept a minute. Any other failure is not a signed-out CLI. */
async function readAntigravityAccount(
  command: string,
): Promise<{ email: string | null } | null> {
  if (
    antigravityAccount?.command === command &&
    antigravityAccount.expiresAt > Date.now()
  ) {
    return antigravityAccount.signedIn
      ? { email: antigravityAccount.email }
      : null;
  }
  const signedIn = await execFileAsync(command, ["models"], {
    timeout: USAGE_FETCH_TIMEOUT_MS,
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
    windowsHide: true,
  }).then(
    () => true,
    (error: { stdout?: string; stderr?: string }) => {
      if (/please sign in/iu.test(`${error.stdout ?? ""}${error.stderr ?? ""}`))
        return false;
      throw error;
    },
  );
  const email =
    signedIn && antigravityAccount?.command === command
      ? antigravityAccount.email
      : null;
  antigravityAccount = {
    command,
    signedIn,
    email,
    expiresAt: Date.now() + ANTIGRAVITY_ACCOUNT_TTL_MS,
  };
  return signedIn ? { email } : null;
}

async function collectAntigravityUsage(
  command: string,
): Promise<ProviderUsageResult> {
  let account: { email: string | null } | null;
  try {
    account = await readAntigravityAccount(command);
  } catch (error) {
    return {
      supported: true,
      usage: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        planLabel: null,
        accountEmail: null,
      },
    };
  }
  if (account === null) {
    antigravityTierCache = null;
    return { supported: true, usage: { status: "unauthenticated" } };
  }
  const raw = await probeAntigravityStatusLine(command).catch(() => null);
  const parsed =
    raw === null ? null : antigravityStatusLineSchema.safeParse(raw);
  if (!parsed?.success) {
    const tier = await probeAntigravityTier(command, account.email);
    return {
      supported: true,
      usage: {
        status: "ok",
        accountEmail: account.email,
        planLabel: tier,
        windows: [],
      },
    };
  }
  const email = parsed.data.email?.trim() || null;
  const planTier = parsed.data.plan_tier?.trim() || null;
  const tier = planTier ?? (await probeAntigravityTier(command, email));
  if (email && antigravityAccount?.command === command) {
    antigravityAccount = { ...antigravityAccount, email };
  }
  return {
    supported: true,
    usage: normalizeAntigravityUsage(raw, tier),
  };
}

async function readAntigravityUsage(
  command: string,
): Promise<ProviderUsageResult> {
  if (
    antigravityUsageCache?.command === command &&
    antigravityUsageCache.expiresAt > Date.now()
  ) {
    return antigravityUsageCache.result;
  }
  if (antigravityUsagePending?.command === command) {
    return antigravityUsagePending.promise;
  }
  const promise = collectAntigravityUsage(command)
    .then((result) => {
      if (
        result.supported &&
        (result.usage.status === "ok" ||
          result.usage.status === "unauthenticated")
      ) {
        antigravityUsageCache = {
          command,
          result,
          expiresAt: Date.now() + ANTIGRAVITY_ACCOUNT_TTL_MS,
        };
      }
      return result;
    })
    .finally(() => {
      if (antigravityUsagePending?.promise === promise) {
        antigravityUsagePending = null;
      }
    });
  antigravityUsagePending = { command, promise };
  return promise;
}

/** agy's install script names its release server, which lists the newest version for each platform. */
const readAntigravityLatestVersion = hourlyLatestVersion(async () => {
  const server = (await fetchText(ANTIGRAVITY_INSTALL_SCRIPT_URL))?.match(
    /^DOWNLOAD_BASE_URL="(https:\/\/[A-Za-z0-9.-]+)"/mu,
  )?.[1];
  if (server === undefined) return null;
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const manifest = await fetchText(`${server}/manifests/${os}_${arch}.json`);
  if (manifest === null) return null;
  const parsed = z
    .object({ version: z.string() })
    .safeParse(JSON.parse(manifest));
  return parsed.success ? parsed.data.version : null;
});

export const ANTIGRAVITY_ACP_MAINTENANCE: AcpMaintenanceDialect = {
  loginCommand: "agy acp --login",
  // agy's install script stops when agy is already there, so an installed agy updates itself.
  installer: (installedExecutable) =>
    installedExecutable !== null
      ? {
          command: installedExecutable,
          args: ["update"],
          displayCommand: "agy update",
        }
      : acpInstallerCommand({
          scriptUrl: ANTIGRAVITY_INSTALL_SCRIPT_URL,
          powershellUrl: "https://antigravity.google/cli/install.ps1",
          args: [],
        }),
  latestVersion: readAntigravityLatestVersion,
  readAccount: readAntigravityAccount,
  readUsage: readAntigravityUsage,
};

export const __testing = {
  buildProviderInstallationRun: buildAcpProviderInstallationRun,
  normalizeUsage,
  normalizeAntigravityUsage,
};
