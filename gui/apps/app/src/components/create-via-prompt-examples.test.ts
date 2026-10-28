import { describe, expect, it } from "vitest";
import {
  PLUGIN_EXAMPLES,
  briefPrompt,
} from "@/components/plugin/plugin-create-examples";
import { getCreateExamples } from "./create-via-prompt-examples";

describe("getCreateExamples", () => {
  it("serves the plugin examples as the plugin templates, one source", () => {
    const { examples } = getCreateExamples("plugin");

    expect(examples.map((example) => example.label)).toEqual(
      PLUGIN_EXAMPLES.map((example) => example.title),
    );
    for (const [index, example] of examples.entries()) {
      expect(example.prompt).toBe(briefPrompt(PLUGIN_EXAMPLES[index]!));
    }
  });
});
