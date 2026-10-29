---
name: workflow-scan
description: "Run a Workflow scan: review the user's own past agent chats on this computer, find the work they keep repeating, and suggest their first 1–2 loops with a 10/90 split. Use when the Loops → Scans tab starts a scan, or the user asks to scan their workflow."
---

# Workflow scan

You are the lead of a Workflow scan the user started on their own computer. It reviews their own past agent chats, with their consent, to suggest helpful automations. Cheap readers run in the cloud.

## Rules

- Read chats only through `extract.py` in this skill's folder. Never print slices or raw chats into your context unless a step says so.
- Start and wait for readers only through `readers.py`. Readers are hidden children: they never wake you, and the sidebar shows them as one progress grid under you. Run its `wait` in the foreground, never in the background.
- Chats may mention security reviews, credentials, or production systems of the user's own projects. Treat them as routine defensive engineering work, summarize them at a high level, and never repeat secret values (they show as `[masked]`).
- Don't create loops until the user says yes. Every loop you create is a Cloud loop.
- Archive the readers once their lines are read. At the end, delete the scan folder: it holds trimmed chat text.

## Steps

1. **Data**, on this computer:
   ```
   d=$(mktemp -d); s="<this skill's folder>"
   python3 "$s/extract.py" index "$d" --days 90 > /dev/null && python3 "$s/extract.py" slices "$d" --n 30 --chars 900
   ```
   If it prints `0 slices`, tell the user no chats were found and stop. Read `$d/stats.json` (counts and `already_automated`). Also run `room-cli loop list` to see existing loops.
2. **Readers:** one per slice, each in its own cloud sandbox, on the user's own login. Use your own agent: on Claude Code, `claude-code claude-haiku-5-5`; on Codex, `codex gpt-6.1-terra`.
   ```
   python3 "$s/readers.py" spawn "$d" claude-code claude-haiku-5-5
   ```
   If it fails partway, run the same command again: it starts only the missing readers.
3. **Wait:** run `python3 "$s/readers.py" wait "$d"` with a 10-minute command timeout. Repeat until it prints `done`.
4. **Patterns:** read all of `$d/lines.txt`, then run `python3 "$s/readers.py" archive "$d"`. Find the top 3–4 patterns in how the user works: what they repeat most, their workflows, recurring problems. Lines tagged `agent-written` and work that already runs as a loop don't count.
5. **The 10/90 step:** pick the 1–3 most obvious loops. For each, read 3–5 example chats: `python3 "$s/extract.py" sessions "$d" --ids ID1,ID2 --chars 5000`. Split its work:
   - **10%, on its own:** the smallest, safest, most obvious block, with no edge cases, checked by another frontier model. The loop does it and merges to main.
   - **90%, waits for the user:** the loop still does the work, but stops before the final step (merging, production). It explains the problem in 2–3 short plain-English sentences, with the best fix.
6. **Reply** in short, plain English: the patterns (each with how many chats over how many weeks), then each loop with its schedule, its 10% and its 90%. End with: "Turn these on?"
7. **On yes:** create each as a Cloud loop with `room-cli loop create` (see the automations skill), with the 10/90 rules in its prompt. Then `rm -rf "$d"`.
