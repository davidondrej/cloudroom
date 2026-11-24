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
  return newestModel(availableModels.map(({ model }) => model), level.codex);
}

/** The newest model of a family ("astra", "opus", "neon") in a harness's own list: gpt-6.2-astra beats gpt-6-astra, and a 1M twin wins a tie. */
export function newestModel(models: readonly string[], family: string): string | null {
  const pattern = new RegExp(`^(?:(?:gpt|gemini)-(\\d+(?:\\.\\d+)*)-${family}|claude-${family}-(\\d+(?:-\\d{1,2})?)(?:-\\d{8})?)(\\[1m\\])?$`);
  let best: { id: string; score: number } | null = null;
  for (const id of models) {
    const match = pattern.exec(id);
    if (!match) continue;
    const [major = 0, minor = 0, patch = 0] = (match[1] ?? match[2]!).split(/[.-]/).map(Number);
    const score = ((major * 1000 + minor) * 1000 + patch) * 2 + (match[3] ? 1 : 0);
    if (!best || score > best.score) best = { id, score };
  }
  return best?.id ?? null;
}
