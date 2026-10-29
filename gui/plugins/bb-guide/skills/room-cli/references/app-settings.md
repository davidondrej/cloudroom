# cloudroom app settings reference

Server-backed preferences in Settings. They are persisted on the server, so
every window and client sees the same value.

## Setting values

- `room-cli settings general <key> <value>` accepts any key listed under
  `generalSettings` in `room-cli settings show`. Boolean preferences take `true`,
  `false`, `on`, or `off`; `null` clears a preference that can be unset.
- Unknown keys and values of the wrong shape are rejected; the error names the
  keys cloudroom knows.

## Sidebar preferences

- The server keeps a keyed, revisioned registry of sidebar layout preferences
  (`sidebar.organizationMode`, `sidebar.chronologicalSort`, the section
  orders, the collapsed-id lists, `sidebar.pluginPanelOrder`,
  `sidebar.visiblePluginPanels`, `sidebar.navigationProvider`,
  `sidebar.threadListProvider`).
- `sidebar.organizationMode` defaults to By project (`project`) when unset;
  existing server and legacy browser choices are preserved.
- `room-cli settings ui list [--json]` prints every key with its value, revision,
  and description; `room-cli settings ui get <key> [--json]` prints one.
- `room-cli settings ui set <key> <value> [--json]` takes a plain string for enum
  and provider keys and JSON for lists or `null`; it reads the current
  revision, writes with it, and retries once on a conflict.
- `room-cli settings ui reset <key> [--json]` writes the default and advances the
  revision.

## Theme and starting machine

- `appearance.theme` (`light`, `dark`, or `system`) and
  `defaults.startingMachine` (`cloud` or `last`) are UI preferences too, so
  `room-cli settings ui set appearance.theme dark` changes every open window.

## Keyboard shortcuts

- `showKeyboardHints` defaults to true. Set it with
  `room-cli settings keyboard hints <true|false|on|off>` to control whether
  delayed shortcut badges appear while holding Command or Control. It does not
  disable the shortcuts themselves.
- Settings → Keyboard records sparse per-command chord overrides. `Mod` means
  Command on macOS and Control on Windows/Linux.
- Reset removes the override and follows Cloudroom's current default. Clear stores an
  explicit disabled value.
- Bindings for non-native actions apply in browser and desktop clients. Command
  contexts and native-only availability remain server-owned. Reusing a chord
  can be intentional when contexts do not overlap; the UI identifies reuse.
- New Thread, New Window, New Tab, Close, and Settings in the desktop menu use
  the same resolved shortcuts as renderer commands.
- The complete default table is in `docs/configuration.md` in the cloudroom source
  repository.

## Remove AI co-authors

Settings → Defaults → Remove AI co-authors is on by default. Set
`stripAiCoAuthorsEnabled` with
`room-cli settings general stripAiCoAuthorsEnabled <true|false|on|off>`.
New Local and Cloud sessions drop agent `Co-authored-by` lines from commits and
keep human ones. It needs Git 2.54 or newer.

## Command Guard

Settings → Advanced → Command Guard is on by default. Set `commandGuardEnabled` with
`room-cli settings general commandGuardEnabled <true|false|on|off>`.
Start a new Local or Cloud session afterward. Personal guards remain active.
This blocks common catastrophic shell commands; it is not a sandbox.

## Diagnostic events

- `showDiagnosticEvents` defaults to false in all builds. Set it with
  `room-cli settings general showDiagnosticEvents <true|false|on|off>`.
- Enables provider environment resolution and unhandled provider events in the
  timeline. Warnings, errors, and model fallback stay visible regardless.
- Existing unhandled-provider-events preferences carry over to this setting.

## Active-thread Enter behavior

- `steerActiveThreadOnEnter` defaults to false (Queue). Existing saved
  preferences are preserved. Set it with
  `room-cli settings general steerActiveThreadOnEnter <true|false|on|off>`.
- Outside an open composer typeahead menu, disabling it makes Enter queue a
  follow-up and Command+Enter steer the active turn. When enabled, those
  actions are reversed.
- Shift+Enter inserts a newline. On coarse-pointer touch devices, the
  software-keyboard Return path stays a newline; iPadOS WebKit preserves the
  Enter shortcuts for a connected Magic Keyboard.

## Streamer mode

- `streamerMode` defaults to false. Set it with
  `room-cli settings general streamerMode <true|false|on|off>`.
- When enabled, every `customModels` entry from `~/.bb/config.json` is hidden
  in all model lists: the pickers, `room-cli provider models`, and
  `sdk.providers.models`. Use it during a screen share so a private or
  early-access model id does not appear.
- The entries stay in `config.json`. A thread request that names a hidden model
  explicitly still runs with it, and default model resolution for a new thread
  keeps the full list.
- A composer whose stored selection is a hidden model falls back to the
  provider default, and the next send records that default. Select the custom
  model again after you turn streamer mode off.

## New branch prefix

- `managedBranchPrefix` defaults to `bb/`. Set it with
  `room-cli settings general managedBranchPrefix <prefix>`.
- cloudroom puts the prefix in front of every branch name it creates for a managed
  worktree or a new checkout branch, so the default gives
  `bb/fix-login-flow-thr_ab12cd34ef`.
- A prefix does not need a trailing slash. `sawyer/wt-` gives
  `sawyer/wt-fix-login-flow-thr_ab12cd34ef`, and an empty prefix gives
  `fix-login-flow-thr_ab12cd34ef`.
- cloudroom rejects a prefix that cannot start a valid git branch name, such as one
  with a space or a leading `-`. The maximum length is 64 characters.
- The new prefix applies to branches cloudroom creates after the change. It does not
  rename an existing branch or worktree.

## Worktree cleanup

- `worktreeRetention` defaults to `21d`. Options: `5m`, `1h`, `1d`, `7d`,
  `21d`, `30d`, `never`. Set it with
  `room-cli settings general worktreeRetention <option>`.
- cloudroom deletes a worktree folder that long after its last thread is
  archived or deleted. The branch stays; uncommitted changes are lost.
- Changing it restarts the timer for worktrees already waiting.

## Provider order and default

- `providerOrder` defaults to `[]`. Set it to a JSON array of provider IDs.
- `defaultProviderId` defaults to `null`. Set a provider ID or use `null` to
  clear it.

## Finished turns

- When a turn finishes, cloudroom can collapse its work into one `Worked for` row
  and leave the final answer visible (`collapse`), or keep every step visible
  (`flat`). Each provider declares a default: Claude Code is `flat`; every
  other first-party provider is `collapse`.
- `room-cli settings completed-turns [--json]` lists every provider with its current
  display and whether it comes from your setting or the provider default.
- `room-cli settings completed-turns <provider-id> <collapse|flat|default>` sets the
  display for one provider; `default` removes your setting so the provider
  default applies again. Settings → Providers has the same switch per
  provider.
- The overrides are stored in `providerCompletedTurnDisplay`, a map of provider
  ID to `collapse` or `flat`. The setting applies to every thread of that
  provider, including finished turns in existing threads, the conversation
  outline, and `room-cli thread log`.

## Message edits

- Eligible accepted root user messages can be edited without enabling an
  experiment. Use `room-cli thread edit-message` or the message editor in the app.

## Provider session release

- Cloudroom releases restorable provider sessions after 30 idle minutes.
- Active turns, commands, agents, workflows, and monitors keep sessions loaded.

## Changelog preview

- The `changelogPreview` experiment defaults to false.
- Enable it with `room-cli settings experiment changelogPreview true` to show the
  latest release notes on Settings → Updates.

## Sidebar progressive disclosure

- The `sidebarProgressiveDisclosure` experiment defaults to false.
- Enable it with `room-cli settings experiment sidebarProgressiveDisclosure true`.
- In **By project** and **By machine**, it shows the first five groups in the
  current sort order, keeps attention groups visible, and reveals ten more per
  **Show more** click. Revealed groups stay visible through activity and
  sort-order changes. **Manually** is unchanged.

## Timeline windowing

- The `timelineWindowing` experiment defaults to false.
- Enable it with `room-cli settings experiment timelineWindowing true`.
- It keeps stable timeline wrappers while mounting only rows near the active
  main or nested detail scrollport.

## Multi-machine picker

- The `multiMachinePicker` experiment defaults to false.
- Enable it with `room-cli settings experiment multiMachinePicker true`.
- Projects with at least three machines use a searchable, target-first
  environment picker. Machine-only pickers add search when they contain more
  than five machines.

Machine access: `room-cli settings general machineServerUrl https://cloudroom.example.com`
sets the server URL reachable by machines. Set `null` to use BB_EXTERNAL_URL.
`room-cli settings general defaultMachineAccess direct` selects direct access;
`connect` selects bb Cloud; `null` selects the first registered access provider,
or direct when none is registered. An unpaired provider remains selected and
reports setup required. `room-cli settings show --json` includes serverAccess with the
effective direct URL, its source and provider availability. Availability is refreshed
on each read, with failed or timed-out checks reported as unavailable. It does
not acquire a machine grant. These grants carry runtime
requests after enrolment.

Automatic machine GitHub credentials are enabled by default. Use
`room-cli settings general machineGitCredentialsEnabled false` to stop forwarding the
server gh credentials to machines; `true` enables them again. In Machines →
Advanced settings, the automatic GH_TOKEN switch controls the same setting.
This does not log the server out or suppress an explicit custom GH_TOKEN.
Changes apply to new turns, setup commands and terminals.

Sidebar footer actions use `sidebar.footerOrder` and `sidebar.hiddenFooterItems`.
Both are string lists shared across clients. Keys are `builtin:settings`,
`builtin:report-bug`, or `plugin:<encoded pluginId>/<encoded registrationId>`.
Right-click Hide moves an action into More; Settings → Appearance → Sidebar footer
restores visibility and drag-reorders actions. CLI example:
`room-cli settings ui set sidebar.hiddenFooterItems '["plugin:provider-usage/usage"]'`.
Use `room-cli settings ui reset sidebar.hiddenFooterItems` to show everything again.

Disable usage telemetry with `room-cli settings general telemetryEnabled false`
or Settings → General → Privacy & diagnostics → Share usage data and setup errors. This server-wide preference
applies immediately and persists across restarts. `BB_TELEMETRY=false` overrides it.
