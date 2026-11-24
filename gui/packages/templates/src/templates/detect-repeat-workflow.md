---
kind: prompt
title: Repeat Workflow Detector
summary: Prompt that decides whether a user keeps asking agents for the same procedure by hand.
intent: Confirm a skill suggestion before the app shows it. A text match picked these threads; about half such groups are one project, not a repeated procedure.
editingNotes: Callers use JSON-schema structured output and show nothing unless `repeat` is true and `same` holds thread 1 and two more. Prefer false over a weak yes.
variables:
  threads: The threads, numbered from 1, each with its title and the start of its first message. Thread 1 just finished.
---
One person started the threads below with coding agents in the last two weeks. Thread 1 just finished.

Decide whether thread 1 and at least two others ask for the same repeatable procedure: the same steps every time, on a different input. A new version to release, another pull request to review, and another video to process are different inputs.

Say `repeat` false when the threads:
- are steps of one ongoing project, or follow-ups on one bug, feature, or document
- only share a topic, a tool, or the same closing instructions about style or format
- are questions, research, or discussion, not a procedure

Answer with:
- `repeat`: true only when you are sure.
- `same`: the numbers of the threads that run that procedure, with 1 first. Empty when `repeat` is false.
- `name`: a name for a skill that runs it: 1 to 3 lowercase words joined by hyphens, like `release` or `review-pr`. Empty when `repeat` is false.
- `what`: what the procedure does, in 3 to 6 plain words starting with a verb, like "Cut a release". Empty when `repeat` is false.

<threads>
{{threads}}
</threads>
