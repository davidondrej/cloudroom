import { describe, expect, it } from "vitest";
import type { PromptInput } from "@cloudroom/domain";
import {
  deriveTitleFallback,
  sanitizeGeneratedTitle,
  shouldGenerateThreadTitle,
} from "../../src/services/threads/title-generation.js";

function textInput(text: string): PromptInput {
  return {
    type: "text",
    text,
    mentions: [],
  };
}

describe("thread title generation", () => {
  it("generates titles for any non-empty text input", () => {
    expect(shouldGenerateThreadTitle([textInput("fix")])).toBe(true);
    expect(shouldGenerateThreadTitle([textInput("   ")])).toBe(false);
    expect(
      shouldGenerateThreadTitle([{ type: "localFile", path: "/tmp/error.log" }]),
    ).toBe(false);
  });

  it("keeps the model's casing and word count", () => {
    expect(sanitizeGeneratedTitle("fix flaky login bug")).toBe(
      "fix flaky login bug",
    );
  });

  it("cleans quotes, trailing periods, and extra whitespace", () => {
    expect(sanitizeGeneratedTitle(' "fix   login bug." \n')).toBe(
      "fix login bug",
    );
  });

  it("caps very long titles", () => {
    expect(sanitizeGeneratedTitle("a".repeat(200))).toHaveLength(80);
  });

  it("returns null for empty generated titles", () => {
    expect(sanitizeGeneratedTitle("   ")).toBeNull();
  });

  it("derives the fallback title from the prompt text", () => {
    expect(deriveTitleFallback([textInput("fix bug")])).toBe("fix bug");
  });
});
