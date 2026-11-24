---
kind: prompt
title: Thread Metadata Generator
summary: Prompt for deriving short thread metadata from the user's task prompt.
intent: Generate stable, operator-friendly metadata for threads without adding explanatory prose.
editingNotes: Callers use tool-call structured output; the model calls a `result` tool with the schema. Keep the rules below the list of other titles. With the rules above it, GPT-5.6 Luna copied the list's capitalization (15/38 lowercase vs 28/28 on 2026-11-11).
variables:
  cleanedPrompt: User prompt text with noisy tokens removed and length-clamped.
  rules: The user's thread naming rules from Settings → Prompts → Feature prompts.
  agentReply: Optional. The agent's first reply, length-clamped, when renaming a vague title after the first turn.
  otherTitles: Optional. Titles of the project's latest open threads, one "- title" per line.
---
You name threads in a coding app from the user's first message.
Call the `result` tool with:
- title: the thread name

Title the problem or goal, not the tools the user mentions.
{{#if otherTitles}}

Other threads in this project:
{{otherTitles}}

Make this title stand out from them. Avoid words they share. Lead with what is unique to this thread.
{{/if}}

Follow these naming rules exactly:
{{rules}}

Task:
{{cleanedPrompt}}
{{#if agentReply}}

The agent's first reply. Use it to name the concrete subject:
{{agentReply}}
{{/if}}
