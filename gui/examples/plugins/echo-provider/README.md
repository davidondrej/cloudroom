# bb-plugin-echo-provider

The **third-party canary** for bb's provider plugin API. It is a complete
agent provider — a picker entry, a bridge, a bb tool, plugin settings, and
its own timeline vocabulary — that answers every prompt by echoing it back.
Useless as an agent, complete as a proof: it exercises **every** capability
a provider plugin has, and it does so through the public SDK alone.

## The rule

Everything under this directory imports only:

- `@get-bb/plugin-sdk` (and its published subpaths `/provider-bridge`,
  `/host`, `/app`),
- `zod`,
- node built-ins and the plugin's own files.

**No `@cloudroom/*` workspace package is imported anywhere.** A marketplace
plugin cannot resolve bb's private packages; if this example needed one, the
public API would have a hole.

## What it demonstrates

Registration (`server.ts`, `bb.providers.register`):

| Capability                                                                                                                                                              | Where                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `strings` — sign-in and expiry hints, install URL, brand prefix, plan-mode copy, icon tint                                                                 | `server.ts`                                        |
| `reasoningLevels` — labelled picker options beside the coarse ladder                                                                                       | `server.ts`                                        |
| `serviceTiers` and `capabilities.supportsServiceTier`                                                                                                      | `server.ts`                                        |
| `capabilities` — permission modes, fork, archive/rename                                                                                                                 | `server.ts`                                        |
| `maintenance.health: true` — the server polls `provider/health` through the bridge; usage and installation stay off                                         | `server.ts`, answered in `src/provider-bridge.ts`  |
| `composerActions: ["plan"]`                                                                                                                                             | `server.ts`                                        |
| `models.fallback` — the cold-cache model list                                                                                                              | `server.ts`                                        |
| `env.passthrough` — one daemon env var the bridge may read                                                                                                 | `server.ts`, read in `src/provider-bridge.ts`      |
| `experimental_nativeSkillRoots` — one workspace-relative skill root (`.echo/skills`) bb lists beside its own skills                                        | `server.ts`                                        |
| `deriveProviderOptions` — the plugin's `shout` setting (`bb.settings.define`) travels to the bridge as `providerOptions`                                   | `server.ts`, read back in `src/provider-bridge.ts` |
| `extensionKinds` — one item kind (`echo-provider/receipt`) and one state kind (`echo-provider/mood`), each with a zod schema the server enforces at ingest | `src/vocabulary.ts`                                |
| `bb.agents.registerTool` with `presentation` — a bb tool whose row reads the way the plugin says                                                           | `server.ts`                                        |
| `bb.branding.experimental_icons` — one declared icon (`receipt`) the receipt row references as `echo-provider/receipt`; the server serves it hashed and checks the glyph at ingest | `package.json`, `icons/receipt.svg`, `src/vocabulary.ts` |
| `bb.host` — one artifact carrying the bridge and a host RPC entry                                                                                                       | `host.ts`, `contract.ts`                           |

The bridge (`src/provider-bridge.ts`, grammar v3). Every accepted prompt runs
the same scripted turn:

| Capability                                                                                                       | Delta                               |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Handshake reports `grammarVersions: [3, 3]`, `steerMode`, `sessionRestore`, `approvalEnforcedBy`                 | `initialize`                        |
| `presentation` on **every** `item.open` and `item.close`                                                         | all items                           |
| A shell command with streamed output                                                                             | `command` + `item.outputDelta`      |
| A file read                                                                                                      | `fileRead`                          |
| A content search                                                                                                 | `search`                            |
| Delegated work with a real child turn linked through `parentRef`                                                 | `delegation` + keyed `turn.open`    |
| A plan snapshot                                                                                                  | `planSteps`                         |
| A bookkeeping tool whose row clients collapse                                                                    | `tool` with `presentation.suppress` |
| The plugin's bb tool, called over `item/tool/call` and stamped `server: "bb"` with the definition's presentation | `tool`                              |
| The extension item, validated server-side against the declared schema                                            | `extension`                         |
| The extension state, latest snapshot wins                                                                        | `extension.state`                   |
| The echoed message, reporting the derived `providerOptions` and the passed-through env var                       | `item.textDelta` / `item.textClose` |
| Usage and the context-window meter                                                                               | `usage`, `contextWindow`            |
| A zero-work turn (`/noop`) that still settles                                                                    | `turn.boundary` with `claimIfIdle`  |
| A malformed extension payload (`malformed-receipt`) the server replaces with `provider/unhandled`                | `extension`                         |

Outside any session, the bridge answers the one maintenance request the
declaration turns on: `provider/health` → `{ supported: true, health: { status:
"ready", … } }`. `provider/usage` and `provider/installation/*` are declared
off and answer method-not-found, so declaration and bridge cannot disagree.

## How the bridge reaches a host

1. On install/reload the server builds `dist/host.js` and records
   `{pluginId, digest, byteLength, path}` — the same host artifact registry
   every `bb.host` plugin uses.
2. Thread commands for `echo-agent` carry a `bridgeLaunch` spec —
   `{source: {kind: "artifact", pluginId, digest, byteLength}}` — over the
   daemon wire, beside the `providerOptions` the plugin derived and the
   `dynamicTools` (with presentation) the server resolved.
3. The enrolled daemon downloads the bytes from
   `/internal/plugins/:pluginId/host/:digest`, verifies the digest **before**
   caching them, and runs the artifact with its own node through the bridge
   bootstrap, which hands the bridge its plugin-scoped data and temp
   directories. It never executes unverified bytes.

Trust model: installation trust, exactly like every other plugin surface —
a bridge runs only for an installed, enabled plugin, and the daemon executes
only what its server instructs.

## Install

```
bb plugin install ./examples/plugins/echo-provider --yes
bb plugin config echo-provider set shout true   # optional: prove the settings round trip
```

Then pick "Echo" in the provider picker and send a message. After editing
sources, `bb plugin reload echo-provider`.
