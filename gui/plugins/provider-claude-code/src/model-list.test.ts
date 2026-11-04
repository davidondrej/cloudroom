import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  applyClaudeEffortSettings,
  buildClaudeCodeModels,
} from "./model-list.js";

const DISCOVERED_MODELS: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Default (recommended)",
    description: "Opus 5 with 1M context",
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus",
    description: "Opus 5 with 1M context",
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1",
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5",
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Fastest for quick answers",
  },
];

const CURATED_MODELS = [
  "claude-opus-5-5[1m]",
  "claude-fable-5-1",
  "claude-opus-5[1m]",
  "claude-opus-4-8[1m]",
  "claude-opus-4-7[1m]",
  "claude-sonnet-5",
];

describe("buildClaudeCodeModels", () => {
  it("always offers the curated catalog and appends discovered extras", () => {
    const result = buildClaudeCodeModels(DISCOVERED_MODELS);

    expect(result.models.map((model) => model.model)).toEqual([
      ...CURATED_MODELS,
      "claude-haiku-4-5-20251001",
    ]);
    expect(result.models.find((model) => model.isDefault)?.model).toBe(
      "claude-opus-5[1m]",
    );
    expect(result.selectedOnlyModels.map((model) => model.model)).toEqual([
      "opus[1m]",
      "sonnet",
      "haiku",
    ]);
    expect(result.models.map((model) => model.displayName)).toEqual([
      "Opus 5.5 (1M)",
      "Fable 5.1",
      "Opus 5 (1M)",
      "Opus 4.8 (1M)",
      "Opus 4.7 (1M)",
      "Sonnet 5",
      "Haiku 4.5",
    ]);
    expect(
      result.selectedOnlyModels.map((model) => model.displayName),
    ).toEqual(["Opus 5 (1M, alias)", "Sonnet 5 (alias)", "Haiku 4.5 (alias)"]);
    expect(
      [...result.models, ...result.selectedOnlyModels].some(
        (model) => model.model === "claude-mythos-5",
      ),
    ).toBe(false);
  });

  it("still offers the curated catalog when the provider reports no models", () => {
    const result = buildClaudeCodeModels([]);

    expect(result.models.map((model) => model.model)).toEqual(CURATED_MODELS);
    expect(result.models.find((model) => model.isDefault)?.model).toBe(
      "claude-opus-5[1m]",
    );
    expect(result.selectedOnlyModels).toEqual([]);
  });

  it("keeps authoritative models that do not have curated metadata yet", () => {
    const result = buildClaudeCodeModels([
      {
        value: "future",
        resolvedModel: "claude-future-6",
        displayName: "Future 6",
        description: "Newly discovered model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
    ]);

    expect(result.models.map((model) => model.model)).toEqual([
      ...CURATED_MODELS,
      "claude-future-6",
    ]);
    expect(result.models.at(-1)).toEqual(
      expect.objectContaining({
        model: "claude-future-6",
        displayName: "Future 6",
        isDefault: false,
        defaultReasoningEffort: "high",
      }),
    );
  });

  it("prefers the discovered default model", () => {
    const result = buildClaudeCodeModels([
      {
        value: "default",
        resolvedModel: "claude-sonnet-5",
        displayName: "Default (recommended)",
        description: "Sonnet 5",
      },
    ]);

    expect(result.models.find((model) => model.isDefault)?.model).toBe(
      "claude-sonnet-5",
    );
  });
});

const OPUS = "claude-opus-5-5[1m]";
const perModel = (model: string, effortLevel: string) => ({
  modelSettings: { [model]: { effortLevel } },
});

// #656: per-model setting (no [1m], aliases resolved), then effortLevel.
it.each([
  [{}, "high", OPUS],
  [{ effortLevel: "xhigh" }, "xhigh", OPUS],
  [
    { effortLevel: "xhigh", ...perModel("claude-opus-5-5", "low") },
    "low",
    OPUS,
  ],
  [
    { effortLevel: "low", ...perModel("claude-opus-5", "xhigh") },
    "xhigh",
    "opus[1m]",
  ],
  [{ effortLevel: "turbo" }, "high", OPUS],
])("applies Claude effort settings %j -> %s", (settings, expected, model) => {
  const { models, selectedOnlyModels } = applyClaudeEffortSettings(
    buildClaudeCodeModels(DISCOVERED_MODELS),
    settings,
    DISCOVERED_MODELS,
  );
  const found = [...models, ...selectedOnlyModels].find(
    (item) => item.model === model,
  );
  expect(found?.defaultReasoningEffort).toBe(expected);
});
