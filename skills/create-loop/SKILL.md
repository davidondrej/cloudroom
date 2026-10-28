---
name: create-loop
description: Create a recurring Cloudroom Loop that starts an agent to check one thing, archives its thread when all is fine, and reports only when something needs the user. Use for "create loop", "create-loop", "create automation", or any "every N hours, have an agent check X" request.
---

# Create loop

The user describes the job in a sentence. Fill in everything else from the defaults. Anything the user says overrides a default. Ask only when the job itself is unclear. For flags, Cloud loops, and scripts, read the `automations` skill.

## Defaults

- **Schedule:** every 4 hours in the user's timezone: `--cron "0 */4 * * *" --timezone <IANA zone>`.
- **Agent:** the same harness, model, and effort as this thread (`room-cli thread show --self --json`).
- **Where:** a Local loop in the project's main checkout (first line of `git worktree list`). No new worktrees. Use a Cloud loop when it must run with the Mac off, and always from a Cloud thread.
- **One thread per run:** every run is its own top-level thread. Never point a loop at one manager thread that re-prompts and spawns sub-agents: the runs pile up nested under it. Local loops and Cloud `--cron` loops already start a fresh thread per run, so don't add `--same-thread`. A script that starts threads itself spawns them top-level: no `--parent-self` on the Mac, `--top-level` in a Cloud thread, never `--shared-sandbox`.
- **Access:** read only. No edits, commits, or pushes until the user approves a fix.
- **Safety:** include the safety sentence below verbatim in every Local or Cloud loop prompt, including prompts embedded in scripts.
- **Finish:** all fine → 1-2 lines, then the thread archives itself. Something matters → a short verdict, thread left open for the user's Review tab.
- **No repeats:** skip issues already reported in open threads with the same title.

## Steps

1. **Read the area first.** Find the real files, docs, and skills the job touches. The loop's agent starts cold, so put concrete paths in its prompt.
2. **Write a short prompt** from the template below. Simple and short beats thorough: a few lines, at most about 15, in calm, plain words. No long checklists, nothing adversarial. One job per loop. If the loop may push, delete, or flag a serious security issue, have it ask a subagent on another model to check first, in a few lines, like: "Branch X removes Y. Check it won't break anything. Only flag serious issues, not nitpicks. End with SHIP or HOLD: reason."
3. **Create it.** Write the prompt to `/tmp/<name>-prompt.txt`, then:

   ```bash
   room-cli loop create --project "$ROOM_PROJECT_ID" --name "<Name> (every 4 hours)" \
     --cron "0 */4 * * *" --timezone <zone> \
     --provider <id> --model '<model>' --reasoning <level> \
     --environment "<main checkout>" --prompt "$(cat /tmp/<name>-prompt.txt)" --json
   ```

4. **Test it once.** `room-cli loop run ID --project "$ROOM_PROJECT_ID"`, then `room-cli loop runs ID --project "$ROOM_PROJECT_ID" --limit 1 --json` gives its thread. Confirm it started and renamed itself.
5. **Tell the user** the loop's name, schedule, and test thread, plus anything surprising from step 1.

## Prompt template

```text
<Name>. Read only: do not edit, commit, or push anything.
Never test destructive edge cases on live services; mock the API and reject missing or empty IDs before delete requests.

1. Rename this thread: `room-cli thread update --self --title "<Name> · $(date '+%b-%d %H:%M')"`.
2. Read: <concrete files and docs>.
3. Check: <what to look for, in plain words>.
4. Skip issues already reported in open threads titled "<Name>".

Finish:
- Nothing major: write 1-2 lines on what you checked, then run `room-cli thread archive --self --json`.
- Something worth fixing (<what counts as major for this job>): don't archive. Explain the single most important issue in 2-3 short, plain sentences, then one sentence on the safe fix. Then wait.
```

## Keep paid calls cheap

For jobs that pay per item (scrapes, search, paid APIs):

- **Fetch only what's new.** Save the last run time in a file and fetch only items after it.
- **Keep a pool.** Save good candidates for later runs instead of re-fetching the whole window.
- **Skip hours nobody reads,** e.g. `0 8-22/3 * * *`.

## Gotchas

- Pass `--project` on every Local loop command.
- Threads a loop starts cannot create loops.
- Quote models with brackets: `'claude-opus-5-5[1m]'`.
