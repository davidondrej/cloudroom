---
name: workflow-scan
description: "Run a Workflow scan: read the user's past agent chats on this computer, find the work they keep repeating, and suggest their first 1–2 loops with a 10/90 split. Use when the Loops → Scans tab starts a scan, or the user asks to scan their workflow."
---

# Workflow scan

You are the lead. You run on the user's computer; cheap readers run in the cloud.

## Rules

- Read chats only through `extract.py` in this skill's folder. Never print slices or raw chats into your context unless a step says so.
- Start and wait for readers only through `readers.py`. It never links readers to you, so you wake once, not once per reader. Run its `wait` in the foreground, never in the background.
- Don't create loops until the user says yes. Every loop you create is a Cloud loop.
- At the end, archive the reader threads and delete the scan folder: it holds trimmed chat text.

## Steps

1. **Data**, on this computer:
   ```
   d=$(mktemp -d); s="<this skill's folder>"
   python3 "$s/extract.py" index "$d" --days 90 > /dev/null && python3 "$s/extract.py" slices "$d" --n 30 --chars 900
   ```
   Read `$d/stats.json` (counts and `already_automated`). Also run `room-cli loop list` to see existing loops.
2. **Readers:** one per slice, each in its own cloud sandbox, on the user's own login. Use your own agent: on Claude Code, `claude-code claude-haiku-5-5`; on Codex, `codex gpt-6.1-terra`.
   ```
   python3 "$s/readers.py" spawn "$d" claude-code claude-haiku-5-5
   ```
3. **Wait:** run `python3 "$s/readers.py" wait "$d"` with a 10-minute command timeout. Repeat until it prints `done`.
4. **Patterns:** read all of `$d/lines.txt`. Find the top 3–4 patterns in how the user works: what they repeat most, their workflows, recurring problems. Lines tagged `agent-written` and work that already runs as a loop don't count.
5. **The 10/90 step:** pick the 1–3 most obvious loops. For each, read 3–5 example chats: `python3 "$s/extract.py" sessions "$d" --ids ID1,ID2 --chars 5000`. Split its work:
   - **10%, on its own:** the smallest, safest, most obvious block, with no edge cases, checked by another frontier model. The loop does it and merges to main.
   - **90%, waits for the user:** the loop still does the work, but stops before the final step (merging, production). It explains the problem in 2–3 short plain-English sentences, with the best fix.
6. **Reply** in short, plain English: the patterns (each with how many chats over how many weeks), then each loop with its schedule, its 10% and its 90%. End with: "Turn these on?"
7. **On yes:** create each as a Cloud loop with `room-cli loop create` (see the automations skill), with the 10/90 rules in its prompt. Then run `python3 "$s/readers.py" archive "$d"` and `rm -rf "$d"`.
