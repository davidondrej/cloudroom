# @cloudroom/desktop

macOS, Linux, and Windows Electron shell for bb. The desktop app loads the existing bb
web UI and uses the packaged `bb-app` launcher for server and host-daemon
lifecycle.

## Development

From the repo root, run `pnpm dev` in one terminal for the source server and
live UI updates. In a second terminal, start the Electron shell:

```bash
pnpm exec turbo run dev --filter=@cloudroom/desktop
```

The dev script builds `bb-app`, compiles the Electron main/preload files, and
opens Electron directly. By default it uses the same checkout-scoped
`~/.bb-dev/<checkout-instance>` data directory and deterministic high ports as
`pnpm dev`; it prints the resolved data dir, server URL, and
Electron user-data dir at startup. It intentionally overwrites inherited
`BB_DATA_DIR`, `BB_SERVER_PORT`, `BB_SERVER_URL`, and `BB_HOST_DAEMON_PORT` so a
desktop dev run launched from an existing bb session still targets the current
checkout. Set `BB_DESKTOP_USER_DATA_DIR` to override only Electron's user-data
directory.

The launcher probes the checkout's Vite app port at startup and adapts:

- **`pnpm dev` is already running** (Vite reachable): the shell loads the Vite
  dev URL, so you get live source and HMR for `@cloudroom/app` changes — no rebuild
  needed. It still attaches to the same running server/daemon for all API/WS
  traffic. The launcher prints `app <url> (Vite dev server — live reload)`. This
  is the fast loop for iterating on the desktop UI.
- **`pnpm dev` is not running**: the shell starts its own `bb-app` runtime and
  loads the built UI it serves, so you must rebuild (re-run this task) to pick up
  source changes. The launcher prints `app (own bb-app runtime — …)`.

The override is plumbed via `BB_DESKTOP_APP_URL`, which the launcher only sets
when Vite is confirmed reachable; it is never set in packaged builds, so
production always loads the server's own built UI.

To run the slower unpacked Electron Builder app, which more closely matches the
packaged runtime and keeps native dependencies rebuilt for Electron's bundled
Node runtime:

```bash
pnpm exec turbo run start --filter=@cloudroom/desktop
```

Electron is pinned to `44.9.3`. macOS builds require macOS 13 (Ventura) or
newer. The bundled `bb-app` runtime uses `better-sqlite3@13.0.3`, whose N-API
binaries work with Electron without an ABI-specific rebuild. The packaging
hook opens an in-memory database with Electron before accepting the packaged
SQLite module; older ABI-specific modules still use the prebuild fallback.

## Validation

```bash
pnpm exec turbo run typecheck --filter=@cloudroom/desktop --filter=bb-app
pnpm exec turbo run build --filter=@cloudroom/desktop
pnpm exec turbo run test --filter=@cloudroom/desktop --filter=bb-app --force
pnpm exec turbo run dev --filter=@cloudroom/desktop
```

## Packaging

```bash
pnpm exec turbo run desktop:build --filter=@cloudroom/desktop
pnpm exec turbo run smoke:packaged --filter=@cloudroom/desktop
```

Artifacts are written under `apps/desktop/release.noindex/`. The macOS build is Apple
Silicon arm64-only; Intel Macs are not a target. Without signing secrets, local builds
sign with a code-signing identity auto-discovered from the keychain and skip
notarization. A valid signature matters even for local builds: macOS
provenance-tracks unsigned apps, forcing syspolicyd to evaluate every exec in
the app's process tree, which can stall process launches system-wide. On
machines with no keychain identity (or with `CSC_IDENTITY_AUTO_DISCOVERY=false`,
as CI sets for workflow-artifact-only builds), artifacts remain unsigned and
macOS shows the normal Gatekeeper warning on first launch.

For local verification without publishing, use
`pnpm exec turbo run package --filter=@cloudroom/desktop` on macOS, or
`pnpm exec turbo run package:linux --filter=@cloudroom/desktop` on Linux.

npm's bundled dependencies are copied through an explicit `files` entry into
`node_modules/npm/node_modules`, including nested dependency versions. pnpm's
dependency listing omits this bundled tree, and electron-builder's dependency
copier excludes nested `node_modules`. `asarUnpack` alone cannot preserve files
that the collector never selected. The explicit file set enters both ASAR's
file index and its unpacked resources before signing.

Packaging runs an offline npm smoke check in `afterPack`, before signing or
publishing. This requires a native target host (macOS arm64 or Linux x64).
`smoke:packaged` repeats it against the resulting artifact. To run only npm
verification without opening a desktop window:

```bash
pnpm exec turbo run smoke:packaged-npm --filter=@cloudroom/desktop
pnpm exec turbo run smoke:packaged-npm --filter=@cloudroom/desktop -- /absolute/path/to/bb.app/Contents/MacOS/bb
```

On Linux, the optional argument is the executable inside `linux-unpacked/` or
an extracted AppImage. The check resolves npm from packaged `bb-app`, audits
required dependency edges and version ranges in npm's entire bundled tree using
both CJS and ESM resolution, rejects paths outside packaged resources, imports npm's ESM display
dependencies, and verifies its version. It then uses bundled Electron and npm
to pack, install, and update a disposable plugin's dependency from 1.0.0 to
2.0.0, verifying the lockfile and importing the plugin's ESM entry after each
install. It uses the plugin install flags, an empty PATH, offline mode, a fresh
HOME/cache/config, and disabled lifecycle scripts. No system Node/npm or user
store is used by the child processes. It also hashes ASAR and unpacked resources
before and after to reject bundle mutations. Fixtures are removed afterward.

The bb-app tarball smoke covers a different packaging pipeline and cannot
detect Electron artifact omissions. A source build or `npm --version` alone
does not verify a desktop plugin dependency install.

### Windows (NSIS, x64)

Windows packaging needs a Windows x64 host: `afterPack` loads the packaged
native modules to verify them. Install with
`pnpm install --frozen-lockfile --ignore-scripts`, then
`node apps\desktop\node_modules\electron\install.js`, then from `gui/`:

```powershell
pnpm --dir apps\desktop run package:win        # release.noindex\win-unpacked\Cloudroom.exe
pnpm --dir apps\desktop run smoke:packaged
pnpm --dir apps\desktop run desktop:build:win  # Cloudroom-vN-x64.exe + latest.yml
```

The installer is a one-click, per-user NSIS installer: no admin prompt, and it
installs to `%LOCALAPPDATA%\Programs\Cloudroom` (`Cloudroom-Nightly` on the
nightly channel). `/S` installs or uninstalls silently. It bundles Python for
the preview helper, but not Git: users install Git for Windows. The detached
preview helper keeps that `python.exe` open, so before the installer replaces
or removes files, `build/installer.nsh` asks the helper to `pause`, then
force-stops any `python*.exe` still running from the install folder.
electron-builder's own check misses a single process on Windows PowerShell 5.1.

Without `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` the installer is unsigned,
and SmartScreen warns before it runs. The release workflow passes them from
the `WINDOWS_CERTIFICATE_PFX` and `WINDOWS_CERTIFICATE_PASSWORD` secrets.

`afterPack` copies `@parcel/watcher-win32-x64` into the package, because
electron-builder leaves it out, and loads it with the packaged Electron.

Inside the installed app, `room-cli.cmd` and `room-cli.ps1` run on
`Cloudroom.exe` with `ELECTRON_RUN_AS_NODE=1`, so the PC needs no Node.
PowerShell picks `room-cli.ps1`, which passes arguments as JSON in
`ROOM_CLI_ARGV`, so cmd.exe never re-parses them.

### Linux (AppImage, x64)

Linux packaging targets x64 glibc-based distributions. Install `python3`,
`make`, and `g++` so node-gyp can build node-pty during dependency installation.

From the repo root, build an unpacked app, an AppImage distribution, or smoke
test the current packaged output with:

```bash
pnpm exec turbo run package:linux --filter=@cloudroom/desktop
pnpm exec turbo run desktop:build:linux --filter=@cloudroom/desktop
pnpm exec turbo run smoke:packaged --filter=@cloudroom/desktop
```

Running an AppImage normally requires FUSE and, on some distributions, the
`libfuse2` compatibility package. If FUSE is unavailable, launch it with
`--appimage-extract-and-run` instead.

Linux users whose window manager supplies all window controls can remove the
native Electron title bar with `--no-window-frame`:

```bash
./bb-x86_64.AppImage --no-window-frame
```

The native frame remains the default. Changing this startup option requires a
full desktop app restart.

Linux users can opt into a transparent Electron window with
`--transparent-window`:

```bash
./bb-x86_64.AppImage --transparent-window
```

The window remains opaque by default. Transparency also requires a compositor
that supports it, and Electron documents limitations including unsupported
window shaping and unreliable resize behavior on some platforms. The flag can
be combined with `--no-window-frame`, and changing it requires a full desktop
app restart.

CI builds Linux artifacts on the pinned `ubuntu-22.04` runner. The AppImage
links against the build machine's glibc, so that pin sets the oldest
distribution that can run a published build. Raise it deliberately.

Linux gets both update paths, but they are not equivalent:

- The JSON version feed (`desktop-version-linux.json`) is polled on every Linux
  install and reports that a newer release exists.
- Self-installing auto-update runs only inside an AppImage whose directory the
  app can write to. electron-updater detects the AppImage through the `APPIMAGE`
  environment variable, and its install step unlinks the running file _before_
  moving the replacement in — so a read-only directory would delete the app and
  leave nothing behind. Both the startup check and the install handler verify
  write and search access on the parent directory first.
- Everything else — an extracted directory, a distribution package, or an
  AppImage in a read-only location — reports new versions without installing
  them.

The Linux AppImage is unsigned, and electron-updater performs no signature
check on Linux: it verifies only the SHA-512 recorded in the update metadata
that ships beside it. macOS installs through Squirrel, which additionally
requires the replacement to satisfy the running app's code-signing
requirement. Write access to the release assets is therefore sufficient to
push code to Linux clients. Treat the release token accordingly.

## Releasing

The release version is the `vN` from `web/app/changelog/releases.ts`. Release builds stamp it into the app bundle (`N.0.0`) and the bundled `bb-app/package.json`; source checkouts stay `0.0.0-dev`.

Cloudroom releases are built and published by the root
`.github/workflows/release-gui.yml` workflow (see the `release-gui` skill and
[Auto-update](#auto-update)).

## Nightly channel

No workflow publishes nightly builds. A build made with
`BB_DESKTOP_RELEASE_CHANNEL=nightly` (see below) still gets the nightly identity.

The nightly desktop is a separate installation:

- product name: `bb Nightly`
- bundle identifier: `dev.bb.desktop.nightly`
- Linux binary name: `bb-nightly`, so it never shadows stable `bb` on PATH
- app/update release: `desktop-nightly`
- update metadata: `nightly-mac.yml` and `nightly-linux.yml`
- version feeds: `desktop-version.json` (macOS) and
  `desktop-version-linux.json` (Linux)
- icon: `assets/icon-nightly.icns` and `assets/icon-nightly.png`

Stable and nightly desktop bundles can coexist. Electron-owned preferences,
window state, and process supervision use separate application data
directories; the embedded bb runtime still uses the normal `~/.bb` data and
default server port unless the corresponding environment variables are
overridden.

Nightly builds set `BB_DESKTOP_RELEASE_CHANNEL=nightly` at build time. The value
is baked into the Electron main/preload bundles and selects the nightly product
identity, yellow icon, and update URLs. Omit the variable (or set it to
`latest`) for stable and local builds.

## About panel

The app menu's About item opens a message box listing the facts a bug report
needs: version, build type, commit, build date and how old that build is
("3 days old"), plugin SDK version, Electron version, and OS. Its **Copy**
button puts that whole block on the clipboard. The age is computed when the
dialog opens, so a long-running session still reports it correctly.

The native About panel is populated too, minus the age, since Electron takes
those options once at startup. `scripts/build.mjs` bakes the build-time half of
the facts into the bundles:

| Variable                | Default when unset                                    |
| ----------------------- | ----------------------------------------------------- |
| `BB_DESKTOP_COMMIT`     | `GITHUB_SHA`, else `git rev-parse HEAD`, else unknown |
| `BB_DESKTOP_BUILD_DATE` | The build's own timestamp, ISO 8601                   |

The plugin SDK version is read from `packages/plugin-sdk/package.json` at build
time. A checkout with no git metadata reports `Commit: unknown` rather than
failing the build.

## macOS signing + notarization

Cloudroom releases are built, signed, and notarized by GitHub Actions (see the
`release` skill). The [signing wrapper](scripts/run-electron-builder.mjs)
signs and notarizes when `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are all set, then notarizes
and staples the DMG too. A partial set fails before packaging. Locally,
`APPLE_KEYCHAIN_PROFILE=<notarytool profile>` does the same with the Keychain's
Developer ID identity. Local builds with neither sign via keychain
auto-discovery and skip notarization.

## Auto-update

Cloudroom updates itself. `electron-updater` reads `latest-mac.yml` from the latest public release of
`davidondrej/cloudroom` (core releases there are never Latest), downloads the zip in the background, and shows
**Relaunch** in Settings and the update banner. Only stamped stable release
builds write `latest-*.yml`, so releases must be marked latest, not prerelease. The
`cloudroom.dev/download/latest` version check stays as the fallback: it shows
**Download** when the in-app updater cannot install. Local dev builds skip
Electron auto-update unless `BB_DESKTOP_AUTO_UPDATE=1` is set.

Windows reads `latest.yml` from the same release, downloads the `.exe` in the
background, and runs it silently on quit. **Restart to update** keeps Cloudroom
open until the installer's progress window shows (the installer then closes it),
and reopens Cloudroom when it finishes. Before anything stops, it checks the downloaded installer
is still on disk. If the installer can't start, Cloudroom reopens on the old
version; if that failure comes after Cloudroom has quit, the next launch sees
the old version and offers the download again. To test updates against a local feed, build both versions with
`BB_DESKTOP_UPDATE_BASE_URL=http://127.0.0.1:PORT/`; it is read only at build
time.

`bb Nightly` follows the equivalent isolated `desktop-nightly` release and
`nightly-mac.yml`; it never reads or moves the stable feed.

To verify a downloaded or unpacked build:

```bash
spctl --assess --verbose /path/to/bb.app
codesign --verify --deep --strict --verbose=2 /path/to/bb.app
```

## Debugging

Use the View menu to toggle DevTools. To open them automatically on launch, set
`BB_DESKTOP_OPEN_DEVTOOLS=1`:

```bash
BB_DESKTOP_OPEN_DEVTOOLS=1 apps/desktop/release.noindex/mac-arm64/bb.app/Contents/MacOS/bb
```

When the desktop app spawns `bb-app`, server and daemon logs land under
`~/.bb/logs/` or `$BB_DATA_DIR/logs/` when `BB_DATA_DIR` is set.

To verify attach-if-found manually, start a compatible bb first, then launch the
desktop app:

```bash
npx bb-app@latest
pnpm exec turbo run dev --filter=@cloudroom/desktop
```

The desktop supervisor handles normal quits plus `SIGINT` and `SIGTERM`, and it
writes a PID file so the next launch can reap a stale Electron-owned `bb-app`
launcher. Hard crashes such as process aborts, segfaults, or kernel-level kills
cannot run cleanup in the crashing process; the startup PID-file reap is the
recovery path for those cases.
