# CLI, Guide, And Skill

Keep the discoverable surfaces in sync whenever you add or change a `room-cli` CLI command, flag, or a user-facing configuration knob (env var, `.bb/` workspace file, settings field):

- Update the in-CLI guide templates under `packages/templates/src/templates/bb-guide-*.md`, turbo regenerates `packages/templates/src/generated/templates.generated.ts` (not committed) before every build, typecheck, and test task.
- For core commands, update the room-cli skill at `plugins/bb-guide/skills/room-cli/SKILL.md` or its relevant reference. For plugin commands and settings, update the owning plugin's `skills/<name>/SKILL.md` or supporting reference, including built-in plugins. Keep plugin-specific behavior out of the core CLI skill. Configuration knobs also belong in `docs/configuration.md`.
- Match the existing chapter/section style; keep entries concise and accurate against the implementation.

Environment lifecycle hooks are core policy: cloudroom runs `.bb-env-setup.sh` after
an environment provider creates an owned path, and `.bb-env-teardown.sh` before
provider removal. Each has a 15-minute timeout; setup failure fails provisioning,
while reported teardown script failure does not block removal. Transport failure
keeps cleanup pending until the daemon confirms hook termination. Hook identity
and completion persist across server restarts. Attached checkout and
personal-workspace paths skip both hooks. These semantics apply equally to CLI,
SDK, and app launches; see [worktrees.md](worktrees.md).

The Machines settings creation drawer prepares an existing-machine command when access is ready, otherwise shows setup guidance. After access is ready, Choose a machine provider reviews provider inputs and launches through `hosts.experimental_create`/`room-cli machine create`. A machine belongs to no project; projects reach it later through project sources.

`room-cli machine list` enumerates persistent machines and takes `--all` to include
disposable provider sandboxes, matching the app's Show all machines reveal.
`room-cli updates` and `room-cli skill install-cli-skills` default to persistent machines
and still accept a sandbox through an explicit `--machine`.

Machine maintenance state is part of `room-cli machine list --json`; there is no
separate machine lifecycle command. Keep the machine guide and cloudroom command
index aligned with this surface.

Local installed-daemon start, stop, and uninstall operations are flags on
`install-machine.sh`, not `room-cli machine` subcommands.

`room-cli thread spawn --machine-inputs <json>` configures either an explicit
`--new-machine` or the machine provider owned by a composed
`--environment-provider`; a composition rejects separate machine selectors.
