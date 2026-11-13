---
name: antigravity-provider
description: "Inspect Cloudroom Antigravity provider support: Google sign-in, plan usage, models and thinking levels."
---

# Antigravity provider

Antigravity runs Google's `agy` CLI over ACP (`agy acp`). Its models and their
thinking levels come from the signed-in Google AI plan, so read them from the
target host's provider catalog with `room-cli provider models antigravity`
rather than assuming a list.

Sign-in is Google's: `agy acp --login` on the machine, or Connect in Settings →
Agents → Harness. Plan usage (a five-hour and a weekly limit per model group)
is in `room-cli settings usage`.

Antigravity does not expose fork, rewind, or manual compaction to Cloudroom.
