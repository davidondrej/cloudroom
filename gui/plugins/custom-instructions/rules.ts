import { z } from "zod";

export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 4096;
const id = z.string().trim().min(1);
export const targetSchema = z.object({ providerId: id, model: id.nullable() });
export const ruleSchema = targetSchema.extend({
  text: z.string().trim().min(1).max(MAX_CUSTOM_INSTRUCTIONS_LENGTH),
  modelLabel: z.string().optional(),
});
export type InstructionRule = z.infer<typeof ruleSchema>;
export type InstructionTarget = z.infer<typeof targetSchema>;
export const ruleChangeSchema = targetSchema.extend({
  text: ruleSchema.shape.text.nullable(),
  modelLabel: ruleSchema.shape.modelLabel,
  // null means the target must still be empty when this change is saved.
  expected: z.string().nullable(),
});
export type RuleChange = z.infer<typeof ruleChangeSchema>;

export function sameTarget(
  rule: InstructionTarget,
  target: InstructionTarget,
): boolean {
  return rule.providerId === target.providerId && rule.model === target.model;
}

export function combinedInstructions(
  global: string,
  rules: readonly InstructionRule[],
  target?: InstructionTarget,
) {
  const harness =
    target &&
    rules.find(
      (rule) => rule.providerId === target.providerId && rule.model === null,
    );
  const model = target?.model && rules.find((rule) => sameTarget(rule, target));
  return [global.trim(), harness?.text, model && model.text]
    .filter(Boolean)
    .join("\n\n");
}

export function lengthError(
  global: string,
  rules: readonly InstructionRule[],
): string | null {
  for (const target of rules) {
    const excess =
      combinedInstructions(global, rules, target).length -
      MAX_CUSTOM_INSTRUCTIONS_LENGTH;
    if (excess > 0) {
      return `Instructions for ${target.providerId}${target.model ? " / " + target.model : ""} exceed 4,096 characters. Shorten them by ${excess}.`;
    }
  }
  return null;
}
