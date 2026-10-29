import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  isStandaloneBuiltinContextCommand,
  isStandaloneBuiltinTeleportCommand,
  type PromptInput,
} from "@cloudroom/domain";
import { getAppSettings, type DbConnection } from "@cloudroom/db";
import { renderTemplate } from "@cloudroom/templates";
import { ApiError } from "../../errors.js";
import { listPluginInstructionContributions } from "../plugins/plugin-agent-contributions.js";

export const CUSTOM_INSTRUCTIONS_PLUGIN_ID = "custom-instructions";
export const PLUGIN_INSTRUCTION_MAX_CHARS = 4096;
/** The Organization plugin carries the team rules and one repo's rules, up to 4,000 characters each (ADR 0277). */
const ORG_INSTRUCTION_MAX_CHARS = 8_600;
export const pluginInstructionMaxChars = (pluginId: string) => (pluginId === "organization" ? ORG_INSTRUCTION_MAX_CHARS : PLUGIN_INSTRUCTION_MAX_CHARS);

type Context = { threadId: string; projectId: string };

/** `vps`: the account has its own VPS connected (ADR 0319), so its Cloud threads may run there. */
export function cloudroomSystemPrompt(db: DbConnection, options: { vps?: boolean } = {}): string | undefined {
  const settings = getAppSettings(db);
  return settings.systemPromptEnabled
    ? renderTemplate("standardAgentAppendInstructions", {
        bugReports: settings.bugReportsEnabled ? "on" : "",
        mac: process.platform === "win32" ? "" : "on",
        windows: process.platform === "win32" ? "on" : "",
        vps: options.vps ? "on" : "",
      })
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

export function appendCustomInstructions(
  input: PromptInput[],
  instructions: string,
): PromptInput[] {
  if (
    !instructions ||
    input.length === 0 ||
    isStandaloneBuiltinCompactCommand(input) ||
    isStandaloneBuiltinClearCommand(input) ||
    isStandaloneBuiltinTeleportCommand(input) ||
    isStandaloneBuiltinContextCommand(input)
  )
    return input;
  return [
    ...input,
    {
      type: "text",
      text: `\n<cloudroom_custom_instructions>\nThe user's current custom instructions for this message:\n${instructions}\n</cloudroom_custom_instructions>`,
      mentions: [],
      visibility: "agent-only",
    },
  ];
}

export function prepareCustomInstructionInput(
  context: Context,
  original: Input,
): Input {
  const instructions = resolveCustomInstructions(context);
  const input = appendCustomInstructions(original.input, instructions);
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
                  [...groups[groups.length - 1]!, input[input.length - 1]!],
                ],
        }),
  };
}

export function prepareCloudInstructionInput(
  prompt: { text: string; content?: unknown },
  instructions: string,
  limit: number,
): { text: string; content?: unknown } {
  const input: PromptInput[] = [
    { type: "text", text: prompt.text, mentions: [] },
  ];
  const enriched = appendCustomInstructions(input, instructions);
  const block = enriched === input ? null : enriched[enriched.length - 1]!;
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
            block && Array.isArray(prompt.content)
              ? [...prompt.content, block]
              : prompt.content,
        }),
  };
}
