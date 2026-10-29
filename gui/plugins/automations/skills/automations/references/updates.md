`list` and `show` are diagnostic reads: a damaged record remains visible as
`Prompt required` or `Invalid data` instead of failing the whole read. A
`Prompt required` record opens in the Automations panel's standard editor,
where the user can add its prompt while reviewing the other settings. It can
also be repaired directly:

```bash
room-cli loop update <loopId> --project <id> --prompt "<prompt>"
```

Writes remain strict. Run, pause, and resume reject damaged records; update
succeeds only when the resulting complete record is canonical. Every successful
create/update persists the canonical format.

Updates edit the loop in place: settings you don't pass are kept.

- Script loops: pass any of `--script`/`--script-file`, `--interpreter`,
  `--timeout`, and `--env-json`. `--env-json` replaces the whole env. The
  interpreter is kept unless you pass `--interpreter`.
- Agent loops: pass any of `--prompt`, `--provider`, `--model`, `--reasoning`,
  `--service-tier`, and `--permission-mode accept-edits|auto|full`, then at
  most one execution target. If a new provider can't use the kept permission
  mode, reasoning level, or service tier, the update fails: pass
  `--permission-mode`, `--reasoning`, or `--service-tier none`.
- Switching mode replaces the execution: `--prompt`, `--provider`, and
  `--model` together turn a script loop into an agent loop, and
  `--script`/`--script-file` turn an agent loop into a script loop. Omitted
  settings use defaults.

Change an agent loop's target:

```bash
room-cli loop update <loopId> --project <id> \
  --environment <environment-id-or-path>
room-cli loop update <loopId> --project <id> \
  --target-thread <thread-id>
room-cli loop update <loopId> --project <id> \
  --new-environment worktree [--base-branch <branch>]
```

`--target-thread`, `--environment`, and `--new-environment` are mutually
exclusive. These flags apply only to agent automations; script automations have
no execution environment.

Every command supports `--json`. For `list` and `show`, the JSON result is a
union discriminated by `problem`: canonical records omit it, while degraded
records use `"missing-agent-prompt"` or `"invalid-stored-data"`. The
missing-prompt variant retains the full readable automation; the invalid-data
variant contains only `id`, `projectId`, `name`, and `problem`.
