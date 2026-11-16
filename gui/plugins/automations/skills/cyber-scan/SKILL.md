---
name: cyber-scan
description: Scan the user's computer and active repos for security problems, show the findings, and suggest 2 loops that prevent them. Use when the Scans tab starts a Cyber scan or the user asks for one.
---

# Cyber scan

You lead a Cyber scan the user started on their own computer.
It is a defensive review of their own computer and code, with their consent.
Cheap readers review GitHub repos in the cloud.

## Rules

- Run only safe, read-only commands. Never use `--write`. Never push scripts to the Mac to run.
- Never install, update, remove, or fix anything during the scan.
- Never print or repeat a secret value.
- Use CVE IDs and scores only from `findings.json`. Never invent them.
- Don't create loops until the user says yes.
- Every loop you create is a Cloud loop.
- Start and wait for readers only through `readers.py`. Run its `wait` in the foreground.
- At the end, delete the scan folder.

## Steps

1. **Collect**, on this computer:
   ```
   d=$(mktemp -d); s="<this skill's folder>"
   python3 "$s/collect.py" "$d"
   ```
   It takes 1-3 minutes. Then read all of `$d/summary.md`.
   It may start with "Not fully checked". Say so in the report. Never call those parts clean.
2. **Readers:** if `$d/slices` has slice files, start one reader per GitHub repo. Use your own agent's small model:
   ```
   SCAN_READER_PROMPT="$s/reader.md" SCAN_TITLE="Cyber scan" SCAN_READER_REASONING=medium \
     python3 "$s/../workflow-scan/readers.py" spawn "$d" claude-code claude-haiku-5-5
   ```
   On Codex, use `codex gpt-6.1-terra`.
   If it fails partway, run the same command again.
   No slice files: run `room-cli loop scan-progress --data '{"stage":"patterns"}'` and skip to step 4.
   While readers work, check the computer findings yourself (step 4).
3. **Wait:** run `python3 "$s/../workflow-scan/readers.py" wait "$d"` with a 10-minute command timeout.
   Repeat until it prints `done`.
   Read `$d/lines.txt`. Each reader's lines sit under its repo's heading.
   Then run `python3 "$s/../workflow-scan/readers.py" archive "$d"`.
4. **Judge:** keep only real problems.
   - Computer: FileVault off, firewall off, pending security updates, an outdated browser, ports open to the network, unknown startup items, unprotected keys or tokens.
   - Match the recent exploited CVEs against the apps and versions installed.
   - Repos: package CVEs with a fix, leaked secrets, reader findings.
   - Drop dev-only and test-only noise unless it is critical.
5. **Report:** write `$d/report.json` (format in `report.py`), then run `python3 "$s/report.py" "$d"`.
   Put the line it prints on its own line in your reply.
   Under it, write 2-3 short plain-English sentences: the biggest risk and the first fix.
6. **Loops:** find the 2 biggest gaps. Pick the 2 loops that would prevent that class of problem from coming back.
   - Base each on the closest security template (`room-cli loop templates`). Tune its prompt to what you found.
   - Each runs on one repo's Cloudroom project. Give its schedule and what it checks.
   - End with: "Turn these on?"
7. **On yes:** create each as a Cloud loop with `room-cli loop create` (see the automations skill). Then `rm -rf "$d"`.
