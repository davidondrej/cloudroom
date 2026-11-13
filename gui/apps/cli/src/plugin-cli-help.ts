import type { Command } from "commander";
import { Writable } from "node:stream";
import {
  fetchPluginCliContributions,
  runPluginCliCommand,
  type PluginCliContributionEntry,
} from "./plugin-cli-proxy.js";

/** Help is one quick question, so it never waits long for a slow server. */
const HELP_TIMEOUT_MS = 1000;

/**
 * Adds the plugin commands (loop, secret, gpu, ...) to the top-level help, so
 * `room-cli --help` lists the whole CLI. Call it only when help will print:
 * the added commands do nothing.
 *
 * Returns a note for the help text when the commands could not be listed.
 */
export async function addPluginCommandsToHelp(
  program: Command,
  baseUrl: string,
): Promise<string> {
  const result = await fetchPluginCliContributions(baseUrl, HELP_TIMEOUT_MS, {
    lastWindowMs: 2 * HELP_TIMEOUT_MS,
  });
  if (result.outcome === "unreachable") {
    return `\n\nPlugin commands (loop, secret, gpu, ...) are not listed: Cloudroom is not reachable at ${baseUrl}.`;
  }
  if (result.outcome === "invalid") {
    return `\n\nPlugin commands (loop, secret, gpu, ...) are not listed: Cloudroom at ${baseUrl} ${result.detail}`;
  }
  const known = new Set(program.commands.map((command) => command.name()));
  for (const entry of result.contributions) {
    if (known.has(entry.name)) continue;
    known.add(entry.name);
    program.command(entry.name).description(entry.summary ?? "");
  }
  return "";
}

/** Help for one plugin command, built from what the app knows about it. */
export function renderPluginCommandHelp(
  entry: PluginCliContributionEntry,
): string {
  const usages = (entry.commands ?? []).map(
    (command) =>
      `  ${command.usage.replace(/^(bb|room|cloudroom) /, "room-cli ")}`,
  );
  return [
    `room-cli ${entry.name}: ${entry.summary}`,
    ...(usages.length > 0 ? ["", ...usages] : []),
  ].join("\n");
}

function collect(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
}

/**
 * Prints `room-cli PLUGIN --help`. A plugin that answers `--help` itself keeps
 * its own text. Most do not and fail with "Unknown flag --help": those get the
 * help built from their command list. Always exits 0.
 */
export async function printPluginCommandHelp(
  baseUrl: string,
  entry: PluginCliContributionEntry,
): Promise<number> {
  const [stdout, stderr] = [collect(), collect()];
  const exitCode = await runPluginCliCommand(
    baseUrl,
    entry.pluginId,
    ["--help"],
    { stdout: stdout.stream, stderr: stderr.stream },
  ).catch(() => 1);
  if (exitCode === 0 && stdout.text().trim().length > 0) {
    process.stdout.write(stdout.text());
    process.stderr.write(stderr.text());
  } else {
    console.log(renderPluginCommandHelp(entry));
  }
  return 0;
}
