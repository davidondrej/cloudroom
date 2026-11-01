---
kind: prompt
title: Prompt Suggestion Generator
summary: Prompt that predicts the user's next message after an agent reply.
intent: Save the user typing by offering the message they were about to send, as faint text they accept with Tab.
editingNotes: Callers use JSON-schema structured output and drop questions, praise, and agent voice. An empty suggestion shows nothing; prefer it over a weak guess.
variables:
  userMessage: The user's latest message, length-clamped.
  agentReply: The end of the agent's latest reply, length-clamped.
  purpose?: The thread's purpose line.
  styleSamples?: The user's own messages from other recent threads, one "- message" per line.
---
Predict the next message this user will type to their coding agent.
Predict what they would type, not what you think they should do. The test: would they think "I was just about to type that"?

Return:
- suggestion: 2 to 12 words, written exactly the way this user writes. Or an empty string.

Examples:
- They asked to fix a bug and run the tests, and the bug is fixed: "run the tests"
- Code was written: "try it out"
- The agent offered options: the one this user would likely pick
- The agent asks whether to continue: "yes" or "go ahead"
- The task is done and the next step is obvious: "commit and push"

Never repeat the user's latest message; predict what they will type after it. Never suggest praise or thanks, questions, the agent's voice ("Let me...", "I'll..."), new ideas the user didn't ask about, or more than one sentence.
Return an empty string after an error or misunderstanding, when the next step isn't obvious, or when it touches anything sensitive (credentials, security incidents, private data, harm).
Copy the user's style: their length, tone, capitalization, and wording.
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
