---
kind: prompt
title: Commit Message Generator
summary: Prompt for generating one conventional commit line from a git diff snapshot.
intent: Produce a single concise conventional commit subject and nothing else.
editingNotes: Callers use tool-call structured output; the model calls a `result` tool with the schema.
variables:
  diffDescription: Human-readable description of the diff snapshot being summarized.
  shortstat: Git shortstat summary for the diff.
  files: Git name-status output for changed files.
  patch: Trimmed patch excerpt for extra context.
---
Write a concise git commit message for {{diffDescription}}.
Call the `result` tool with your answer.
Rules:
- Use conventional commit style (feat|fix|refactor|test|docs|chore|perf|build|ci|style).
- Prefer specific types like feat/fix/refactor/test/docs/perf over chore.
- Use chore only for housekeeping (deps, tooling, CI, formatting, repo maintenance).
- Use imperative mood, max 72 characters.
- Single line only, no body.

Shortstat:
{{shortstat}}

Files (name-status):
{{files}}

Patch excerpt:
{{patch}}
