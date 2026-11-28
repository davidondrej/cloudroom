# Computer Use

Built-in computer use for Local threads (and Cloud threads with Mac access). Agents call `room-cli computer-use`; the
plugin asks the user once per thread, then forwards calls to a private
[Cua Driver](https://github.com/trycua/cua) daemon.

## How it works

- **Server** (`server.ts`): CLI, one-per-thread approval card persisted in SQLite (`plugin_kv`), one-thread-per-app lock.
- **Host** (`host.ts`): downloads the pinned driver on first use, starts it on a private socket, runs calls, saves screenshots to files.
- **App** (`app.tsx`): the approval card and the Settings section (macOS permissions, driver controls).
- **Skill** (`skills/computer-use`): teaches agents the observe, act, verify loop.

## Lifecycle

- The driver runs only while agents use it. A thread's session ends when its turn ends or it is archived.
- The driver stops when no thread still uses it, after 2 idle minutes, or when Cloudroom quits or crashes.
- Its stderr goes to `home/driver.log`, never a pipe. With a pipe, it outlived a crashed Cloudroom and kept screen capture running.
- On start, the host kills drivers left behind by a dead Cloudroom.

## Driver pin

- `driver.ts` pins one release: version, asset names, and SHA-256 digests from the release's `checksums.txt`.
- On macOS the binary must also be signed by Cua AI (team `YCK386LBJ7`). Nothing else is ever used: no PATH lookup, no `/Applications/CuaDriver.app`, no fallback (ADR 0147).
- To update: bump `driver.ts`, re-copy the digests, and smoke-test background clicks, typing, and screenshots.

## macOS permissions

- The daemon runs in Cua's embedded mode as a child of Cloudroom, so macOS shows only "Cloudroom" in Privacy settings.
- Any process Cloudroom starts inherits those grants, so the approval card is a guardrail, not a security wall.
- Test permissions only on a signed build. Dev and ad-hoc builds lose grants on rebuild.

## Isolation

- The driver runs with its own `HOME` under the plugin data folder, so it never shares config, caches, or pid files with a personal Cua install.
- That `HOME` would reach apps the driver cold-starts, so on macOS the host starts a closed app first the driver's way (NSWorkspace in the background, `oapp` event, focus handed back) with the user's `HOME` and confirms it is running before handing off to `launch_app` (#942, #2745). If prelaunch fails, times out, or cannot be confirmed, the host returns an error instead of letting the driver cold-start the app with its private `HOME`.
- Telemetry and update checks are off (`CUA_DRIVER_RS_TELEMETRY_ENABLED=false`, `CUA_DRIVER_RS_UPDATE_CHECK=false`).
- Each thread uses one `session` label, so screenshots and snapshots stay valid across separate calls.

Cua Driver is MIT licensed; see `CUA-DRIVER-LICENSE`.
