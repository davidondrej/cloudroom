import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  combinedInstructions,
  lengthError,
  ruleChangeSchema,
  ruleSchema,
  sameTarget,
  type InstructionRule,
  type RuleChange,
} from "./rules.js";
export { MAX_CUSTOM_INSTRUCTIONS_LENGTH } from "./rules.js";

const STORAGE_KEY = "customInstructions";
const RULES_KEY = "scopedInstructions";
const rulesSchema = z.array(ruleSchema);
const rpc = defineRpcContract({
  listRules: { input: z.null(), output: rulesSchema },
  changeRule: { input: ruleChangeSchema, output: rulesSchema },
});

export default async function plugin(room: BbPluginApi) {
  let rules = rulesSchema.parse((await room.storage.kv.get(RULES_KEY)) ?? []);
  const customInstructionsSchema = z
    .string()
    .max(
      MAX_CUSTOM_INSTRUCTIONS_LENGTH,
      "Custom instructions must be at most 4096 characters",
    )
    .superRefine((global, ctx) => {
      const error = lengthError(global, rules);
      if (error) ctx.addIssue({ code: "custom", message: error });
    });
  const settings = room.settings.define({
    instructions: {
      type: "string",
      label: "Custom instructions",
      description:
        "Give agents extra instructions and context for tasks on this Cloudroom host.",
      experimental_multiline: true,
      experimental_schema: customInstructionsSchema,
      default: "",
    },
  });

  let current = await settings.get();
  const legacy = await room.storage.kv.get<string>(STORAGE_KEY);
  if (legacy !== undefined) {
    if (current.instructions.length === 0 && legacy.length > 0) {
      current = await settings.experimental_set({ instructions: legacy });
    }
    await room.storage.kv.delete(STORAGE_KEY);
  }
  let customInstructions = current.instructions;

  settings.onChange((next) => {
    customInstructions = next.instructions;
  });

  room.agents.contributeInstructions(
    ({ experimental_execution }) =>
      combinedInstructions(customInstructions, rules, experimental_execution) ||
      null,
  );

  // Edits from separate windows and the CLI share one read/validate/write sequence.
  let pending = Promise.resolve();
  function changeRule(change: RuleChange): Promise<InstructionRule[]> {
    const result = pending.then(async () => {
      const existing = rules.find((rule) => sameTarget(rule, change));
      if ((existing?.text ?? null) !== change.expected) {
        throw new Error(
          "This target changed. Reload its saved instructions before editing.",
        );
      }
      const next = rules.filter((rule) => !sameTarget(rule, change));
      if (change.text !== null) next.push(ruleSchema.parse(change));
      const error = lengthError(customInstructions, next);
      if (error) throw new Error(error);
      await room.storage.kv.set(RULES_KEY, next);
      rules = next;
      return next;
    });
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  room.rpc.register(rpc, { listRules: () => rules, changeRule });

  room.cli.register({
    name: "instructions",
    summary: "Read and update the custom instructions injected into agents",
    commands: [
      {
        name: "list",
        summary: "List harness and model instructions",
        usage: "room-cli instructions list [--json]",
      },
      {
        name: "set-rule",
        summary: "Save harness or model instructions",
        usage: "room-cli instructions set-rule <harness> <model|*> <text...>",
      },
      {
        name: "clear-rule",
        summary: "Remove harness or model instructions",
        usage: "room-cli instructions clear-rule <harness> <model|*>",
      },
      {
        name: "get",
        summary: "Print the current custom instructions",
        usage: "room-cli instructions get [--json]",
      },
      {
        name: "set",
        summary: "Replace the custom instructions",
        usage: "room-cli instructions set <text...> [--json]",
      },
      {
        name: "clear",
        summary: "Clear the custom instructions",
        usage: "room-cli instructions clear [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const positional = argv.filter((value) => value !== "--json");
      const [command, ...rest] = positional;
      if (command === "list")
        return {
          exitCode: 0,
          stdout: JSON.stringify(rules, null, json ? undefined : 2),
        };
      if (command === "set-rule" || command === "clear-rule") {
        const [providerId, modelId, ...words] = rest;
        const target = { providerId, model: modelId === "*" ? null : modelId };
        const existing = rules.find(
          (rule) =>
            rule.providerId === providerId && rule.model === target.model,
        );
        const change = ruleChangeSchema.parse({
          ...target,
          expected: existing?.text ?? null,
          text: command === "clear-rule" ? null : words.join(" "),
          modelLabel: existing?.modelLabel,
        });
        const next = await changeRule(change);
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(next) : "Instructions updated",
        };
      }
      if (command === "get") {
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ instructions: customInstructions })
            : customInstructions,
        };
      }
      if (command === "set") {
        const parsed = customInstructionsSchema.safeParse(rest.join(" "));
        if (!parsed.success) {
          throw new Error(
            parsed.error.issues[0]?.message ?? "invalid instructions",
          );
        }
        const next = await settings.experimental_set({
          instructions: parsed.data,
        });
        customInstructions = next.instructions;
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ instructions: customInstructions })
            : "Custom instructions updated",
        };
      }
      if (command === "clear") {
        const next = await settings.experimental_set({ instructions: "" });
        customInstructions = next.instructions;
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ instructions: "" })
            : "Custom instructions cleared",
        };
      }
      return {
        exitCode: 1,
        stderr:
          "Usage: room-cli instructions get|set|clear|list|set-rule|clear-rule [--json]",
      };
    },
  });
}
