import { describe, expect, it } from "vitest";
import type { AvailableModel } from "@cloudroom/domain";
import { resolvePreferredTestModel } from "@cloudroom/test-helpers";

function availableModel(model: string, isDefault: boolean): AvailableModel {
  return {
    id: model,
    model,
    displayName: model,
    description: model,
    supportedReasoningEfforts: [
      {
        reasoningEffort: "low",
        description: "Low",
      },
    ],
    defaultReasoningEffort: "low",
    isDefault,
  };
}

describe("provider model selection", () => {
  it("prefers Pi OpenAI Codex subscription models before Anthropic models", () => {
    const models = [
      availableModel("openai-codex/gpt-5.5", true),
      availableModel("anthropic/claude-haiku-4-5", false),
    ];

    expect(resolvePreferredTestModel({ providerId: "pi", models })).toBe(
      "openai-codex/gpt-5.5",
    );
  });

  it("falls back to lower-priority Pi OpenAI Codex models before Anthropic models", () => {
    const models = [
      availableModel("anthropic/claude-haiku-4-5", true),
      availableModel("openai-codex/gpt-5.4-mini", false),
    ];

    expect(resolvePreferredTestModel({ providerId: "pi", models })).toBe(
      "openai-codex/gpt-5.4-mini",
    );
  });

  it("falls back to Pi Anthropic models when OpenAI Codex is unavailable", () => {
    const models = [
      availableModel("anthropic/claude-haiku-4-5", false),
      availableModel("anthropic/claude-opus-4-8", true),
    ];

    expect(resolvePreferredTestModel({ providerId: "pi", models })).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });
});
