---
kind: prompt
title: Thread Purpose Generator
summary: Prompt for a thread's short purpose and percent done, refreshed after each reply.
intent: Remind the user, in plain English, what a thread is for and how far along it is.
editingNotes: Callers use JSON-schema structured output. Keep the purpose short; long or changelog-style notes annoy users.
variables:
  title: The thread's name.
  firstMessage: The user's first message, length-clamped.
  recentMessages: The user's latest messages, oldest first, length-clamped.
  previousPurpose?: The last purpose, with its percent done.
  agentReply?: The agent's latest reply, length-clamped.
---
You keep a short note on what a coding agent thread is for.
The user runs many threads and forgets what each one does.
Return:
- purpose: max 80 characters, in plain, natural English. Say what the thread is doing and where it stands, the way you'd tell a friend. Example: "Fixing the login redirect bug. The fix works, now testing it."
- percent: pick the stage the main goal has reached. Use only these numbers:
  10 = just asked or exploring
  25 = plan or design ready
  50 = being built
  75 = built and tested, not committed yet
  90 = committed, not pushed to GitHub yet
  100 = everything from this thread is finished and pushed to GitHub
  A pending release does not lower the number.
  Threads with no code (questions, research, reviews): 100 = fully answered and nothing waits on the user.
  Waiting on the user's approval, a running job, or pending results is never 100.

Write the note fresh each time. Use full, simple words. No robotic or telegraph style, no semicolons, no jargon. Never use the word "triage"; say "looking into" instead. Call the user "you". The agent often calls the user by name (for example "David"); write "you" instead. No history, no process steps (rechecked, rebased, reviewed), no file names, no filler.
Follow the user's main goal, not side questions. Update it when the user changed direction.
{{#if previousPurpose}}

Previous note (reuse its wording if the goal and state did not change):
{{previousPurpose}}
{{/if}}

Thread name: {{title}}

The user's first message:
{{firstMessage}}

The user's latest messages:
{{recentMessages}}
{{#if agentReply}}

The agent's latest reply:
{{agentReply}}
{{/if}}
