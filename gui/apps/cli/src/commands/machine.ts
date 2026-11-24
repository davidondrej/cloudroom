import { registerMachineEnvironmentCommands } from "./machine-environment.js";
import {
  enrollMachine,
  type MachineEnrollmentOptions,
} from "./machine-enrollment.js";
import { Command } from "commander";
import { jsonValueSchema, type Host, type JsonValue } from "@cloudroom/domain";
import type { CloudVps } from "@cloudroom/sdk/node";
import { action, CliExitError } from "../action.js";
import { CLI_READ_TIMEOUT_MS, createCliRoomSdk } from "../client.js";
import { columnWidths, printBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";
import { confirmDestructiveAction } from "./helpers.js";

function enrollmentExpiryNotice(expiresAt: number | null): string {
  if (expiresAt === null) return "This command expires once it is used.";
  return `This command expires at ${new Date(expiresAt).toLocaleTimeString()}.`;
}

interface MachineListCommandOptions {
  json?: boolean;
}

interface MachineEnumerationOptions extends MachineListCommandOptions {
  all?: boolean;
}

interface MachineCreateCommandOptions extends MachineListCommandOptions {
  provider: string;
  wait: boolean;
  key?: string;
  inputs?: string;
}

interface MachineMutationCommandOptions extends MachineListCommandOptions {
  yes?: boolean;
}

interface MachineProviderInstallOptions extends MachineListCommandOptions {
  action?: "install" | "update";
}

const MACHINE_LIFECYCLE_TIMEOUT_MS = 15 * 60_000;
const MACHINE_LIFECYCLE_POLL_MS = 500;
// Longer than the website's 5 s VPS health probe, so an unresponsive VPS still lists, as offline.
export const VPS_HINT_TIMEOUT_MS = 10_000;

async function waitForMachineLifecycle(args: {
  host: Host;
  targetPhase: "active" | "suspended";
  getHost: () => Promise<Host>;
}): Promise<Host> {
  let host = args.host;
  const deadline = Date.now() + MACHINE_LIFECYCLE_TIMEOUT_MS;
  while (host.lifecycle.phase !== args.targetPhase) {
    const message = host.lifecycle.message;
    if (
      message?.startsWith("Machine suspension failed:") ||
      message?.startsWith("Machine resume failed:")
    ) {
      throw new Error(message);
    }
    if (
      host.lifecycle.phase === "removing" ||
      host.lifecycle.phase === "destroyed"
    ) {
      throw new Error(
        host.lifecycle.message ??
          `Machine entered the ${host.lifecycle.phase} phase`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${MACHINE_LIFECYCLE_TIMEOUT_MS / 1000} seconds waiting for machine ${host.id} to become ${args.targetPhase}`,
      );
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, MACHINE_LIFECYCLE_POLL_MS),
    );
    host = await args.getHost();
  }
  return host;
}

// Removal can stop at a failed cleanup, e.g. while the machine is offline (#1307).
async function reportMachineCleanup(
  sdk: ReturnType<typeof createCliRoomSdk>,
  hostId: string,
  done: string,
): Promise<void> {
  const host = await sdk.hosts.get({ hostId }).catch(() => null);
  if (
    host?.lifecycle.phase === "removing" &&
    host.lifecycle.teardown?.status === "failed"
  ) {
    throw new Error(
      `Machine ${hostId} cleanup failed: ${host.lifecycle.message ?? "unknown error"}\nRetry with: room-cli machine retry-cleanup ${hostId}`,
    );
  }
  console.log(done);
}

function parseProviderCliKey(value: string): string {
  const providerId = value.trim();
  if (providerId.length === 0)
    throw new Error("provider ID must not be empty.");
  return providerId;
}

function describeMachines(hosts: readonly Host[]): string {
  if (hosts.length === 0) return "none";
  return hosts.map((host) => `${host.name} (${host.id})`).join(", ");
}

export type MachineScope = "persistent" | "all";

export function selectMachines(
  hosts: readonly Host[],
  scope: MachineScope,
): Host[] {
  return scope === "all"
    ? [...hosts]
    : hosts.filter((host) => host.type !== "ephemeral");
}

export function resolveMachineId(
  hosts: readonly Host[],
  target: string,
): string {
  const trimmedTarget = target.trim();
  const idMatch = hosts.find((host) => host.id === trimmedTarget);
  if (idMatch) return idMatch.id;

  const nameMatches = hosts.filter((host) => host.name === trimmedTarget);
  if (nameMatches.length === 1) return nameMatches[0].id;
  if (nameMatches.length > 1) {
    throw new Error(
      `Machine name '${trimmedTarget}' is ambiguous. Matches: ${describeMachines(nameMatches)}.`,
    );
  }
  throw new Error(
    `Machine '${trimmedTarget}' was not found. Available machines: ${describeMachines(hosts)}.${trimmedTarget.toLowerCase() === "vps" ? " To start a thread on your VPS, use VPS in the app's new-thread picker for now." : ""}`,
  );
}

export function resolveMachineTargetOption(args: {
  machine?: string;
  host?: string;
}): string | undefined {
  if (args.machine && args.host) {
    throw new Error("Cannot combine --machine with --host.");
  }
  return args.machine ?? args.host;
}

type MachineEnvironmentRouting =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

export async function resolveMachineEnvironmentRouting(
  args: { environment?: string; host?: string; machine?: string },
  serverUrl: string,
): Promise<MachineEnvironmentRouting> {
  const machineTarget = resolveMachineTargetOption(args);
  if (machineTarget !== undefined && args.environment !== undefined) {
    throw new Error(
      "Cannot combine --machine or --host with --environment; the environment already selects its machine.",
    );
  }
  if (args.environment !== undefined) {
    return { environmentId: args.environment };
  }
  if (machineTarget !== undefined) {
    return {
      hostId: await resolveMachineHostId({ serverUrl, target: machineTarget }),
    };
  }
  return {};
}

export function formatMachineLastSeen(
  timestamp: number | null,
  now = Date.now(),
): string {
  if (timestamp === null) return "never";
  const elapsedMs = Math.max(0, now - timestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (elapsedMs < minuteMs) return "just now";
  if (elapsedMs < hourMs) return `${Math.floor(elapsedMs / minuteMs)}m ago`;
  if (elapsedMs < dayMs) return `${Math.floor(elapsedMs / hourMs)}h ago`;
  return `${Math.floor(elapsedMs / dayMs)}d ago`;
}

export async function resolveMachineHostId(args: {
  requireConnected?: boolean;
  serverUrl: string;
  target: string;
}): Promise<string> {
  const hosts = await createCliRoomSdk(
    args.serverUrl,
    CLI_READ_TIMEOUT_MS,
  ).hosts.list({
    includeCreating: true,
  });
  const hostId = resolveMachineId(hosts, args.target);
  if (
    args.requireConnected &&
    hosts.find((host) => host.id === hostId)?.status !== "connected"
  ) {
    throw new Error(`Machine '${args.target.trim()}' is disconnected.`);
  }
  return hostId;
}

/** A native machine, or the account's connected VPS (ADR 0319) when `target` names it (`vps`, its hostname or short
 *  name) and no native machine does, so native machines keep their names. */
async function resolveMachineOrVps(args: {
  serverUrl: string;
  target: string;
}): Promise<
  { hostId: string; vps?: never } | { hostId?: never; vps: CloudVps }
> {
  const sdk = createCliRoomSdk(args.serverUrl, CLI_READ_TIMEOUT_MS);
  const target = args.target.trim();
  const hosts = await sdk.hosts.list({ includeCreating: true });
  const native = () => ({ hostId: resolveMachineId(hosts, target) });
  if (hosts.some((host) => host.id === target || host.name === target))
    return native();
  const wanted = target.toLowerCase();
  const asked = wanted === "vps";
  const vps = await sdk.cloudroom.vps().catch((error: unknown) => {
    if (asked) throw error;
    return null;
  });
  if (!vps?.connected) {
    if (asked)
      throw new Error(
        "No VPS is connected to this account. Connect one in Settings.",
      );
    return native();
  }
  const names = ["vps", vps.name, vps.name?.split(".")[0]];
  return names.some((name) => name?.toLowerCase() === wanted)
    ? { vps }
    : native();
}

function vpsStatus(vps: CloudVps): string {
  if (!vps.health) return "offline";
  if (vps.busy) return `busy: ${vps.busy}`;
  return `online, ${vps.health.running} ${vps.health.running === 1 ? "agent" : "agents"} running`;
}

/** `cloud status`'s line for the VPS: its whole disk, which all its threads share, and why a busy one takes no new
 *  threads (#1512). The limits are the website's `busyReason` (web/lib/providers/vps.ts). */
export function vpsDiskLine(vps: CloudVps): string {
  const GB = 1024 ** 3;
  const disk = vps.health?.disk;
  const used = disk
    ? `, ${Math.round(disk.used / GB)} of ${Math.round(disk.total / GB)} GB disk used`
    : "";
  const then = vps.fallback
    ? "start in Cloud instead"
    : `fail until it has room, or until "Use Cloud when it's busy" is on in Settings → Machines`;
  const busy = vps.busy
    ? ` Over 95% CPU, 85% memory or 90% disk, it takes no new threads: they ${then}.`
    : "";
  return `VPS: ${vps.name ?? "your VPS"} (${vpsStatus(vps)})${used}.${busy}`;
}

export function registerMachineCommands(
  program: Command,
  getUrl: () => string,
): void {
  const machine = program
    .command("machine")
    .description("Inspect execution machines");

  registerMachineEnvironmentCommands(machine, getUrl);

  machine
    .command("enroll")
    .description("Enroll this machine using a private bootstrap bundle")
    .option(
      "--bootstrap-file <path>",
      "Read the bootstrap bundle from a file, or /dev/stdin",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (options: MachineEnrollmentOptions & { json?: boolean }) => {
        const result = await enrollMachine(options);
        if (!outputJson(options, result))
          console.log(`Machine ${result.hostId} enrolled`);
      }),
    );

  machine
    .command("create")
    .description("Create a machine using an installed provider")
    .option("--no-wait", "Return the creating host ID immediately")
    .requiredOption("--provider <id>", "Machine provider ID")
    .option(
      "--key <idempotency-key>",
      "Reuse a stable key when retrying creation",
    )
    .option("--inputs <JSON>", "Provider inputs as JSON")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: MachineCreateCommandOptions) => {
        const machineProviderId = parseProviderCliKey(opts.provider);
        const key = opts.key?.trim();
        if (key === "") throw new Error("Creation key must not be empty.");
        let inputs: JsonValue = null;
        if (opts.inputs !== undefined) {
          try {
            inputs = jsonValueSchema.parse(JSON.parse(opts.inputs));
          } catch {
            throw new Error("--inputs must be valid JSON.");
          }
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once("SIGINT", cancel);
        try {
          const sdk = createCliRoomSdk(getUrl());
          controller.signal.throwIfAborted();
          let host = await sdk.hosts.experimental_create({
            machineProviderId,
            inputs,
            ...(key === undefined ? {} : { key }),
            wait: false,
            signal: controller.signal,
          });
          if (!opts.wait) {
            if (!outputJson(opts, host)) console.log(host.id);
            return;
          }
          let enrollmentCommandShown = false;
          const reportEnrollmentCommand = async (current: Host) => {
            if (
              enrollmentCommandShown ||
              current.lifecycle.phase !== "creating"
            )
              return;
            const enrollmentCommand =
              await sdk.hosts.experimental_getEnrollmentCommand({
                hostId: current.id,
                signal: controller.signal,
              });
            if (enrollmentCommand !== null) {
              console.error(enrollmentCommand.command);
              console.error(
                enrollmentExpiryNotice(enrollmentCommand.expiresAt),
              );
              enrollmentCommandShown = true;
            }
          };
          await reportEnrollmentCommand(host);
          console.error(`Following machine ${host.id}`);
          host = await waitForMachineLifecycle({
            host,
            targetPhase: "active",
            getHost: async () => {
              const current = await sdk.hosts.get({
                hostId: host.id,
                signal: controller.signal,
              });
              await reportEnrollmentCommand(current);
              return current;
            },
          });
          if (!outputJson(opts, host))
            console.log(`Machine ${host.name} created`);
        } catch (error) {
          if (controller.signal.aborted) {
            throw new CliExitError(
              "Stopped following; creation continues. Use room-cli machine remove <host-id> to cancel.",
              130,
            );
          }
          throw error;
        } finally {
          process.off("SIGINT", cancel);
        }
      }),
    );

  machine
    .command("providers")
    .description("List installed machine providers")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: MachineListCommandOptions) => {
        const providers =
          await createCliRoomSdk(getUrl()).hosts.experimental_listProviders();
        if (outputJson(opts, providers)) return;
        if (providers.length === 0) {
          console.log("No machine providers found");
          return;
        }
        console.log(
          providers
            .map((provider) => `${provider.id}  ${provider.displayName}`)
            .join("\n"),
        );
      }),
    );

  machine
    .command("list")
    .description("List execution machines")
    .option(
      "--all",
      "Include disposable provider sandboxes alongside persistent machines",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: MachineEnumerationOptions) => {
        // The VPS lives on the website, not in the machine list; JSON keeps its list of native machines.
        // Its status is a hint here, so a slow website holds up the list for VPS_HINT_TIMEOUT_MS at most.
        const [all, vps] = await Promise.all([
          createCliRoomSdk(getUrl(), CLI_READ_TIMEOUT_MS).hosts.list({
            includeCreating: true,
          }),
          opts.json
            ? null
            : createCliRoomSdk(getUrl(), VPS_HINT_TIMEOUT_MS)
                .cloudroom.vps()
                .catch(() => null),
        ]);
        const hosts = selectMachines(all, opts.all ? "all" : "persistent");
        if (outputJson(opts, hosts)) return;
        if (hosts.length > 0) printMachineTable(hosts);
        else if (!vps?.connected) console.log("No machines found");
        if (vps?.connected)
          console.log(
            `VPS: ${vps.name ?? "your VPS"} (${vpsStatus(vps)}). Start threads on it from the app's new-thread picker; \`room-cli machine show vps\` shows it.`,
          );
      }),
    );

  machine
    .command("show <id-or-name>")
    .description("Show execution machine details")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliRoomSdk(getUrl(), CLI_READ_TIMEOUT_MS);
        const { hostId, vps } = await resolveMachineOrVps({
          serverUrl: getUrl(),
          target,
        });
        if (vps) {
          if (!outputJson(opts, vps)) console.log(JSON.stringify(vps, null, 2));
          return;
        }
        const host = await sdk.hosts.get({ hostId });
        if (outputJson(opts, host)) return;
        console.log(JSON.stringify(host, null, 2));
      }),
    );

  machine
    .command("join-code")
    .description("Create a short-lived machine pairing code")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: MachineListCommandOptions) => {
        const result = await createCliRoomSdk(getUrl()).hosts.createJoinCode();
        if (outputJson(opts, result)) return;
        console.log(result.joinCode);
      }),
    );

  machine
    .command("rename <id-or-name> <name>")
    .description("Rename an execution machine")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          target: string,
          name: string,
          opts: MachineListCommandOptions,
        ) => {
          const sdk = createCliRoomSdk(getUrl());
          const hostId = await resolveMachineHostId({
            serverUrl: getUrl(),
            target,
          });
          const host = await sdk.hosts.update({ hostId, name });
          if (outputJson(opts, host)) return;
          console.log(`Machine ${host.id} renamed to ${host.name}`);
        },
      ),
    );

  machine
    .command("remove <id-or-name>")
    .description("Revoke and remove an execution machine")
    .option("--yes", "Skip the confirmation prompt")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineMutationCommandOptions) => {
        const sdk = createCliRoomSdk(getUrl());
        const hostId = await resolveMachineHostId({
          serverUrl: getUrl(),
          target,
        });
        if (
          !opts.yes &&
          !(await confirmDestructiveAction(`Remove machine ${hostId}?`))
        )
          return;
        const result = await sdk.hosts.delete({ hostId });
        if (outputJson(opts, result)) return;
        await reportMachineCleanup(sdk, hostId, `Machine ${hostId} removed`);
      }),
    );

  machine
    .command("retry-update <id-or-name>")
    .description("Retry a pending daemon protocol update now")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliRoomSdk(getUrl());
        const hostId = await resolveMachineHostId({
          serverUrl: getUrl(),
          target,
        });
        const result = await sdk.hosts.retryUpdate({ hostId });
        if (outputJson(opts, result)) return;
        console.log(`Machine ${hostId} update retry requested`);
      }),
    );

  machine
    .command("reconcile <id-or-name>")
    .description("Reconcile provider compute with the machine's recorded state")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliRoomSdk(getUrl());
        const hostId = await resolveMachineHostId({
          serverUrl: getUrl(),
          target,
        });
        const requested = await sdk.hosts.experimental_reconcile({ hostId });
        const result =
          requested.lifecycle.phase === "suspending"
            ? await waitForMachineLifecycle({
                host: requested,
                targetPhase: "suspended",
                getHost: () => sdk.hosts.get({ hostId }),
              })
            : requested;
        if (!outputJson(opts, result))
          console.log(`Machine ${hostId}: ${result.lifecycle.phase}`);
      }),
    );

  machine
    .command("suspend <id-or-name>")
    .description("Suspend a provider-managed execution machine")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliRoomSdk(getUrl());
        const hostId = await resolveMachineHostId({
          serverUrl: getUrl(),
          target,
        });
        const requested = await sdk.hosts.experimental_suspend({ hostId });
        const result = await waitForMachineLifecycle({
          host: requested,
          targetPhase: "suspended",
          getHost: () => sdk.hosts.get({ hostId }),
        });
        if (outputJson(opts, result)) return;
        console.log(`Machine ${hostId} suspended`);
      }),
    );

  machine
    .command("resume <id-or-name>")
    .description("Resume a suspended provider-managed execution machine")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliRoomSdk(getUrl());
        const hostId = await resolveMachineHostId({
          serverUrl: getUrl(),
          target,
        });
        const requested = await sdk.hosts.experimental_resume({ hostId });
        const result = await waitForMachineLifecycle({
          host: requested,
          targetPhase: "active",
          getHost: () => sdk.hosts.get({ hostId }),
        });
        if (outputJson(opts, result)) return;
        console.log(`Machine ${hostId} resumed`);
      }),
    );

  machine
    .command("retry-cleanup <id-or-name>")
    .description("Retry a failed provider teardown immediately")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliRoomSdk(getUrl());
        const hostId = await resolveMachineHostId({
          serverUrl: getUrl(),
          target,
        });
        const result = await sdk.hosts.experimental_retryCleanup({ hostId });
        if (outputJson(opts, result)) return;
        await reportMachineCleanup(
          sdk,
          hostId,
          `Machine ${hostId} cleanup retried`,
        );
      }),
    );

  const providerCli = machine
    .command("provider-cli")
    .description("Inspect and install provider CLIs on a machine");
  providerCli
    .command("status <id-or-name>")
    .description("Show registered provider CLI installation/update status")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (target: string, opts: MachineListCommandOptions) => {
        const sdk = createCliRoomSdk(getUrl());
        const hostId = await resolveMachineHostId({
          serverUrl: getUrl(),
          target,
        });
        const result = await sdk.hosts.providerCliStatus({ hostId });
        if (outputJson(opts, result)) return;
        console.log(JSON.stringify(result, null, 2));
      }),
    );
  providerCli
    .command("install <id-or-name> <provider>")
    .description("Install or update a registered provider CLI by provider ID")
    .option(
      "--action <action>",
      "Action: install or update (default: the one status offers)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          target: string,
          provider: string,
          opts: MachineProviderInstallOptions,
        ) => {
          if (
            opts.action !== undefined &&
            opts.action !== "install" &&
            opts.action !== "update"
          ) {
            throw new Error("--action must be install or update.");
          }
          const sdk = createCliRoomSdk(getUrl());
          const hostId = await resolveMachineHostId({
            serverUrl: getUrl(),
            target,
          });
          const providerId = parseProviderCliKey(provider);
          // Status offers Pi's update as `npm install -g …`: follow its action
          // instead of assuming install (#849). One failing provider fails the
          // whole status, so fall back to install rather than block this one.
          const actionKind =
            opts.action ??
            (await sdk.hosts.providerCliStatus({ hostId }).catch(() => null))?.[
              providerId
            ]?.installAction?.kind ??
            "install";
          const events = await sdk.hosts.installProviderCli({
            hostId,
            provider: providerId,
            actionKind,
          });
          if (outputJson(opts, events)) return;
          for (const event of events) console.log(JSON.stringify(event));
        },
      ),
    );
}

function printMachineTable(hosts: Host[]): void {
  const now = Date.now();
  const rows = hosts.map((host) => [
    host.name,
    host.id,
    host.type,
    host.status,
    host.machineProviderId ?? "user-enrolled",
    formatMachineLastSeen(host.lastSeenAt, now),
  ]);
  printBorderlessTable(
    {
      head: ["Name", "ID", "Type", "Status", "Provider", "Last seen"],
      colWidths: columnWidths(rows, [4, 2, 4, 6, 8, 9]),
      trimTrailingWhitespace: true,
    },
    rows,
  );
}
