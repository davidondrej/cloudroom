import { Command } from "commander";
import { threadStatusValues } from "@cloudroom/domain";
import { action } from "../../action.js";
import { CLI_READ_TIMEOUT_MS, createCliRoomSdk } from "../../client.js";
import { resolveExplicitIdFlag } from "../../context-env.js";
import { joinValues, outputJson } from "../helpers.js";
import { parseStatus } from "./count.js";
import { pickFields, printJsonLines, printThreadTable } from "./list-output.js";

interface ThreadListCommandOptions {
  environment?: string;
  project?: string;
  parentThread?: string;
  archived?: boolean;
  includeArchived?: boolean;
  section?: string;
  unsectioned?: boolean;
  json?: boolean;
  includeHidden?: boolean;
  status?: string;
  provider?: string;
  machine?: string;
  pinned?: boolean;
  sort: string;
  limit?: string;
  all?: boolean;
  fields?: string;
}

/** The table is for reading, so it stops here unless --limit or --all says otherwise. */
const DEFAULT_TABLE_ROWS = 50;
/** Past this many full JSON records, the command suggests a smaller output. */
const LARGE_JSON_ROWS = 100;
const SORT_ORDERS = ["updated", "created"] as const;
const MACHINES = ["local", "cloud"] as const;

export function registerListCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("list")
    .description(
      `List open (unarchived) threads, most recently updated first. The table shows ${DEFAULT_TABLE_ROWS}; --json prints every match`,
    )
    .option("--project <id>", "Filter by project ID (defaults to all projects)")
    .option(
      "--status <status>",
      `Filter by status: ${joinValues(threadStatusValues)}`,
    )
    .option("--provider <id>", "Filter by provider ID, such as claude-code")
    .option("--machine <target>", "Filter by where threads run: local or cloud")
    .option("--pinned", "Show only pinned threads")
    .option("--environment <id>", "Filter by environment ID")
    .option("--parent-thread <id>", "Filter by parent thread ID")
    .option("--section <id>", "Filter by thread section ID")
    .option("--unsectioned", "Show only threads outside sections")
    .option("--archived", "Show only archived threads")
    .option("--include-archived", "Include archived threads with open ones")
    .option("--include-hidden", "Include hidden threads")
    .option("--sort <order>", "Newest first by: updated or created", "updated")
    .option("--limit <count>", "Maximum threads to print")
    .option("--all", `Print every thread, not just ${DEFAULT_TABLE_ROWS}`)
    .option("--json", "Print machine-readable JSON output")
    .option(
      "--fields <keys>",
      "Print only these comma-separated JSON keys, one thread per line (implies --json)",
    )
    .action(
      action(async (opts: ThreadListCommandOptions) => {
        const sdk = createCliRoomSdk(getUrl(), CLI_READ_TIMEOUT_MS);
        const projectId = resolveExplicitIdFlag({
          flagName: "--project flag",
          value: opts.project,
        });
        const parentThreadId = resolveExplicitIdFlag({
          flagName: "--parent-thread",
          value: opts.parentThread,
        });
        const environmentId = resolveExplicitIdFlag({
          flagName: "--environment",
          value: opts.environment,
        });
        if (opts.section && opts.unsectioned) {
          throw new Error("Cannot combine --section with --unsectioned.");
        }
        if (opts.archived && opts.includeArchived) {
          throw new Error("Cannot combine --archived with --include-archived.");
        }
        if (opts.all && opts.limit !== undefined) {
          throw new Error("Cannot combine --all with --limit.");
        }
        const sectionId = resolveExplicitIdFlag({
          flagName: "--section",
          value: opts.section,
        });
        const json = opts.json === true || opts.fields !== undefined;
        // JSON has no default cap: scripts pipe it and need every match.
        const limit = opts.all
          ? undefined
          : opts.limit !== undefined
            ? parseLimit(opts.limit)
            : json
              ? undefined
              : DEFAULT_TABLE_ROWS;
        const found = await sdk.threads.list({
          ...(projectId ? { projectId } : {}),
          ...(environmentId ? { environmentId } : {}),
          ...(parentThreadId ? { parentThreadId } : {}),
          ...(opts.includeArchived ? {} : { archived: opts.archived === true }),
          ...(sectionId ? { sectionId } : {}),
          ...(opts.unsectioned ? { unsectioned: true } : {}),
          ...(opts.includeHidden ? { includeHidden: true } : {}),
          ...(opts.status ? { status: parseStatus(opts.status) } : {}),
          ...(opts.provider ? { providerId: opts.provider } : {}),
          ...(opts.machine
            ? {
                executionTarget: parseChoice(
                  "--machine",
                  opts.machine,
                  MACHINES,
                ),
              }
            : {}),
          ...(opts.pinned ? { pinned: true } : {}),
          sort: parseChoice("--sort", opts.sort, SORT_ORDERS),
          // One extra row tells us whether more exist.
          ...(limit !== undefined ? { limit: limit + 1 } : {}),
        });
        const hasMore = limit !== undefined && found.length > limit;
        const threads = hasMore ? found.slice(0, limit) : found;
        const moreNotice = `Showing the first ${limit} threads; more exist. Filter with --status, --provider, --machine, --pinned, or --project, or pass --limit <count> or --all.`;

        if (json) {
          if (opts.fields !== undefined) {
            printJsonLines(pickFields(threads, opts.fields));
          } else {
            outputJson({ json: true }, threads);
            if (threads.length > LARGE_JSON_ROWS) {
              console.error(
                `Tip: ${threads.length} full thread records. For smaller output add --fields id,title,status, a filter (--status, --provider, --machine, --pinned, --project), or --limit <count>.`,
              );
            }
          }
          if (hasMore) console.error(moreNotice);
          return;
        }
        if (threads.length === 0) {
          console.log("No threads found");
          return;
        }
        const projects = await sdk.projects.list({ includePersonal: false });
        const projectNames = new Map(
          projects.map((project) => [project.id, project.name]),
        );
        printThreadTable(threads, projectNames);
        if (hasMore) console.log(moreNotice);
      }),
    );
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      `Invalid --limit value '${value}'. Expected a positive whole number.`,
    );
  }
  return limit;
}

function parseChoice<Choice extends string>(
  flag: string,
  value: string,
  choices: readonly Choice[],
): Choice {
  const choice = choices.find((candidate) => candidate === value.trim());
  if (choice !== undefined) return choice;
  throw new Error(
    `Invalid ${flag} value '${value}'. Expected ${joinValues(choices)}.`,
  );
}
