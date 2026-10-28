---
kind: instruction
title: Cloudroom Guide — Providers
summary: Command reference for discovering providers and models.
intent: Provide complete provider command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Provider commands

Providers are agent backends (e.g., codex, claude-code). Each supports different models.

  room-cli provider list [--machine <id-or-name> | --environment <id>]
                                          List available providers
  room-cli provider models [providerId] [--machine <id-or-name> | --environment <id>] [--restart]
                                          List models for a provider

Cloud Codex uses a separate VM login. Check it with `room-cli cloud codex status --json`; start official device-code sign-in with `room-cli cloud codex login --request-id ID`, or cancel that attempt with `room-cli cloud codex cancel ID`. Keep the temporary code private. Verify `connected` before retrying a saved task. This does not authenticate Pi or switch local accounts.

Use these before spawning threads if you are unsure which provider or model to use.
`--host` is an alias for `--machine`. Machine and environment selectors are
mutually exclusive because an environment already selects its machine. When no
selector is supplied, both commands intentionally inspect the primary machine.
When provider and model are omitted from room-cli thread spawn, the project's
remembered defaults apply. If the project has no remembered choice, cloudroom uses
the explicitly requested provider or Codex, then resolves the model marked
default by that provider on the target machine (falling back to the first
catalog model when none is marked).

`room-cli provider models acp-cursor --restart` (or `codex`/`pi --restart`) restarts
that provider's model-discovery process and reloads its models. It preserves
conversation threads, credentials, and project files. Use it when model loading
fails, or when the model list looks stale after a CLI upgrade or a Pi
`models.json` edit; it does not
repair login or installation problems. Other providers must explicitly support
this action.

Model lists answer from the machine's last stored list while a background
refresh runs, so a list can be hours old. A provider whose refresh keeps
failing or timing out keeps answering from its last stored list.

Provider-native memory can be controlled on the separate Settings → Providers
→ Codex and Settings → Providers → Claude Code pages. Codex memory controls
both recall (`memories.use_memories`) and future generation
(`memories.generate_memories`). Claude Code memory controls native auto-memory
reads and writes (`autoMemoryEnabled`). Both preferences default on and apply
when a provider thread is started, resumed, or forked; they do not interrupt
an active turn. These settings are separate from Cloudroom's optional Memory plugin,
an official plugin bundled with the app.

Provider-native subagents can also be disabled on those provider pages. For
Codex, cloudroom turns off the native multi-agent feature and caps V2 sessions at the
root thread so remote session policy cannot start a child. For Claude Code, Cloudroom
removes the native Task tool. The preferences default off and apply
when a provider thread is started, resumed, or forked; they do not modify the
provider's global configuration.

Provider failure recovery

The builtin Provider retry plugin is enabled on fresh installations and
recognizes structured Codex and Claude Code subscription windows and provider
overloads. Subscription limits wait for the reported reset plus a short buffer
and jitter. Overloads use exponential backoff and jitter, starting after 5–10
seconds. If the provider accepted the failed input, core sends an agent-only
continuation; if it rejected the input before starting, core re-sends the
original message as agent-only. Prior output or tool activity does not block
recovery. Provider-native retries remain authoritative while the provider
reports that it will retry on its own.

The plugin never blocks a send. It only reacts to a failure, because a
remembered rate limit is a stale picture of the provider's state: if you raised
your plan or the window opened early, the next send simply works. Several
threads on one exhausted subscription therefore each fail once, then each
schedule their own jittered retry. Automatic recovery stops after five total
attempts for the turn.

Automatic waits default to a maximum of six hours. Longer reset windows are not
scheduled. Set `maximumWait` to `24 hours` or `No limit` under the plugin
settings, or run:

  room-cli plugin config provider-retry set maximumWait "24 hours"

  room-cli provider-retry status [thread-id] [--json]    Inspect pending retries
  room-cli provider-retry cancel <thread-id> [--json]    Cancel an automatic retry
  room-cli provider-retry retry <thread-id> [--json]     Send a pending retry now

A pending retry is a queued row on the thread, so it survives a server restart
and appears above the composer with its reason and time. Credit and
spend-control exhaustion does not reset on a clock, so nothing is scheduled for
it — waiting does not fix it.

Claude Code's native Workflow tool can be disabled separately on its provider
page. This preference also defaults off and applies to newly started, resumed,
or forked provider sessions.

Claude Code runs without its Claude in Chrome browser tools under cloudroom by
default. Enable them with
`room-cli plugin config provider-claude-code set chromeEnabled true`. The host needs
the Chrome extension and a claude.ai login. A change restarts the thread's
Claude process before its next turn and keeps the conversation.

Known ACP agents can appear automatically when their CLI is installed on the
host. For example, opencode, omp, Grok Build's grok CLI, Hermes' hermes CLI, or
the openclaw CLI on PATH appears as provider acp-opencode, acp-omp, acp-grok,
acp-hermes-agent, or acp-openclaw. OpenClaw threads run through the Gateway on
the host, which cloudroom starts if it is off; each thread gets its own Gateway
session in the thread's folder.

cloudroom indexes the native user and project skill roots for Codex, Claude Code, Pi,
Cursor, OpenCode, omp, Grok Build, and Hermes Agent. This includes compatibility
roots such as .agents/skills and .claude/skills when the provider supports them.
It also includes project ancestor roots for providers that search to the Git
repository root. Configured Pi, omp, Grok, and Hermes directories are included.
Enabled provider plugins also contribute skills to the selected provider's `/`
command menu. `room-cli skill list` shows native skills for Claude Code, Codex, and
Cursor.

ACP providers discover models from the agent itself. For acp-opencode, the
list mirrors the OpenCode catalog, so a custom model from the OpenCode config
appears automatically. Discover and select one with:

  room-cli provider models acp-opencode --environment "$ROOM_ENVIRONMENT_ID"
  room-cli thread spawn --provider acp-opencode --model <provider/model>

cloudroom applies the selected model to the ACP session before the first prompt.

An OpenCode model and an OpenCode agent are different selections. An OpenCode
agent (build, plan, or a custom primary agent such as an orchestrator) is a
session mode, not a model. cloudroom does not select OpenCode agents; configure the
default agent in the OpenCode config and the ACP session uses it.

Top-level customModels in the app data-dir config.json adds extra picker
entries. Each entry has a providerId (a built-in provider id or any acp-*
provider id), a model id, and an optional displayName. cloudroom skips an invalid
entry with a warning. The entry then appears in room-cli provider models output and
in the model picker, but the provider must still accept the id: claude-code
and codex accept unlisted ids, while an ACP agent can reject an id it does
not know at session start. OpenCode rejects unlisted ids, so add an OpenCode
model to the OpenCode config instead. Edit the JSON and run bb-app config
refresh; there is no set/unset CLI surface. The streamerMode
General setting hides every entry from these lists; see the customization
chapter.

Custom ACP agents live in the ACP providers plugin's customAgents setting, a
JSON array. Set it with room-cli plugin config provider-acp set customAgents '[...]'.
Each entry needs id (lowercase letters, digits and dashes), displayName, and
command. cloudroom derives provider id acp-<id> from the slug id. The id is permanent.
The id cursor is reserved because cloudroom always lists that agent. The ids opencode,
omp, grok and hermes-agent are not reserved, so an entry with one of those ids
replaces the shipped agent. Use args, env, and cwd for the launch, modelCli
for CLI model listing/selection, reasoningCli for launch-time reasoning flags,
nativeReasoning for ACP session/set_config_option reasoning, permissionCli for
permission-mode launch flags, and dialect (cursor, opencode, omp, or grok) for
the vendor side channels cloudroom reads. Use nativeSkillRoots to add native skills to
the composer.
Give it a user list and a project list. User roots resolve from the target host
home directory. Project roots resolve from the selected workspace. Each root
must use a relative path without dot segments. Set supportsManualCompaction to true only
if the agent accepts an explicit compaction request; it defaults to false, and
cloudroom hides the /compact command for agents that do not declare it. The plugin
re-registers its providers as soon as the setting changes, so no restart or
config refresh is needed.

The old customAcpAgents array in the app data-dir config.json is deprecated. Cloudroom
still reads it and logs a warning for each agent it finds, until 0.41. Move each
entry into the customAgents setting. The shapes match except for logo, which the
setting does not accept: cloudroom drops that field when it reads the old array, and a
configured agent shows the generic tool glyph.

Use top-level sharedSkillRoots for one provider-neutral skill collection. The
user and project paths use the same relative-path rules. cloudroom indexes these roots
as read-only sources. It then injects the selected skills into all providers.
The cloudroom user and project roots keep higher precedence than matching shared roots.

OpenCode ACP declares support for the built-in /compact command. Cursor ACP does
not expose compatible manual compaction through ACP.
