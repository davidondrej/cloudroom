#!/usr/bin/env node
import { Command } from "commander";
import { maybeReexecViaRoomCli } from "./room-cli-reexec.js";
import {
  CORE_COMMAND_GROUPS,
  type CommandGroupDeps,
  pluginProxyCandidate,
  selectCommandGroups,
} from "./command-groups.js";
import { formatCloudroomVersion, resolveBbCliVersion } from "./version.js";
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
  .version(formatCloudroomVersion(resolveBbCliVersion()));

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

async function tryPluginCommandProxy(
  candidate: string,
  getUrl: () => string,
): Promise<void> {
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
    process.exit(1);
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
      process.exit(1);
    }
    return;
  }
  const argv = process.argv.slice(3);
  const command = match.commands.find((entry) => entry.name === argv[0]);
  if (
    command !== undefined &&
    match.rendersHelp !== true &&
    argv.slice(1).some((arg) => arg === "--help" || arg === "-h")
  ) {
    console.log(command.usage.replace(/^(bb|room|cloudroom) /, "room-cli "));
    process.exit(0);
  }
  process.exit(await proxy.runPluginCliCommand(getUrl(), match.pluginId, argv));
}

async function main(): Promise<void> {
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

  program.addHelpText("after", () => {
    const context = deps.getContext();
    const project = context.projectId ?? "<unset>";
    const thread = context.threadId ?? "<unset>";

    return `

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

  const candidate = pluginProxyCandidate(firstArg, KNOWN_COMMAND_NAMES);
  if (candidate !== null) {
    await tryPluginCommandProxy(candidate, deps.getUrl);
  }
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
