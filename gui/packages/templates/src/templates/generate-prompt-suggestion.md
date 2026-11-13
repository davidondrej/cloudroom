---
kind: prompt
title: Prompt Suggestion Generator
summary: Prompt that predicts the user's next message after an agent reply.
intent: Save the user typing by offering the message they were about to send, as faint text they accept with Tab.
editingNotes: Callers use JSON-schema structured output and drop questions, praise, and agent voice. An empty suggestion shows nothing; prefer it over a weak guess.
variables:
  instructions: The user's prompt from Settings → Prompts → Feature prompts. The default is DEFAULT_PROMPT_SUGGESTION_PROMPT in ui-preferences.ts.
  userMessage: The user's latest message, length-clamped.
  agentReply: The end of the agent's latest reply, length-clamped.
  purpose?: The thread's purpose line.
  styleSamples?: The user's own messages from other recent threads, one "- message" per line.
---
{{instructions}}
{{#if purpose}}

What this thread is for:
{{purpose}}
{{/if}}
{{#if styleSamples}}

How this user writes (their messages in other threads):
{{styleSamples}}
{{/if}}

The user's latest message:
{{userMessage}}

The end of the agent's latest reply:
{{agentReply}}
