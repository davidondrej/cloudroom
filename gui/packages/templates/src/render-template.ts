import {
  templateDefinitions,
  type TemplateId,
  type TemplateVariables,
} from "./generated/templates.generated.js";

const templateBodyById = Object.fromEntries(
  templateDefinitions.map((definition) => [definition.id, definition.body]),
) as Record<TemplateId, string>;

/** An innermost block: nothing inside it opens another. */
const IF_BLOCK =
  /^[ \t]*\{\{#if (\w+)\}\}[ \t]*\r?\n((?:(?!\{\{#if )[\s\S])*?)^[ \t]*\{\{\/if\}\}[ \t]*(?:\r?\n|$)/gmu;
const VARIABLE = /\{\{(\w+)\}\}/gu;
const UNSUPPORTED = /\\\{\{|\{\{(?!\w+\}\})|\{\{else\}\}/u;

/** Keeps or drops every `{{#if name}}` block, innermost first, so blocks can nest. */
function resolveBlocks(body: string, keep: (name: string) => boolean): string {
  for (;;) {
    const next = body.replace(IF_BLOCK, (_, name: string, block: string) =>
      keep(name) ? block : "",
    );
    if (next === body) return next;
    body = next;
  }
}

export function renderTemplate<TTemplateId extends TemplateId>(
  templateId: TTemplateId,
  variables: TemplateVariables[TTemplateId],
): string {
  const body = templateBodyById[templateId];
  if (UNSUPPORTED.test(resolveBlocks(body, () => true))) {
    throw new Error(`Template "${templateId}" uses unsupported syntax`);
  }
  const values: Record<string, string | undefined> = variables;
  return resolveBlocks(body, (name) => Boolean(values[name]))
    .replace(VARIABLE, (_, name: string) => values[name] ?? "")
    .trim();
}
