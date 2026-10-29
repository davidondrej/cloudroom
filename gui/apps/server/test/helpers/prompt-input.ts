import type { PromptInput } from "@cloudroom/domain";

function textPrompt(text: string): PromptInput {
  return { type: "text", text, mentions: [] };
}

export function textInput(text: string): PromptInput[] {
  return [textPrompt(text)];
}
