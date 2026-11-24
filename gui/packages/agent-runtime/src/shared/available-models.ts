import {
  availableModelSchema,
  reasoningLevelSchema,
  reasoningLevelValues,
  type AvailableModel,
} from "@cloudroom/domain";
import { z } from "zod";

const modelListResultSchema = z.object({
  models: z.array(z.unknown()),
  selectedOnlyModels: z.array(z.unknown()),
});

interface ParsedModelListResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
  warnings: string[];
}

/**
 * Parses a bridge's `model/list` result one model at a time, so one bad entry
 * never empties the catalog. Reasoning IDs outside the ladder are dropped from
 * their model, and a model that is still invalid is skipped alone. Throws only
 * when the outer shape is wrong or no listed model survives.
 */
export function parseAvailableModelList(
  result: unknown,
): ParsedModelListResult {
  const raw = modelListResultSchema.parse(result);
  const warnings: string[] = [];
  let firstError: z.ZodError | null = null;
  const parseModels = (entries: unknown[]): AvailableModel[] =>
    entries.flatMap((entry) => {
      const parsed = availableModelSchema.safeParse(
        keepLadderEfforts(entry, warnings),
      );
      if (parsed.success) return [parsed.data];
      firstError ??= parsed.error;
      warnings.push(
        `skipped invalid model ${modelLabel(entry)} (${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")})`,
      );
      return [];
    });
  const models = parseModels(raw.models);
  const selectedOnlyModels = parseModels(raw.selectedOnlyModels);
  if (firstError !== null && models.length + selectedOnlyModels.length === 0) {
    throw firstError;
  }
  return { models, selectedOnlyModels, warnings };
}

const effortId = (effort: unknown): unknown =>
  typeof effort === "object" && effort !== null
    ? Reflect.get(effort, "reasoningEffort")
    : undefined;

const isCustomId = (id: unknown): id is string =>
  typeof id === "string" && !reasoningLevelSchema.safeParse(id).success;

function keepLadderEfforts(entry: unknown, warnings: string[]): unknown {
  if (typeof entry !== "object" || entry === null) return entry;
  const efforts: unknown = Reflect.get(entry, "supportedReasoningEfforts");
  const defaultEffort: unknown = Reflect.get(entry, "defaultReasoningEffort");
  if (!Array.isArray(efforts)) return entry;
  const dropped = efforts.map(effortId).filter(isCustomId);
  if (dropped.length === 0 && !isCustomId(defaultEffort)) return entry;
  const kept = efforts.filter((effort) => !isCustomId(effortId(effort)));
  if (dropped.length > 0) {
    warnings.push(
      `model ${modelLabel(entry)}: dropped unsupported reasoning IDs ${dropped.map((id) => JSON.stringify(id)).join(", ")}; map them to ${reasoningLevelValues.join(", ")}`,
    );
  }
  return {
    ...entry,
    supportedReasoningEfforts: kept,
    defaultReasoningEffort: isCustomId(defaultEffort)
      ? (effortId(kept[0]) ?? "medium")
      : defaultEffort,
  };
}

function modelLabel(entry: unknown): string {
  const id =
    typeof entry === "object" && entry !== null
      ? Reflect.get(entry, "id")
      : undefined;
  return typeof id === "string" ? JSON.stringify(id) : "without an id";
}
