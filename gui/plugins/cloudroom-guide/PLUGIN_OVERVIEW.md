# Cloudroom guide

Control the bundled agent skills in Settings → Prompts → Cloudroom
guide. The plugin and all four settings default to enabled. The Cloudroom system
prompt has its own switch in Settings → Prompts → System prompt.

- `skills`: make the selected bundled skills available.
- `roomCli`: include `room-cli`.
- `pluginAuthoring`: include `plugin-authoring`.
- `skillCreator`: include `skill-creator`.

Use `room-cli plugin config cloudroom-guide set <key> true|false` from the CLI, or
`bb.sdk.plugins.updateSettings({ pluginId: "cloudroom-guide", values: { ... } })`
through the SDK. Changes apply when agent configuration is next assembled;
they do not erase instructions from an existing conversation.

Disabling the plugin removes all three skills. The
settings affect this plugin's copies, not independently installed user or
provider skills. Other plugins keep their own skills. The generated
`plugin-commands` skill continues to describe enabled plugin commands.
