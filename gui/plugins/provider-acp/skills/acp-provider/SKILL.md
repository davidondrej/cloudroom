---
name: acp-provider
description: "Configure or troubleshoot ACP agent discovery, custom models, skills, and compaction in Cloudroom."
---

# ACP providers

Known agents can be discovered automatically when their CLI is installed on the
host: `opencode`, `omp`, `grok`, `hermes`, `openclaw`, and `devin` appear as `acp-opencode`,
`acp-omp`, `acp-grok`, `acp-hermes-agent`, `acp-openclaw`, and `acp-devin`. Inspect the target host's catalog with
`room-cli provider list` and `room-cli provider models <provider-id>` using its environment
or machine selector.

To install a missing agent with its official installer, list candidates with
`room-cli provider list --installable`, then run
`room-cli machine provider-cli install <machine> <provider-id>`. Settings → Providers
offers the same one-click install.

Cursor project skills come from `.cursor/skills`, which can link to
`.agents/skills`. Cloudroom lists these linked skills as read-only under `cursor-project`.

ACP agents may reject unlisted model IDs. OpenCode requires models in its own
configuration; Cloudroom discovers them there. OpenCode agents are session modes, not
models selectable through Cloudroom's model field.

OpenCode ACP supports the core `room-cli thread compact` command; Cursor ACP does not
expose compatible compaction. Check the actual agent's capabilities before
attempting provider-specific recovery.
