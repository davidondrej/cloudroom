# Filing Issues

A good issue lets a stranger reproduce the problem in ten minutes without asking you anything. That is the bar for humans and agents alike. The GitHub issue forms in `.github/ISSUE_TEMPLATE/` follow this guide; use them.

## Before you file

1. Reproduce it yourself on the latest release (or `main`). If you cannot, say so in the issue and give what you have; do not present a guess as a repro.
2. Search open and closed issues. If one exists, comment there instead.
3. Separate what you **observed** from what you **think the cause is**. Both are welcome; label them.

## What a bug report contains

Use these sections in this order.

### 1. Summary

Two or three sentences: what you did, what happened, what you expected. Write it for someone who does not know the codebase.

### 2. Versions and environment

- Cloudroom version (Settings → About) and how you installed it. For a source build, include the commit.
- OS and version. Node version if you run from source or npm.
- Provider and provider CLI version when the bug involves an agent (`claude --version`, `codex --version`, `pi --version`, ACP agent build).
- Include any remote machine, Cloudroom Connect session, worktree, custom port or data directory, or memory limit involved.

### 3. Steps to reproduce

Give the exact commands, clicks, or prompt. Include a small scratch repo or fixture if needed. Use `room-cli` steps when the issue also happens there.

State the smallest thing that still reproduces it, and note anything you tried that did **not** reproduce it. That negative space is often the fastest route to the cause.

### 4. Expected vs actual

Paste the relevant terminal output, log lines, or HTTP responses. For visual bugs, attach a screenshot or short recording. State what you expected.

### 5. Evidence

- Logs from `logs/` under your Cloudroom data directory. `room-cli status --json` prints the directory.
- Thread ids (`thr_…`), project ids, environment ids when relevant. They are primary keys and let us query the database directly.
- Link to the exact source commit in `davidondrej/cloudroom` when citing public code.
- If you measured something (memory, timings, counts), say how.

### 6. What you ruled out

Mention related issues you checked, the commit you tested, and whether another provider or a clean data directory changed the result.

### 7. Suggested priority and effort

If known, include how many users it affects, any workaround, and whether anyone lost work.

## Feature requests and tasks

Describe the workflow you could not complete and what you expected. Open an issue before a PR for features and UI changes. Prototype links from a fork are welcome.

Tasks (refactors, docs, chores) state the concrete work and its acceptance criteria.

## Rules for agents

Agents file many issues in this repo. The same bar applies, plus:

- Reproduce before you file. A log line or a symptom in one thread is not a bug report. If a live repro is impossible, write the closest faithful repro (for example a unit test at the exact code path) and mark the issue as unverified.
- Question the report you were handed. If a user's stated cause is wrong, say what you actually observed and what you refuted.
- Include the base commit you tested against and permalinks to the code you cite.
- Link the Cloudroom thread or investigation report if the people reading the issue can access it.
- Do not open duplicates: search first, and if you find the same root cause under a different symptom, comment on the existing issue with the new evidence.
- End the body with `> AGENT GENERATED`.

## Issue labels

- `confirmed-repro` — someone other than the reporter reproduced it; the linked report has the steps.
- `partial-repro` — the cause is real but part of the report did not reproduce as written.
- `no-repro` — could not reproduce, or already fixed on `main`; the comment says what was tried.
- Area labels (`providers`, `threads`, `ui`, `plugins`, `host`, `workspaces`, `desktop`, `mobile`, `remote`, `security`, `cli`, `perf`) and per-plugin labels (`provider-claude-code`, `tasks`, `github`, …) say which part of the product owns it. Type, Priority, and Effort live in the built-in GitHub issue fields, not in labels.
