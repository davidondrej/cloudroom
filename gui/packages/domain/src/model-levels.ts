import type { AvailableModel } from "./provider-types.js";
import type { ReasoningLevel } from "./shared-types.js";

/** Claude and Codex models of about the same level, newest per level (docs/scopes/loop-fallback.md). */
export const MODEL_LEVELS: readonly {
  claude: string;
  claudeModel: string;
  claudeEfforts: readonly ReasoningLevel[];
  codex: string;
  codexModel: string;
}[] = [
  {
    claude: "fable",
    claudeModel: "claude-fable-5-2",
    claudeEfforts: ["low", "medium", "high", "xhigh", "max"],
    codex: "astra",
    codexModel: "gpt-6-astra",
  },
  {
    claude: "opus",
    claudeModel: "claude-opus-5-5",
    claudeEfforts: ["low", "medium", "high", "xhigh", "max"],
    codex: "sol",
    codexModel: "gpt-6.1-sol",
  },
  {
    claude: "sonnet",
    claudeModel: "claude-sonnet-5-5",
    claudeEfforts: ["low", "medium", "high", "max"],
    codex: "terra",
    codexModel: "gpt-6.1-terra",
  },
  {
    claude: "haiku",
    claudeModel: "claude-haiku-5-5",
    claudeEfforts: [],
    codex: "luna",
    codexModel: "gpt-6-luna",
  },
];

/** An unknown model counts as Opus ↔ Sol. With a Codex catalog, a missing family leaves the choice to the CLI default. */
export function sameLevelModel(
  model: string,
  fromProviderId: string,
  toProviderId: string,
  availableModels?: readonly AvailableModel[],
): string | null {
  const toCodex = fromProviderId === "claude-code" && toProviderId === "codex";
  if (
    !toCodex &&
    !(fromProviderId === "codex" && toProviderId === "claude-code")
  ) {
    return null;
  }
  const name = model.toLowerCase();
  const level =
    MODEL_LEVELS.find((entry) =>
      name.includes(toCodex ? entry.claude : entry.codex),
    ) ?? MODEL_LEVELS[1]!;
  if (!toCodex) return level.claudeModel;
  if (!availableModels) return level.codexModel;

  const family = new RegExp(`^gpt-\\d+(?:\\.\\d+)*-${level.codex}$`);
  const matches = availableModels
    .map(({ model }) => model)
    .filter((id) => family.test(id));
  matches.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  return matches[0] ?? null;
}
