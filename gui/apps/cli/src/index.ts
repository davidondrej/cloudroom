#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { maybeReexecViaRoomCli } from "./room-cli-reexec.js";
import {
  CORE_COMMAND_GROUPS,
  type CommandGroupDeps,
  isCommandHelp,
  isTopLevelHelp,
  pluginProxyCandidate,
  selectCommandGroups,
} from "./command-groups.js";
import { formatCloudroomVersion, resolveRoomCliVersion } from "./version.js";
import type { CliRuntimeContext } from "./context-env.js";

if (process.platform === "win32" && process.env.ROOM_CLI_ARGV !== undefined) {
  process.argv = [
    ...process.argv.slice(0, 2),
    ...(JSON.parse(process.env.ROOM_CLI_ARGV) as string[]),
  ];
  delete process.env.ROOM_CLI_ARGV;
}

maybeReexecViaRoomCli();

process.argv = process.argv.map((arg) =>
  arg.replace(/^@thread:(?=thr_[A-Za-z0-9_-]+$)/u, ""),
);

const program = new Command();

program
  .name("room-cli")
  .description("Cloudroom CLI - manage your local and cloud agents")
  .enablePositionalOptions()
  .version(formatCloudroomVersion(resolveRoomCliVersion()));

const KNOWN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  ...CORE_COMMAND_GROUPS.map((group) => group.name),
  "help",
]);

type ContextEnvModule = typeof import("./context-env.js");

function createCommandGroupDeps(
  contextEnv: ContextEnvModule,
): CommandGroupDeps {
  let cliRuntimeContext: CliRuntimeContext | undefined;
  const getCliRuntimeContext = (): CliRuntimeContext =>
    (cliRuntimeContext ??= contextEnv.createCliRuntimeContext());
  return {
    getUrl: () => contextEnv.resolveServerUrl(getCliRuntimeContext()),
    getContext: () => contextEnv.resolveContextSnapshot(getCliRuntimeContext()),
  };
}

async function exitWhenIdle(code: number): Promise<void> {
  await (await import("./plugin-cli-proxy.js")).exitWhenIdle(code);
}

// Returns the exit code once the plugin path handled the command.
async function tryPluginCommandProxy(
  candidate: string,
  getUrl: () => string,
): Promise<number | undefined> {
  const proxy = await import("./plugin-cli-proxy.js");
  const result = await proxy.fetchPluginCliContributions(getUrl());
  if (result.outcome === "unreachable") {
    console.error(
      proxy.describeUnreachableServer(
        getUrl(),
        result.cause,
        result.lastTimeoutMs,
        result.attempts,
      ),
    );
    return 1;
  }
  if (result.outcome === "invalid") return;
  const match = proxy.findPluginCliCommand(result.contributions, candidate);
  if (match === undefined) {
    const disabledId = await proxy.findDisabledPluginForCommand(
      getUrl(),
      candidate,
    );
    if (disabledId !== null) {
      console.error(
        `room-cli ${candidate} is provided by the "${disabledId}" plugin, which is disabled — ` +
          `run \`room-cli plugin enable ${disabledId}\` or enable it in Plugins.`,
      );
      return 1;
    }
    return;
  }
  const argv = process.argv.slice(3);
  // `room-cli PLUGIN --help` always prints help: the plugin's own, or one built from its commands.
  if (match.rendersHelp !== true && isCommandHelp(argv)) {
    const help = await import("./plugin-cli-help.js");
    process.exit(await help.printPluginCommandHelp(getUrl(), match));
  }
  const command = match.commands.find((entry) => entry.name === argv[0]);
  if (
    command !== undefined &&
    match.rendersHelp !== true &&
    argv.slice(1).some((arg) => arg === "--help" || arg === "-h")
  ) {
    console.log(command.usage.replace(/^(bb|room|cloudroom) /, "room-cli "));
    return 0;
  }
  return proxy.runPluginCliCommand(getUrl(), match.pluginId, argv);
}

async function main(): Promise<void> {
  // `room-cli help loop` is `room-cli loop --help`: commander only knows the core commands.
  const helpTarget = process.argv[2] === "help" ? process.argv[3] : undefined;
  if (helpTarget !== undefined && !KNOWN_COMMAND_NAMES.has(helpTarget)) {
    process.argv.splice(2, 2, helpTarget, "--help");
  }
  const firstArg = process.argv[2];
  const groups = selectCommandGroups(firstArg);
  if (groups.length === 0) {
    await program.parseAsync(process.argv);
    return;
  }

  const [contextEnv, ...registrars] = await Promise.all([
    import("./context-env.js"),
    ...groups.map((group) => group.load()),
  ]);
  const deps = createCommandGroupDeps(contextEnv);

  // Set when the plugin commands could not be added to the top-level help.
  let pluginCommandsNote = "";
  program.addHelpText("after", () => {
    const context = deps.getContext();
    const project = context.projectId ?? "<unset>";
    const thread = context.threadId ?? "<unset>";

    return `${pluginCommandsNote}

Current context:
  ROOM_PROJECT_ID: ${project}
  ROOM_THREAD_ID: ${thread}
  ROOM_SERVER_URL: ${context.serverUrl}

Quick start:
  room-cli status
  room-cli project list
  room-cli thread show <id>
  room-cli thread spawn --project <id> --provider codex --prompt "..."
`;
  });

  for (const register of registrars) {
    register(program, deps);
  }

  // Top-level help lists the plugin commands too (loop, secret, gpu, ...).
  if (isTopLevelHelp(process.argv.slice(2))) {
    const help = await import("./plugin-cli-help.js");
    pluginCommandsNote = await help.addPluginCommandsToHelp(
      program,
      deps.getUrl(),
    );
  }

  const candidate = pluginProxyCandidate(firstArg, KNOWN_COMMAND_NAMES);
  if (candidate !== null) {
    const exitCode = await tryPluginCommandProxy(candidate, deps.getUrl);
    if (exitCode !== undefined) return exitWhenIdle(exitCode);
    // Commander rejects the unknown command: throw instead of process.exit() (#684).
    program.exitOverride();
  }
  await program.parseAsync(process.argv).catch((error: unknown) => {
    if (!(error instanceof CommanderError)) throw error;
    return exitWhenIdle(error.exitCode);
  });
}

main().catch(async (err) => {
  console.error(err.message);
  await exitWhenIdle(1);
});
