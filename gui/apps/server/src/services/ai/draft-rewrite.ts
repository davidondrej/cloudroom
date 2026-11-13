import { Type } from "@earendil-works/pi-ai";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { readUiPreferences } from "../system/ui-preferences.js";
import { namingFallbackModel } from "../threads/title-generation.js";
import { inferenceCompleteWithFallback } from "./inference.js";

export type DraftRewriteMode = "options" | "shorter";

const optionsSchema = Type.Object({
  options: Type.Array(
    Type.Object({ style: Type.String(), rewrite: Type.String() }),
    { minItems: 3, maxItems: 3 },
  ),
});

const shorterSchema = Type.Object({ rewrite: Type.String() });

function prompt(
  mode: DraftRewriteMode,
  draft: string,
  selected: string,
  avoid: readonly string[],
): string {
  const task =
    mode === "options"
      ? `Write 3 different rewrites of the selected part. Make them clearly different from each other and from the original, for example softer, plainer, or warmer. For each one, put 2 to 4 words that say how it is different in "style", and put the new text itself in "rewrite".`
      : `Rewrite the selected part so that it is clearly shorter and keeps its meaning. Use at most ${Math.max(1, Math.floor(selected.split(/\s+/u).filter(Boolean).length * 0.7))} words. Put the new text in "rewrite".`;
  return `You help a user edit a draft that they will send themselves.

${task}

Rules:
- Rewrite only the selected part. Each rewrite must replace the selected part exactly and fit the text around it.
- Keep the language, the point of view and the facts of the draft.
- Keep the same kind of start and end as the selected part: if it is a full sentence, write full sentences.
- Do not add quotes, notes or explanations around a rewrite.

The full draft:
<draft>
${draft}
</draft>

The selected part:
<selected>
${selected}
</selected>${
    avoid.length === 0
      ? ""
      : `

The user already saw these rewrites. Write new ones that are clearly different from all of them:
${avoid.map((text) => `- ${text}`).join("\n")}`
  }`;
}

/** Rewrites of the selected part of a draft, from the fast helper model that names threads. */
export async function rewriteDraft(
  deps: LoggedWorkSessionDeps,
  args: {
    mode: DraftRewriteMode;
    draft: string;
    selected: string;
    avoid: readonly string[];
  },
): Promise<{ text: string; label: string }[]> {
  const model =
    readUiPreferences(deps)["threadNaming.model"].value ??
    deps.config.inferenceModel;
  const common = {
    fallbackModel: namingFallbackModel(deps.config, model),
    fallbackOnAnyError: true,
    label: "Draft rewrite",
    maxAttempts: 2,
    primaryModel: model,
    prompt: prompt(args.mode, args.draft, args.selected, args.avoid),
    retryDelayMs: 0,
    timeoutMs: 20_000,
  };
  let options: { text: string; label: string }[];
  if (args.mode === "shorter") {
    const result = await inferenceCompleteWithFallback(deps, {
      ...common,
      schema: shorterSchema,
    });
    options = [{ text: result?.rewrite.trim() ?? "", label: "Shorter" }];
  } else {
    const result = await inferenceCompleteWithFallback(deps, {
      ...common,
      schema: optionsSchema,
    });
    options = (result?.options ?? []).map((option) => ({
      text: option.rewrite.trim(),
      label: option.style.trim(),
    }));
  }
  const usable = options.filter(
    (option) => option.text.length > 0 && option.text !== option.label,
  );
  if (usable.length === 0) throw new Error("The model returned no rewrite.");
  return usable;
}
