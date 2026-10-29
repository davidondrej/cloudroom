# Built-in browser automation

`room-cli browser` is the experimental core API for automation integrations controlling Cloudroom desktop tabs. A plugin can use its core connection. For agent web tasks, use `browser-harness` instead (see the `browser-harness` skill).

Start with `room-cli browser instances --host <host-id> --json`. For every tab/control operation provide `--host <host-id> --instance <instance-id> --generation <generation> --thread <thread-id>`. The browser host can differ from the agent host. Never infer an active desktop window.

- `tabs`: list native tabs and their control state.
- `create [--url <http(s)-url>] [--reveal]`: create a tab with a separate automation profile. Defaults: hidden, about:blank.
- `acquire <tab-ids...> --controller <label> [--ttl-ms <ms>] [--allow-personal]`: acquire exclusive tab control. If the owning thread is already focused, open the side panel and select the first tab. New or activated CDP tabs follow the same rule. No thread switching or desktop window activation. Default expiry is five minutes, maximum thirty minutes. Personal tabs require the explicit handoff flag and carry their profile's authenticated authority.
- `connection <lease-id> --output <new-file>`: write private connection JSON with mode 0600 on the CLI host. The loopback WebSocket endpoint is usable only on the browser host. Pass it privately to an integration worker; never expose it through a shared port or chat output.
- `release <lease-id>`: revoke automation while keeping tabs open.
- `reveal <tab-id>`: open the side panel and select the existing native tab only if its thread is already focused; otherwise leave the current view unchanged.
- `capture <tab-id> --output <new-file>`: save a bounded JPEG to the CLI host without focusing the tab.
- `close <tab-id>`: explicitly close that native tab.
- `watch`: print changed tab snapshots every two seconds until interrupted. Disconnects report errors; this is not a lossless event log.

Cookie import copies signed-in sessions from a browser installed on the desktop host into a Cloudroom browser profile. These two commands take `--host`, `--instance`, and `--generation` but no `--thread`:

- `import-sources`: list importable browsers (Chrome, Chromium, Edge, Brave, Vivaldi, Opera, Arc, Firefox, Safari), their profiles with cookie counts, and why one is unavailable (`notInstalled`, `browserRunning`, `needsFullDiskAccess`, `needsKeychainApproval`, `unsupportedPlatform`).
- `import-cookies --from <source-id> --profile <directory> [--into personal|automation:<profile-id>]`: read that profile's cookie store and write it into the personal Cloudroom browser (default) or a named automation profile. The source browser must be quit first. macOS prompts for Keychain access for Chromium browsers and needs Full Disk Access for Safari. The result reports imported and skipped counts plus skipped hosts; `ok: false` carries a reason. A one-time copy, never a sync; partitioned cookies and non-default Firefox containers are skipped. Desktop only (macOS and Linux).

All commands support JSON output. In plugin code use `bb.sdk.experimental_desktopBrowsers`; the Plugin Guide documents the typed surface. Stop/Take over revokes native control; stopping the owning thread also releases its server control leases. Old connection generations cannot control replacement windows.

Cloud threads have no Cloudroom desktop tabs; agents there use `browser-harness` with the sandbox's Chromium.
