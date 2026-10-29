---
name: codex-provider
description: "Diagnose Cloudroom-specific Codex session controls, model acceptance, and durable goals."
---

# Codex provider

Codex supports structured plan requests, editing and rerunning eligible messages,
and compaction through the corresponding core `room-cli thread` commands.
Goals work the same on Local and Cloud. `room-cli thread pause-goal`, `resume-goal`,
`set-goal <objective>`, and `clear-goal` act as the user. Only the user can resume a
paused or blocked Goal; Stop pauses an active Goal, as in Codex's own UI. Inspect the
thread before recovery actions.

Unlisted model IDs are accepted by this provider; acceptance does not establish
account access. Inspect models on the actual execution host with
`room-cli provider models codex` using the machine or environment selector.

Use the core CLI skill for command syntax and official Codex guidance for
upstream product behavior.
