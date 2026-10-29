import {
  templateDefinitions,
  type TemplateId,
  type TemplateVariables,
} from "./generated/templates.generated.js";

const templateBodyById = Object.fromEntries(
  templateDefinitions.map((definition) => [definition.id, definition.body]),
) as Record<TemplateId, string>;

const IF_BLOCK =
  /^[ \t]*\{\{#if (\w+)\}\}[ \t]*\r?\n([\s\S]*?)^[ \t]*\{\{\/if\}\}[ \t]*(?:\r?\n|$)/gmu;
const VARIABLE = /\{\{(\w+)\}\}/gu;
const UNSUPPORTED = /\\\{\{|\{\{(?!\w+\}\})|\{\{else\}\}/u;

export function renderTemplate<TTemplateId extends TemplateId>(
  templateId: TTemplateId,
  variables: TemplateVariables[TTemplateId],
): string {
  const body = templateBodyById[templateId];
  if (UNSUPPORTED.test(body.replace(IF_BLOCK, "$2"))) {
    throw new Error(`Template "${templateId}" uses unsupported syntax`);
  }
  const values: Record<string, string | undefined> = variables;
  return body
    .replace(IF_BLOCK, (_, name: string, block: string) =>
      values[name] ? block : "",
    )
    .replace(VARIABLE, (_, name: string) => values[name] ?? "")
    .trim();
}
