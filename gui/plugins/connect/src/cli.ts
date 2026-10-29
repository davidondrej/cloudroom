import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import type { ShareHostResolver } from "./hosts.js";
import { parseSharePort } from "./shares.js";
import type { ConnectTunnel } from "./tunnel.js";
import type { PhoneRelay } from "./phone.js";
import { PHONE_SETUP_URL, type ConnectStatus } from "./types.js";

interface ParsedFlags {
  flags: Map<string, string | true>;
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}".\n\n${helpText()}`);
    }
    const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    if (!rawName) throw new Error(`Invalid flag ${arg}`);
    if (inlineValue !== undefined) {
      flags.set(rawName, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(rawName, next);
      index += 1;
    } else {
      flags.set(rawName, true);
    }
  }
  return { flags };
}

function stringFlag(parsed: ParsedFlags, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return value === undefined || value === true ? undefined : value;
}

function validateFlags(
  parsed: ParsedFlags,
  options: { boolean?: readonly string[]; value?: readonly string[] },
): void {
  const booleans = new Set(options.boolean ?? []);
  const values = new Set(options.value ?? []);
  for (const [name, value] of parsed.flags) {
    if (!booleans.has(name) && !values.has(name)) {
      throw new Error(`Unknown flag --${name}`);
    }
    if (booleans.has(name) && value !== true) {
      throw new Error(`--${name} does not take a value`);
    }
    if (values.has(name) && value === true) {
      throw new Error(`--${name} requires a value`);
    }
  }
}

function helpText(): string {
  return [
    "Cloudroom Connect opens this Cloudroom from your phone at https://app.cloudroom.run.",
    "It sets itself up once you are signed in to Cloudroom. Share HTTP ports from any enrolled host.",
    "",
    "  room-cli connect status              Show remote-access status",
    "  room-cli connect phone               Show how to set up Cloudroom on your phone",
    "  room-cli connect sign-out-phones     Sign out every phone and browser",
    "  room-cli connect expose <port> [--host <name-or-id>]    Share a port from the thread's host",
    "  room-cli connect unexpose <port> [--host <name-or-id>]  Stop sharing a port on that host",
    "  room-cli connect shares [--host <name-or-id>]           List shares for the thread's host",
    "",
    "On your phone, open cloudroom.dev/m, sign in, and add the app to your home screen.",
  ].join("\n");
}

function formatStatus(status: ConnectStatus): string {
  const lines = !status.paired
    ? [
        status.signedIn
          ? `Setting up${status.lastError ? ` (${status.lastError})` : ""}`
          : (status.lastError ?? "Sign in to Cloudroom to use it on your phone."),
      ]
    : [`${status.url}  ${status.state}`];
  if (status.paired && status.lastError !== null && status.state !== "connected") {
    lines.push(`  last error: ${status.lastError}`);
  }
  if (status.shares.length > 0) {
    lines.push("  shares:");
    for (const share of status.shares) {
      lines.push(
        `    ${share.hostName} (${share.hostId})  ${share.port}  ${share.url || `unavailable: ${share.unavailableReason ?? "unknown reason"}`}`,
      );
    }
  }
  return lines.join("\n");
}

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function notPairedError(): string {
  return "Cloudroom Connect is not set up yet — sign in to Cloudroom, then try again";
}

export function registerConnectCli(args: {
  bb: Pick<BbPluginApi, "cli">;
  relay: ConnectTunnel;
  phone: PhoneRelay;
  status: () => ConnectStatus;
  hostResolver: ShareHostResolver;
}): void {
  const { bb, relay, phone, status, hostResolver } = args;
  const tunnel = relay;
  bb.cli.register({
    name: "connect",
    summary:
      "Open this Cloudroom from your phone at cloudroom.run and share ports",
    commands: [
      {
        name: "status",
        summary: "Show remote-access status",
        usage: "room-cli connect status [--json]",
      },
      {
        name: "phone",
        summary: "Show how to set up Cloudroom on your phone",
        usage: "room-cli connect phone [--json]",
      },
      {
        name: "sign-out-phones",
        summary: "Sign out every phone and browser",
        usage: "room-cli connect sign-out-phones [--json]",
      },
      {
        name: "expose",
        summary: "Share an HTTP port from an enrolled host",
        usage: "room-cli connect expose <port> [--host <name-or-id>] [--json]",
      },
      {
        name: "unexpose",
        summary: "Stop sharing an HTTP port from a host",
        usage:
          "room-cli connect unexpose <port> [--host <name-or-id>] [--json]",
      },
      {
        name: "shares",
        summary: "List shared ports and their public URLs",
        usage: "room-cli connect shares [--host <name-or-id>] [--json]",
      },
    ],
    async run(argv, ctx): Promise<PluginCliResult> {
      try {
        const [first] = argv;
        if (first === "status") {
          const parsed = parseFlags(argv.slice(1));
          validateFlags(parsed, { boolean: ["json"] });
          const current = { ...status(), shares: await relay.listShares() };
          return {
            exitCode: 0,
            stdout: parsed.flags.has("json")
              ? asJson(current)
              : `${formatStatus(current)}\n`,
          };
        }
        if (first === "phone") {
          const parsed = parseFlags(argv.slice(1));
          validateFlags(parsed, { boolean: ["json"] });
          return {
            exitCode: 0,
            stdout: parsed.flags.has("json")
              ? asJson({ url: PHONE_SETUP_URL })
              : `On your phone, open ${PHONE_SETUP_URL}, sign in with your Cloudroom account, and tap Open Cloudroom.\nThen add it to your home screen.\n`,
          };
        }
        if (first === "sign-out-phones") {
          const parsed = parseFlags(argv.slice(1));
          validateFlags(parsed, { boolean: ["json"] });
          const result = await phone.signOutPhones();
          return {
            exitCode: 0,
            stdout: parsed.flags.has("json")
              ? asJson(result)
              : `Signed out ${result.revoked} phone or browser session(s)\n`,
          };
        }
        if (first === "expose") {
          const portArg = argv[1];
          if (portArg === undefined || portArg.startsWith("--")) {
            return {
              exitCode: 1,
              stderr:
                "Usage: room-cli connect expose <port> [--host <name-or-id>] [--json]\n",
            };
          }
          const parsed = parseFlags(argv.slice(2));
          validateFlags(parsed, { boolean: ["json"], value: ["host"] });
          if (!relay.status().paired) {
            return { exitCode: 1, stderr: `${notPairedError()}\n` };
          }
          const targetHost = await hostResolver.resolve(
            ctx,
            stringFlag(parsed, "host"),
          );
          const listing = await tunnel.expose(
            parseSharePort(portArg),
            targetHost,
          );
          if (parsed.flags.has("json")) {
            return { exitCode: 0, stdout: asJson(listing) };
          }
          return {
            exitCode: 0,
            stdout: `${listing.url}\n`,
          };
        }
        if (first === "unexpose") {
          const portArg = argv[1];
          if (portArg === undefined || portArg.startsWith("--")) {
            return {
              exitCode: 1,
              stderr:
                "Usage: room-cli connect unexpose <port> [--host <name-or-id>] [--json]\n",
            };
          }
          const parsed = parseFlags(argv.slice(2));
          validateFlags(parsed, { boolean: ["json"], value: ["host"] });
          const targetHost =
            stringFlag(parsed, "host") ?? (await hostResolver.resolveId(ctx));
          const result = await tunnel.unexpose(
            parseSharePort(portArg),
            targetHost,
          );
          if (parsed.flags.has("json")) {
            return { exitCode: 0, stdout: asJson(result) };
          }
          if (!result.removed) {
            return {
              exitCode: 0,
              stdout: `Port ${result.port} was not shared on ${result.hostName} (${result.hostId}) (idempotent).\n`,
            };
          }
          return {
            exitCode: 0,
            stdout: `Stopped sharing port ${result.port} on ${result.hostName} (${result.hostId})\n`,
          };
        }
        if (first === "shares") {
          const parsed = parseFlags(argv.slice(1));
          validateFlags(parsed, { boolean: ["json"], value: ["host"] });
          const targetHost = await hostResolver.resolve(
            ctx,
            stringFlag(parsed, "host"),
          );
          const shares = await tunnel.listShares(targetHost.id);
          if (parsed.flags.has("json")) {
            return {
              exitCode: 0,
              stdout: asJson({ host: targetHost, shares }),
            };
          }
          if (shares.length === 0) {
            return { exitCode: 0, stdout: "No shared ports\n" };
          }
          const lines = shares.map(
            (share) =>
              `${share.hostName} (${share.hostId})  ${share.port}  ${share.url || `unavailable: ${share.unavailableReason ?? "unknown reason"}`}`,
          );
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }
        if (first !== undefined && !first.startsWith("--")) {
          return {
            exitCode: 1,
            stderr: `Unknown connect command '${first}'.\n\n${helpText()}\n`,
          };
        }
        const parsed = parseFlags(argv);
        validateFlags(parsed, { boolean: ["json"] });
        return { exitCode: 0, stdout: `${helpText()}\n` };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    },
  });
}
