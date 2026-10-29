---
kind: instruction
title: Cloudroom Guide Loops
summary: Command reference for scheduled agent and script work (Loops).
intent: Help agents create, edit, inspect, run, and review loops through the CLI.
---
Loops (formerly Automations) schedule recurring or one-shot work. Agent loops
run a prompt in a thread; script loops run stored code without model usage.
`room-cli automation` is the same command as `room-cli loop`.

  room-cli loop list --project <id>    Local and Cloud loops
  room-cli loop show <loopId> --project <id>
  room-cli loop create --project <id> --name <name> <schedule> <execution>
  room-cli loop update <loopId> --project <id> [changes]
  room-cli loop pause|resume <loopId> --project <id>
  room-cli loop run <loopId> --project <id>
  room-cli loop runs <loopId> --project <id> [--limit <count>]
  room-cli loop delete <loopId> --project <id> --yes
  room-cli loop review [--all]        What loops did in the last 7 days
  room-cli loop review mark <itemId...> [--undo]
  room-cli loop templates            Ready-made loops
  room-cli loop create --template <id> --project <id> [--local]
  room-cli loop settings [--stop-at-limit on|off]

Every loop has a priority, P1 (essential) to P4 (niche): `--priority 1-4` on
create and update. Loops start at P3, or at their template's.

Schedules:

  --cron <expression> --timezone <iana-timezone>
  --at <iso-date-time>
  --in <duration>                 For example: 30s, 5m, 2h, or 1d

Agent execution:

  --prompt <text> --provider <id> --model <model>
  [--reasoning <none|low|medium|high|xhigh|ultracode|max|ultra>]
  [--service-tier <default|fast>]
  [--permission-mode <accept-edits|auto|full>]
  [--environment <environment-id|path> | --new-environment worktree]
  [--base-branch <branch>] [--target-thread <thread-id>]

Script execution:

  --script <inline> | --script-file <path> [--host <name-or-id>]
  [--interpreter <bash|sh|node|python3>]
  [--timeout <milliseconds>] [--env-json '{"KEY":"value"}']

`--script-file` reads the file relative to your current directory from the
thread's environment host, or from the server host outside a thread. Pass
`--host <name-or-id>` to read from another machine. The plugin stores a private
copy that runs execute. The copy is a snapshot: edits to the source file do not
apply until you run `update <loopId> --script-file <path>` again;
`create` and `update` print that exact command. `create`, `update`, and `show`
print the stored copy path on the `Script:` line (`execution.storedScriptPath`
with `--json`).

`update` can combine name, schedule, and execution changes, and keeps every
setting you don't pass. An agent loop accepts any of `--prompt`, `--provider`,
`--model`, `--reasoning`, `--service-tier default|fast|none`,
`--permission-mode`, or one target option; if a new provider can't use the kept
permission mode or reasoning level, pass `--permission-mode` or `--reasoning`. A script loop accepts any of
`--script`/`--script-file`, `--interpreter`, `--timeout`, or `--env-json`
(which replaces the whole env). Switching a loop between agent and script
replaces its execution: pass `--prompt`, `--provider`, and `--model`, or a
script source.

Add `--json` for machine-readable output. The JSON returned by `list` and
`show` is a union discriminated by `problem`: canonical records omit it;
degraded records use `"missing-agent-prompt"` or `"invalid-stored-data"`.
The missing-prompt variant retains the full readable automation, while the
invalid-data variant contains only its identity fields and `problem`. Use
`runs --output <runId>` to print a script run's captured output.

`list` and `show` keep damaged stored records visible as `Prompt required` or
`Invalid data` instead of failing the whole read. Opening a `Prompt required`
record in the Loops panel takes you through the standard editor, where
you can add the prompt while reviewing its other settings. The same repair is
available through the CLI:

  room-cli loop update <loopId> --project <id> --prompt "<prompt>"

Writes remain strict. Run, pause, and resume reject damaged records; update
succeeds only when the resulting complete record is canonical.
