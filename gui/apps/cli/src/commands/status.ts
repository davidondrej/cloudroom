import { Command } from "commander";
import type { ThreadTimelinePendingTodos } from "@cloudroom/domain";
import { BbRequestTimeoutError } from "@cloudroom/sdk";
import { action } from "../action.js";
import {
  resolveContextSnapshot,
  type ContextSnapshot,
} from "../context-env.js";
import { CLI_READ_TIMEOUT_MS, createCliRoomSdk } from "../client.js";
import { outputJson } from "./helpers.js";
import {
  type ThreadEnvironmentInfo,
  fetchEnvironmentInfo,
  printEnvironmentInfo,
} from "./environment-helpers.js";
import { printPendingTodos } from "./thread/pending-todos.js";
import { cloudIssue, cloudIssueText, type CloudIssue } from "./thread/helpers.js";

interface StatusPayload {
  serverUrl: string;
  dataDir: string | null;
  project: { id: string; name: string } | null;
  thread: {
    id: string;
    status: string;
    title: string | null;
    pinnedAt: number | null;
    archivedAt: number | null;
    parentThreadId: string | null;
    environment: ThreadEnvironmentInfo | null;
  } | null;
  childThreads: Array<{
    id: string;
    status: string;
    title: string | null;
    archivedAt: number | null;
    /** Why a Cloud child that hasn't started yet is still waiting. */
    cloud?: CloudIssue;
  }> | null;
  pendingTodos: ThreadTimelinePendingTodos | null;
  pluginsNeedingAttention: Array<{ id: string; status: string }>;
}

interface StatusCommandOptions {
  json?: boolean;
}

type ResolveServerUrl = () => string;
type ResolveStatusContext = () => ContextSnapshot;

export function registerStatusCommand(
  program: Command,
  getUrl: ResolveServerUrl,
  getContext: ResolveStatusContext = resolveContextSnapshot,
): void {
  program
    .command("status")
    .description("Show current context")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: StatusCommandOptions) => {
        const context = getContext();

        const payload: StatusPayload = {
          serverUrl: getUrl(),
          dataDir: null,
          project: null,
          thread: null,
          childThreads: null,
          pendingTodos: null,
          pluginsNeedingAttention: [],
        };

        let serverAvailable = false;
        const sdk = createCliRoomSdk(getUrl(), CLI_READ_TIMEOUT_MS);

        try {
          payload.dataDir = (await sdk.system.config()).dataDir;
          serverAvailable = true;
        } catch (error) {
          if (error instanceof BbRequestTimeoutError) throw error;
        }

        if (serverAvailable) {
          const { plugins } = await sdk.plugins.list();
          payload.pluginsNeedingAttention = plugins
            .filter(
              (p) =>
                p.enabled &&
                !p.isOrphanedBuiltin &&
                ["incompatible", "error", "missing"].includes(p.status),
            )
            .map((p) => ({ id: p.id, status: p.status }));
        }

        if (context.projectId || context.threadId) {
          const status = await sdk.status.get({
            projectId: context.projectId,
            threadId: context.threadId,
          });

          if (status.project) {
            payload.project = {
              id: status.project.id,
              name: status.project.name,
            };
            serverAvailable = true;
          }

          if (status.thread) {
            let environmentInfo: ThreadEnvironmentInfo | null = null;
            if (status.thread.environmentId) {
              environmentInfo = await fetchEnvironmentInfo({
                environmentId: status.thread.environmentId,
                sdk,
              });
            }

            payload.pendingTodos = status.pendingTodos;
            payload.thread = {
              id: status.thread.id,
              status: status.thread.status,
              title: status.thread.title ?? null,
              pinnedAt: status.thread.pinnedAt,
              archivedAt: status.thread.archivedAt,
              parentThreadId: status.thread.parentThreadId ?? null,
              environment: environmentInfo,
            };
            serverAvailable = true;

            if (status.childThreads) {
              // Only Cloud children not started yet are asked, briefly and best effort: the status above is already known.
              payload.childThreads = await Promise.all(status.childThreads.map(async (thread) => {
                const cloud = thread.executionTarget === "cloud" && ["pending", "starting"].includes(thread.status) && thread.archivedAt == null
                  ? cloudIssue(await sdk.cloudroom.threadStatus(thread.id, AbortSignal.timeout(5_000)).catch(() => null))
                  : null;
                return { id: thread.id, status: thread.status, title: thread.title ?? null, archivedAt: thread.archivedAt ?? null, ...(cloud ? { cloud } : {}) };
              }));
            }
          }
        }

        if (outputJson(opts, payload)) return;

        console.log(`Cloudroom server: ${payload.serverUrl}`);
        console.log("");

        if (serverAvailable && payload.project) {
          console.log(
            `Project: ${payload.project.name} (${payload.project.id})`,
          );
        } else if (context.projectId) {
          console.log(`Project: ${context.projectId}`);
        } else {
          console.log("Project: (not set)");
        }

        console.log("");

        if (serverAvailable && payload.thread) {
          console.log(`Thread: ${payload.thread.id}`);
          console.log(
            `  Status: ${payload.thread.status}${payload.thread.archivedAt !== null ? " (archived)" : ""}`,
          );
          if (payload.thread.title) {
            console.log(`  Title: ${payload.thread.title}`);
          }
          if (payload.thread.pinnedAt !== null) {
            console.log(
              `  Pinned: ${new Date(payload.thread.pinnedAt).toLocaleString()}`,
            );
          }
          if (payload.thread.parentThreadId) {
            console.log(`  Parent: ${payload.thread.parentThreadId}`);
          }
          if (payload.thread.environment) {
            printEnvironmentInfo(payload.thread.environment);
          }

          if (payload.childThreads && payload.childThreads.length > 0) {
            console.log("");
            console.log(`Child threads: ${payload.childThreads.length}`);
            for (const mt of payload.childThreads) {
              const title = mt.title ? `"${mt.title}"` : "";
              const archived = mt.archivedAt !== null ? " (archived)" : "";
              console.log(`  ${mt.id}  ${mt.status}${archived}  ${title}`);
              const note = cloudIssueText(mt.cloud ?? null);
              if (note) console.log(`    Cloud: ${note}`);
            }
          }

          printPendingTodos(payload.pendingTodos);
        } else if (context.threadId) {
          console.log(`Thread: ${context.threadId}`);
        } else {
          console.log("Thread: (not set)");
        }

        if (payload.dataDir) {
          console.log("");
          console.log(`Data dir: ${payload.dataDir}`);
        }

        const attention = payload.pluginsNeedingAttention;
        if (attention.length > 0) {
          console.log("");
          console.log(
            `${attention.length} plugin${attention.length === 1 ? "" : "s"} not running (${attention.map((p) => `${p.id}: ${p.status}`).join(", ")}). Run room-cli plugin list.`,
          );
        }

        if (!context.projectId && !context.threadId) {
          console.log("");
          console.log("Tip: run room-cli guide for help getting started.");
        }
      }),
    );
}
