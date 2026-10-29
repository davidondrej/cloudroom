import { availableModelSchema, type AvailableModel } from "@cloudroom/domain";
import { z } from "zod";

const modelListResultSchema = z.object({
  models: z.array(availableModelSchema),
  selectedOnlyModels: z.array(availableModelSchema),
});

interface ParsedModelListResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

export function parseAvailableModelList(
  result: unknown,
): ParsedModelListResult {
  return modelListResultSchema.parse(result);
}
