---
kind: prompt
title: Create Skill From Repeats
summary: Message that asks a thread's agent to save a job the user keeps repeating as a skill.
intent: The skill suggestion card puts this in the chat box. The agent already holds this thread's steps and the user's corrections, so the skill costs little to write.
editingNotes: Written in the user's voice, since the user sends it. Keep it short.
variables:
  name: The skill's name, like `release`.
  what: What the job does, like "Cut a release".
  threads: Earlier threads that asked for the same job, one per line, each with its ID and title.
---
Create a new Cloudroom skill named `{{name}}` that does this job: {{what}}.

- Base it on what you just did in this thread: the steps that worked and every correction I made.
- I asked for the same job in these earlier threads. Read them first with `room-cli thread log <id>`, and keep what they have in common:
{{threads}}
- Keep the skill short. Leave out anything that was only true this one time.
