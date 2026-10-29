---
kind: instruction
title: Cloudroom Guide — Customization
summary: Command reference for customizing the cloudroom app color palette, typography, keyboard shortcuts, and mobile push notifications.
intent: Explain the CLI theme surface, server-backed app customization, and push-notification device registration.
editingNotes: Keep flags accurate against the CLI implementation. Theme details live in the room-cli skill's references/theming.md.
---
Customization commands

Theming — the app-wide palette and typography

`room-cli theme` controls a set of CSS-variable overrides for the app palette and
typography, persisted server-side and applied live to every open window.
Light/dark mode is a separate per-client setting the theme layers on top of.
Custom themes live on
disk, one folder per theme, at <bb-data-dir>/theme/<name>/theme.css (the packaged
app uses ~/.bb/theme/…). The folder name is the theme id.

  room-cli theme list                  Built-in and custom themes; shows the active one
  room-cli theme dir                   Print the custom-theme directory (where to author)
  room-cli theme set <id> [--favicon-color <color>]
                                 Activate a theme, preserving the favicon color
                                 unless the flag supplies the complete selection
  room-cli theme show [id] [--css]     Print the active palette, or resolve <id> without
                                 activating it; --css dumps the CSS
  room-cli theme reset                 Back to the default theme; preserve favicon color
  room-cli theme favicon set <color>   Set favicon color; preserve the active theme
  room-cli theme favicon reset         Reset favicon color; preserve the active theme

To author a custom theme, run `room-cli theme dir`, write <that-dir>/<name>/theme.css,
then `room-cli theme set <name>`. Optional `pierre-dark.json` / `pierre-light.json`
(or a `theme.json` `codeTheme` field) ship the matching code colors. Built-in
palettes use the matching Shiki pair. The full design-token reference is in
the room-cli skill (references/theming.md).

Theme CSS can override typography as well as colors. `--font-terminal` controls
the integrated terminal's font family independently of `--font-mono`; set it in
the theme's `:root, .light` block and end the stack with a generic fallback.

Favicon colors are `default`, `red`, `orange`, `yellow`, `green`, `teal`,
`blue`, `purple`, and `pink`. Theme and favicon-only commands carry the other
appearance value forward explicitly.

Hovering a palette in Settings → Appearance previews it live in that window
without saving; `room-cli theme show <id>` is the CLI counterpart.

Add --json to any theme command for machine-readable output.

Packaged launcher settings

`bb-app config` and `bb-app env` reload runtime settings in a running server,
but the CLI identifies server and launcher settings that are startup-only,
including binding/ports, data and the dev-app port, telemetry, inherited skill
roots, and `BB_FF_*` flags. `BB_LOG_LEVEL` is also startup-only. Use
`bb-app config`, not `bb-app env`, to change `BB_APP_URL`, `BB_INFERENCE`,
`BB_INFERENCE_FALLBACK`, or `BB_TRANSCRIPTION` live. After a startup-only
change, run `bb-app stop && bb-app start` or restart the desktop app. Until
then, changing or unsetting `BB_SERVER_BIND_HOST` does not close a previous
`0.0.0.0` listener.

With `--server-bind-host 0.0.0.0`, the startup listener and `app` rows show
`http://0.0.0.0:<port>`. Health checks and the colocated daemon still connect
through loopback; this does not narrow the IPv4 wildcard listener. Containers
must also publish the port to the host.

Server helper completions use `BB_INFERENCE` first, then
`BB_INFERENCE_FALLBACK` after a transient timeout, rate limit, or
service-unavailable failure. Both default to `codex/gpt-5.6-luna`.

  bb-app config set BB_INFERENCE <provider/model>
  bb-app config set BB_INFERENCE_FALLBACK <provider/model>

Server-backed General settings

Settings → General includes app-wide preferences stored server-side so every
window and restart sees the same value. Keep Awake is instead owned by its
builtin plugin: use its autosaving page under Settings → Installed plugins or run
`room-cli keep-awake enable` or `room-cli keep-awake disable`. Choose every host with `room-cli
keep-awake hosts all`, or name individual host ids after `room-cli keep-awake hosts`.
On macOS it prevents system idle sleep while Cloudroom is running; closing the lid or
choosing Sleep still sleeps the Mac. On Linux it uses `systemd-inhibit`.

Settings → Keyboard also includes `showKeyboardHints`, which defaults to true.
Turn it off to hide the delayed shortcut badges shown while holding Command or
Control on macOS, or Control on Windows/Linux. Shortcut commands continue to
work.

Settings → Defaults includes **Remove AI co-authors**, on by default. New
sessions drop agent `Co-authored-by` lines from commits and keep human ones.
Use `room-cli settings general stripAiCoAuthorsEnabled <true|false>`. It needs
Git 2.54 or newer.

Settings → Advanced includes **Command Guard**, enabled by default for new Local
and Cloud sessions. Use `room-cli settings general commandGuardEnabled <true|false>`.
Start a new session after changing it. Personal guards remain independent. It
blocks common catastrophic shell commands, not every destructive action.

Settings → General includes `showDiagnosticEvents`, which defaults to false
in all builds. Turn it on to show provider environment resolution and unhandled
provider events. Warnings, errors, and model fallback stay visible. Existing
unhandled-event preferences are preserved. Set it with
`room-cli settings general showDiagnosticEvents <true|false>`.

Settings → General also includes `steerActiveThreadOnEnter`, which defaults to
false (Queue). Existing saved preferences are preserved. Outside an open
typeahead menu, enabling it makes Enter steer a running
thread and Command+Enter queue a follow-up; when disabled, those actions are
reversed. Shift+Enter inserts a newline. On coarse-pointer touch devices, the
software-keyboard Return path inserts a newline. iPadOS WebKit preserves these
Enter shortcuts for a connected Magic Keyboard.

Settings → General also includes `streamerMode`, which defaults to false. Turn
it on to hide every `customModels` entry from `~/.bb/config.json` in all model
lists (pickers, `room-cli provider models`, and the SDK) during a screen share. The
entries stay in the config file.

Settings → General includes `managedBranchPrefix`, which defaults to
`cloudroom/`. Cloudroom puts it in front of every branch name it creates for a worktree, so
the default gives `cloudroom/fix-login-flow-thr_ab12cd34ef`. Set `sawyer/wt-` to get
`sawyer/wt-fix-login-flow-thr_ab12cd34ef`, or clear it for no prefix. cloudroom rejects
a prefix that cannot start a valid git branch name. The new prefix applies to
branches cloudroom creates after the change.

  room-cli settings show
  room-cli settings ai-services
  room-cli settings general <key> <value>
  room-cli settings completed-turns [provider-id] [collapse|flat|default]
  room-cli settings experiment <key> <value>
  room-cli settings usage [--machine <id-or-name>]
  room-cli settings version [--force]
  room-cli settings reload

`room-cli settings ai-services` shows the helper-inference and voice-transcription
settings (`BB_INFERENCE`, `BB_INFERENCE_FALLBACK`, `BB_TRANSCRIPTION`, set with
`bb-app config`) and the plugin-registered AI services they may name as
`<service>/<model>`.

`room-cli settings general` accepts any key from `generalSettings` in
`room-cli settings show`. Boolean preferences take `true`, `false`, `on`, or `off`,
and `null` clears a preference that can be unset.

`room-cli settings completed-turns` lists how each provider shows a finished turn:
`collapse` folds the turn's work into one "Worked for" row and keeps the final
answer visible, and `flat` keeps every step visible. Each provider has a
default (Claude Code is `flat`, the other first-party providers `collapse`).
`room-cli settings completed-turns <provider-id> <collapse|flat>` overrides it for
that provider, and `default` removes the override. Settings → Providers has
the same per-provider switch.

The default-off `changelogPreview` experiment shows the latest release notes
as a compact, dismissible card on Settings → Updates.
Message editing is available for eligible, accepted
root user messages in Codex, Claude Code, and Pi threads, including failed or
incomplete turns. Opening the editor is
client-local; submitting stops and settles a running thread, then replaces the
selected turn and all later conversation history while retaining workspace side
effects. Grouped multi-message requests are not yet editable.

Cloudroom releases restorable provider sessions after 30 idle minutes. The daemon
checks for these sessions every five minutes. Active turns, commands, agents,
workflows, and monitors keep their sessions loaded.

The default-off `sidebarProgressiveDisclosure` experiment shows the first five
groups in the current sort order in **By project** and **By machine**, keeps
attention groups visible, and reveals ten more per **Show more** click. Revealed
groups stay visible through activity and sort-order changes.
**Manually** is unchanged. Enable it with `room-cli settings experiment
sidebarProgressiveDisclosure true`.

The default-off `timelineWindowing` experiment mounts only nearby rows in long
timelines and large expanded timeline details. Enable it with
`room-cli settings experiment timelineWindowing true`.

The default-off `multiMachinePicker` experiment uses a searchable, target-first
environment picker for projects with at least three machines and adds search to
machine-only pickers with more than five machines. Enable it with
`room-cli settings experiment multiMachinePicker true`.

Thread timeline pages select complete conversation groups using
`BB_FF_TIMELINE_WINDOW_EVENT_BUDGET` (default 1500) as a selection budget.
Oversized groups paginate their contents with stable summary identities.
Grouping can load more than the budget to preserve lifecycle and delegation
context; it is not a hard CPU or memory cap. Older activity loads on scroll.
A walk keeps its initial history snapshot. Edits invalidate it, and a new live
snapshot can require loading older pages again.

Server-backed keyboard shortcuts

Settings → Keyboard records per-command shortcut overrides. They are persisted
server-side, applied live to every connected window, and survive restarts.
Reset removes an override and returns to Cloudroom's current default; Clear explicitly
disables a command. `Mod` means Command on macOS and Control on Windows/Linux.
Bindings for non-native actions apply in browser and desktop clients. Command
contexts and native-only availability remain server-owned, and desktop menu
accelerators for New Thread, New Window, New Tab, Close, and Settings use the
same resolved bindings. The complete default table is in docs/configuration.md.

  room-cli settings keyboard list
  room-cli settings keyboard hints <true|false>
  room-cli settings keyboard set <command> <shortcut|disabled>
  room-cli settings keyboard reset [command]

Plugin commands use `plugin:<plugin-id>/<command-id>` as their stable binding
ID. For example: `room-cli settings keyboard set plugin:example/open-issue Mod+Shift+I`.
`room-cli settings keyboard reset plugin:example/open-issue` restores the plugin's
default; `set ... disabled` explicitly unbinds it. The SDK supports the same IDs
through `system.updateKeyboardSettings` and `system.config`.
Overrides survive plugin disable/re-enable and reload. Every active plugin
command appears in Keyboard Settings; commands without defaults start unbound.
Conflicting plugin defaults stay unbound and display the conflicting command.
The UI offers Replace binding or Cancel when assigning an occupied shortcut.
`keyboard list` includes all saved overrides and core effective bindings;
plugin defaults and availability are resolved in each app window, where the
plugin frontend runs. CLI/SDK callers should clear conflicting explicit
bindings in the same update; plugin defaults yield to explicit bindings.

Push notifications

The built-in Push notifications plugin sends mobile updates through Expo and
system notifications to connected web and desktop clients. Web tabs or desktop
windows must stay open; browser permission is requested in the plugin settings.

  room-cli push-notifications list
  room-cli push-notifications add --token <expo-push-token>
      --platform <ios|android> --label <device-name>
  room-cli push-notifications remove <id>
  room-cli push-notifications status
  room-cli push-notifications test <web|desktop>
  room-cli plugin config push-notifications set <mobileEnabled|webEnabled|desktopEnabled> <true|false>

`add` is an upsert by token: a known token refreshes its label and last-seen
time and keeps its id. Expo tokens that are no longer registered are removed
automatically after a failed delivery. Use `room-cli plugin disable
push-notifications` to stop delivery. Change the relay URL with `room-cli plugin
config push-notifications set expoPushUrl <url>`. Add `--json` to `list` or
`status` for machine-readable output. The list returns token suffixes only.
The three channel switches default to true and apply immediately across this
server. `test` broadcasts to all connected clients of the selected type with
permission; OS notification settings still control whether a banner appears.

Host files and voice transcription

  room-cli file read|write|list|paths|mkdir|move|remove ...
  room-cli voice transcribe <audio-file> [--prompt <context>]

Voice transcription uses the `BB_TRANSCRIPTION` model, which defaults to
`codex/gpt-transcribe`. Override it with
`bb-app config set BB_TRANSCRIPTION <provider/model>`.

`room-cli file` supports `--host` for remote machines and `--root` on mutating
commands to confine access beneath an absolute directory. `room-cli file list` and
`room-cli file paths` include dot-prefixed entries; pass `--no-hidden` to skip them.
Both skip a default set of dependency and cache directories such as
`node_modules`, `.venv`, `.pnpm-store`, and root-relative `.claude/worktrees`;
`--exclude <names...>` replaces that set. Entries match basenames at any depth
or exact root-relative paths using `/` separators. Use
`--json` for metadata and machine-readable results.

Server-backed sidebar preferences

Sidebar layout lives on the server in a keyed, revisioned registry so every
window, device, and the CLI share it: organization mode, chronological sort,
section orders, collapsed rows and sections, navigation entry order and
visibility, and the navigation and thread-list provider pickers. The sidebar
waits for them alongside the project list, and an upgrade uploads the old
browser-stored layout once.

  room-cli settings ui list [--json]
  room-cli settings ui get <key> [--json]
  room-cli settings ui set <key> <value> [--json]
  room-cli settings ui reset <key> [--json]

`room-cli settings ui list` prints every key with its value, revision, and a short
description. `set` takes plain strings for enum and provider keys and JSON for
lists and `null`; it reads the current revision, writes with it, and retries
once on a conflict. `reset` writes the default. The SDK offers
`sdk.system.uiPreferences.list()`, `.set()`, and `.reset()`.

By project (`project`) is the default for `sidebar.organizationMode` when no
value is saved. Existing server and legacy browser choices are preserved.

Every thread-list header's actions menu offers New project, Organize, and Sort by.
There is no New section button; create one with `room-cli thread section create <name>`.
Sections show in Custom. Organize selects By project, By machine, By harness, or Custom for the whole sidebar.
Sort by applies only to that section (saved in `sidebar.sectionSorts`); selecting
the same field again reverses its direction. Pinned also offers Drag order.
`sidebar.sortDirection` accepts `ascending`, `descending`, or `default`.
The default preserves each field's original order (newest first for dates,
A–Z for titles). For example: `room-cli settings ui set sidebar.sortDirection ascending`.

Sidebar footer actions

Settings → Appearance → Sidebar footer supports drag ordering and visibility.
Right-click an action and choose Hide to move it into the More menu. Hidden
shortcuts remain actionable; hiding an open disclosure closes it. The More menu
appears only when hidden actions are available and links back to customization.
`sidebar.footerOrder` and `sidebar.hiddenFooterItems` are string lists. Keys are
`builtin:settings`, `builtin:report-bug`, or `plugin:<encoded pluginId>/<encoded registrationId>`.
Preferences survive plugin reloads and temporarily unavailable plugins; new items
are visible by default. Example:

  room-cli settings ui set sidebar.hiddenFooterItems '["plugin:provider-usage/usage"]'
  room-cli settings ui reset sidebar.hiddenFooterItems

Client-local UI preferences

Some Settings values live only in the current browser/client. Sidebar width
and open state stay local because they depend on the window size. The Voice Input
microphone picker stores the selected browser MediaDevices device id in
localStorage as `bb.voiceInput.audioInputDeviceId`; it does not have a `room-cli`
command and does not change the server-side transcription model.

Usage telemetry can be disabled in Settings → General → Privacy & diagnostics → Share usage data and setup errors,
or with `room-cli settings general telemetryEnabled false`. The saved server-wide preference
takes effect immediately and persists across restarts. SDK callers can use
`system.updateGeneralSettings` with `telemetryEnabled`. `BB_TELEMETRY=false`
always disables telemetry, even when the saved preference is enabled.
