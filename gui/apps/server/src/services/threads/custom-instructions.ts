import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  isStandaloneBuiltinContextCommand,
  isStandaloneBuiltinTeleportCommand,
  type PromptInput,
  type HostPlatform,
} from "@cloudroom/domain";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getAppSettings, getHost, latestContextResetSequence, threadCustomInstructions as sent, type DbConnection, type DbQueryConnection } from "@cloudroom/db";
import { renderTemplate } from "@cloudroom/templates";
import { ApiError } from "../../errors.js";
import { listPluginInstructionContributions } from "../plugins/plugin-agent-contributions.js";

export const CUSTOM_INSTRUCTIONS_PLUGIN_ID = "custom-instructions";
export const PLUGIN_INSTRUCTION_MAX_CHARS = 4096;
/** The Organization plugin carries the team rules and one repo's rules, up to 4,000 characters each (ADR 0277). */
const ORG_INSTRUCTION_MAX_CHARS = 8_600;
export const pluginInstructionMaxChars = (pluginId: string) => (pluginId === "organization" ? ORG_INSTRUCTION_MAX_CHARS : PLUGIN_INSTRUCTION_MAX_CHARS);

type Context = { threadId: string; projectId: string; hostId?: string };

function osName(platform: string | null | undefined): string {
  switch (platform) {
    case "darwin": return "macOS";
    case "linux": return "Linux";
    case "wsl": return "Linux (WSL)";
    case "win32": return "Windows";
    default: return "unknown";
  }
}

/** Core runs on Linux; a Local thread uses its selected host, not necessarily the app server. */
export function cloudroomMachineContext(db: DbQueryConnection, kind: "local" | "cloud", executionPlatform?: HostPlatform | null): string {
  if (!getAppSettings(db).systemPromptEnabled) return "";
  return `[Cloudroom machine context — replaces earlier machine details]\nThread execution: ${kind === "local" ? "Local" : "Cloud"}; execution OS: ${osName(kind === "cloud" ? "linux" : executionPlatform)}; paired computer OS: ${osName(process.platform)}.\nThe room-cli mac command names the paired-computer bridge; it does not identify that computer's OS.`;
}

function appendMachineContext(input: PromptInput[], text: string): PromptInput[] {
  return text ? [...input, { type: "text", text: `\n${text}`, mentions: [], visibility: "agent-only" }] : input;
}

/**
 * The system prompt for a Local or a Cloud thread: the shared lines plus that kind's own.
 * `vps`: the account has its own VPS connected (ADR 0319), so its Cloud threads may run there.
 */
export function cloudroomSystemPrompt(db: DbConnection, kind: "local" | "cloud", options: { vps?: boolean; executionPlatform?: HostPlatform | null } = {}): string | undefined {
  const settings = getAppSettings(db);
  const platform = kind === "local" ? options.executionPlatform : process.platform;
  return settings.systemPromptEnabled
    ? [cloudroomMachineContext(db, kind, options.executionPlatform), renderTemplate("standardAgentAppendInstructions", {
        local: kind === "local" ? "on" : "",
        cloud: kind === "cloud" ? "on" : "",
        bugReports: settings.bugReportsEnabled ? "on" : "",
        mac: platform === "win32" ? "" : "on",
        windows: platform === "win32" ? "on" : "",
        vps: options.vps ? "on" : "",
      })].join("\n\n")
    : undefined;
}
type Input = { input: PromptInput[]; inputGroups?: PromptInput[][] };

/** Plugins whose instructions also reach Cloud threads, in their system prompt. Local threads get every plugin's
 *  (thread-runtime-config.ts); others, like Connect's remote-viewing hint, only fit Local threads. */
const CLOUD_INSTRUCTION_PLUGINS = new Set(["organization"]);
export function cloudPluginInstructions(context: Context): string | undefined {
  const sections = listPluginInstructionContributions()
    .filter(({ pluginId }) => CLOUD_INSTRUCTION_PLUGINS.has(pluginId))
    .flatMap(({ pluginId, provider }) => {
      let text: string | null = null;
      try { text = provider(context); } catch { return []; }
      return text?.trim() ? [`The following instructions come from the Cloudroom plugin "${pluginId}":\n${text.slice(0, pluginInstructionMaxChars(pluginId))}`] : [];
    });
  return sections.length ? sections.join("\n\n") : undefined;
}

export function resolveCustomInstructions(context: Context): string {
  const contribution = listPluginInstructionContributions().find(
    ({ pluginId }) => pluginId === CUSTOM_INSTRUCTIONS_PLUGIN_ID,
  );
  const text = contribution?.provider(context) ?? "";
  if (text.length > PLUGIN_INSTRUCTION_MAX_CHARS) {
    throw new ApiError(
      400,
      "invalid_request",
      "Custom instructions exceed 4096 characters. Shorten them in Settings.",
    );
  }
  return text.trim();
}

/** A thread gets its instructions again after this many messages, in case its agent drifted. */
const RESEND_AFTER_MESSAGES = 20;
const REMOVED = "None now. The user removed them, so the earlier ones no longer apply.";
const BLOCK = "<cloudroom_custom_instructions>";
const hashOf = (text: string) => (text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : "");

/**
 * The custom instructions this message must carry, or "" while the thread's agent still has the current ones.
 * A thread gets them on its first message, after they change, after its context is compacted or cleared, after the
 * copy it had may be lost (markCustomInstructionsLost), and every RESEND_AFTER_MESSAGES messages.
 * `fresh`: earlier messages may be gone (a new agent session, a rewind, an edited message), so send them again.
 * A thread that once had instructions and now has none is told so, the same way.
 */
export function dueCustomInstructions(db: DbQueryConnection, context: Context, fresh = false): string {
  const text = resolveCustomInstructions(context);
  const last = db.select().from(sent).where(eq(sent.threadId, context.threadId)).get();
  if (!text && !last) return "";
  const hash = hashOf(text);
  const resetAt = latestContextResetSequence(db, context.threadId);
  const has = last && !fresh && !last.resend && last.resetAt === resetAt && last.hash === hash;
  if (has && (!text || last.messages < RESEND_AFTER_MESSAGES)) {
    db.update(sent).set({ messages: last.messages + 1 }).where(eq(sent.threadId, context.threadId)).run();
    return "";
  }
  const row = { hash, resetAt, messages: 1, resend: false };
  db.insert(sent).values({ threadId: context.threadId, ...row }).onConflictDoUpdate({ target: sent.threadId, set: row }).run();
  return text || REMOVED;
}

/** The thread's copy may be gone: its message was cancelled or failed, or its agent got a new session. The next message carries one. */
export function markCustomInstructionsLost(db: DbQueryConnection, threadId: string): void {
  db.update(sent).set({ resend: true }).where(eq(sent.threadId, threadId)).run();
}

/** Whether a message carries the instructions block. */
export function carriesCustomInstructions(input: readonly PromptInput[]): boolean {
  return input.some((part) => part.type === "text" && part.text.includes(BLOCK));
}

/** Commands and empty messages never reach the agent as a message, so they carry no instructions. */
function takesInstructions(input: PromptInput[]): boolean {
  return input.length > 0 &&
    !isStandaloneBuiltinCompactCommand(input) &&
    !isStandaloneBuiltinClearCommand(input) &&
    !isStandaloneBuiltinTeleportCommand(input) &&
    !isStandaloneBuiltinContextCommand(input);
}

export function appendCustomInstructions(
  input: PromptInput[],
  instructions: string,
): PromptInput[] {
  if (!instructions || !takesInstructions(input)) return input;
  return [
    ...input,
    {
      type: "text",
      text: `\n${BLOCK}\nThe user's custom instructions. They apply to this whole thread until replaced:\n${instructions}\n</cloudroom_custom_instructions>`,
      mentions: [],
      visibility: "agent-only",
    },
  ];
}

/** `fresh`: this message starts a new agent session, which may have nothing from before. */
export function prepareCustomInstructionInput(
  db: DbQueryConnection,
  context: Context,
  original: Input,
  fresh = false,
): Input {
  const takes = takesInstructions(original.input);
  // A new session that starts without a message gets them with its first one.
  if (fresh && !takes) markCustomInstructionsLost(db, context.threadId);
  const custom = takes
    ? appendCustomInstructions(original.input, dueCustomInstructions(db, context, fresh))
    : original.input;
  // Refresh even an existing agent's history before its next turn, including after a move.
  const input = takes && context.hostId
    ? appendMachineContext(custom, cloudroomMachineContext(db, "local", getHost(db, context.hostId)?.platform))
    : custom;
  const groups = original.inputGroups;
  if (input === original.input) {
    return { input, ...(groups === undefined ? {} : { inputGroups: groups }) };
  }
  return {
    input,
    ...(groups === undefined
      ? {}
      : {
          inputGroups:
            groups.length === 0
              ? [input]
              : [
                  ...groups.slice(0, -1),
                  [...groups[groups.length - 1]!, ...input.slice(original.input.length)],
                ],
        }),
  };
}

export function prepareCloudInstructionInput(
  prompt: { text: string; content?: unknown },
  instructions: string,
  limit: number,
  db?: DbQueryConnection,
  savedMachineContext?: string,
): { text: string; content?: unknown } {
  const input: PromptInput[] = [
    { type: "text", text: prompt.text, mentions: [] },
  ];
  const enriched = appendMachineContext(appendCustomInstructions(input, instructions), savedMachineContext ?? (db && takesInstructions(input) ? cloudroomMachineContext(db, "cloud") : ""));
  const blocks = enriched.slice(input.length);
  const text = enriched
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > limit) {
    throw new ApiError(
      400,
      "invalid_request",
      `Message plus custom instructions is too long (${Math.ceil(bytes / 1024)} KB). Cloud messages can be up to ${limit / 1024} KB. Shorten the message or custom instructions.`,
    );
  }
  return {
    text,
    ...(prompt.content === undefined
      ? {}
      : {
          content:
            blocks.length && Array.isArray(prompt.content)
              ? [...prompt.content, ...blocks.map((part) => part.type === "text" ? { type: "text", text: part.text } : part)]
              : prompt.content,
        }),
  };
}
