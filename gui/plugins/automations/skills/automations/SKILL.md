---
name: automations
description: "Schedule or manage Cloudroom Loops (formerly Automations): recurring and one-shot agent or script runs, local or cloud, and the Review of what they did."
---

# Loops

Loops are Cloudroom's scheduled tasks. The app called them Automations before; IDs and data still use `automation`. When due, a loop runs in one of two modes:

agent Spawn a thread or re-prompt a target thread with a configured prompt.
script Run a stored server-side script and capture stdout/stderr/exit.

Use the top-level `room-cli loop` command; `room-cli automation` is the same command. The CLI routes it to this plugin.

Pass `--project` explicitly for every automation command. Inside a thread, automations are stamped origin `agent` and record the creating thread automatically. Automation-spawned threads cannot create automations.

Personal supports automations with `--project proj_personal`. Use `room-cli project list --include-personal --json` to include it in discovery; an empty default project list does not mean Personal is unavailable.

Local or cloud:

Automations above run on this Mac, only while it is awake and Cloudroom is running. A cloud automation runs on Cloudroom's servers instead, even while the Mac is off: every minute with a script, else at most every 15 minutes. It belongs to one existing Cloud thread. Each `--cron` run starts a fresh Cloud thread in its own sandbox with that thread's project, harness, model, and `.env` files; `--same-thread` re-prompts that thread instead. A one-time `--at`/`--in` run re-prompts the thread; `--new-thread` gives it a fresh one. Use cloud when the work should keep going with the laptop closed.

A fresh-thread automation saves that thread's settings (project, agent, model, effort, repo, `.env` files) when it is created, so it keeps running after the thread is archived. A same-thread one pauses when its thread is archived.

A cloud `--script`/`--script-file` runs first, as the agent in the project folder, for up to 60 seconds: in the automation's own sandbox with fresh threads (set up once, asleep between checks), else in the thread's sandbox. Empty output skips the run with no agent turn; any output is added to the prompt; a non-zero exit is a failed run. The script keeps its own state (say, a cursor file) in that sandbox and needs its logins there too.

```bash
room-cli loop create --cloud --thread <cloudThreadId> --name "..." --prompt "..." (--cron "<expr>" --timezone <tz> | --at <datetime> | --in <duration> | --webhook) [--new-thread | --same-thread] [--script-file <path>]
room-cli loop list --cloud [--thread <cloudThreadId>]
```

`list --project <id>` also shows the Cloud loops whose thread is in that project; `list --cloud` shows them for every project.

Webhooks (ADR 0262): `--webhook` instead of `--cron`/`--at`/`--in` makes a loop that runs when its secret URL gets a POST, Local or Cloud. Create prints the URL once (the website keeps only its hash); `room-cli loop hook <id>` replaces it. Each run gets the requests that arrived since the last one, batched, inside `<webhook_events>` as data; a script-mode Local loop reads them from the file in `ROOM_LOOP_EVENTS`. Cloud runs start within seconds; the Mac checks for Local ones about once a minute, and they wait on the website while it is off. A Local webhook loop an agent creates starts paused, and only a person can turn it on in the Loops panel, since anyone with the URL can prompt an agent on the Mac. Cloud webhook loops take no script yet, and `run` doesn't apply: send a POST to test one. Give the user the URL and tell them to keep it secret.

`show`, `update`, `pause`, `resume`, `run`, `hook`, and `delete` take a cloud automation's ID (a UUID) without `--project`. A re-prompt run is a message in its thread; a fresh-thread run is its own thread, which the app shows when it next checks in. A missed run fires once; a run waits until the previous one ends; three failed runs in a row pause it. Inside a Cloud thread, `room-cli loop create` takes no `--cloud` or `--thread`: it schedules that thread.

Choosing a mode:

Use `script` when the output is fully determined by code: watchdogs, threshold alerts, health checks, heartbeats, and API pollers with a fixed output shape. Scripts run on the Cloudroom server, with cwd inside the plugin data directory's `scripts/` area. Script automations do not have an environment field and do not accept environment flags.

Design the script to print nothing when there is nothing to report: an exit-0 run with empty stdout/stderr, or a last non-empty line of `{"wakeAgent": false}`, is recorded as a skipped silent tick. Any other output is captured; non-zero exit or timeout is recorded as a failed run.

Use `agent` when the run needs reasoning: summarize a feed, pick interesting items, draft a human-friendly message, or branch on content.

Creating:

```bash
room-cli loop create --project <id> --name "..." [schedule flags] [mode flags]
```

For creation flags and mode-specific defaults, read
[references/creation.md](references/creation.md).

Read `references/script-runtime.md` before you use a script file, depend on
injected variables, or diagnose retries, timeouts, restarts, and silent runs.

Managing:

```bash
room-cli loop list --project <id>
room-cli loop show <loopId> --project <id>
room-cli loop update <loopId> --project <id> [--name <name>] [--priority 1-4] [schedule flags] [agent or script execution flags] (omitted settings are kept)
room-cli loop pause <loopId> --project <id>
room-cli loop resume <loopId> --project <id>
room-cli loop run <loopId> --project <id> [--idempotency-key <key>]
room-cli loop runs <loopId> --project <id> [--limit <count>] [--output <runId>]
room-cli loop delete <loopId> --project <id> --yes
room-cli loop templates
room-cli loop create --template <id> --project <id> [--local]
room-cli loop settings [--stop-at-limit on|off]
```

Priority is P1 (essential) to P4 (niche); `--priority` works on `create` and `update`, Local and Cloud, and loops start at P3. Templates need a paid plan. A template makes a Cloud loop unless `--local`, and fills in its name, prompt, schedule, agent (the project's default when its own isn't set up), and priority; any flag you pass wins. A Cloud one runs from the project's newest Cloud thread, else a new one. `runs <cloudLoopId>` lists what each Cloud run reported. `settings` reads or sets whether Cloud loops wait at their agent's plan limit (on by default).

For partial updates, mode replacement, execution targets, or damaged records,
read [references/updates.md](references/updates.md). Every command supports `--json`.

Review:

The Loops panel's Review tab lists what loops did on their own in the last 7 days: the threads they started (a thread the agent archived is done, one it left open needs the user), script output, and failures. Threads a script starts with `room-cli thread spawn` are linked to its run automatically. A loop's agent should archive its thread when all is fine, and leave it open with a short verdict when the user must act.

```bash
room-cli loop review [--all] [--json]
room-cli loop review mark <itemId...> [--undo]
```
