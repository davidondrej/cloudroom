# Provider usage

Shows usage from enabled usage-source plugins in the sidebar. The card opens with
the signed-in Cloudroom plan's meters. `plan-usage.ts` adapts the account's usage
into plain meters, so a new metric such as Cloud credits only needs a new adapter. The card lists every
provider at once, each with its icon, name, and one thin bar per limit (5h, 7d,
and any model-scoped window). Pooled accounts stack under their provider. Shared
sources such as Account Pooler are selected by default; an explicit machine
selection shows that machine’s local usage instead.

An unconfigured shared source remains selectable and shows setup guidance.
Failed refreshes retain the last available measurements with a retry notice.
Account authentication failures and plans without reported limits have separate
states; unavailable usage is never represented as zero consumption.

Settings → Agents → Usage shows the same card at a larger size, between the
Cloudroom plan meters and a "what uses credits" price list: only agents actively
running use credits, and 18 other things are free.

Use `bb plugin rpc list --method provider-usage.v1.listResources --json` to find sources
and `bb plugin rpc inspect <plugin-id> provider-usage.v1.listResources --json`
to inspect their published contracts. RPC calls accept JSON through
`--input-file`. See the Plugin Guide for the contract API.

`bb settings usage --json` and `bb.sdk.system.usageLimits()` remain the
host-local provider-maintenance view; they do not aggregate shared pool accounts.

Codex, Claude Code, and ACP provider plugins explicitly implement the usage contract
for their own providers. Account Pooler implements it for shared accounts. The
contract is owned here and copied into each source; no additional adapter plugin,
provider-kit helper, or core runtime convention is required. Other providers must
explicitly implement the contract to appear in these displays.

Known provider-issued account identities are deduplicated within the selected
location. Unknown identities are never merged by email. Structured plan and quota
window metadata give both displays consistent labels.

Provider Usage is enabled by default for newly registered installations. Existing
explicit enable/disable choices are preserved. Right-click the footer shortcut and
choose **Hide** to move it into **More**. Settings → Appearance → Sidebar footer
controls order and visibility for every footer action. The usage settings page
remains available. These preferences belong to BB, not the plugin.
