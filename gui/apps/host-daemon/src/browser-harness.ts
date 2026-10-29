import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// browser-harness for Local threads (ADR 0190). Agents run `browser-harness` exactly as upstream
// documents. The first run installs a pinned copy into Cloudroom's data folder; every run drives the
// user's own browser with telemetry and update checks off. Kept free of `${` and backslashes so the
// template literal is the script verbatim.
const SHIM = `#!/bin/sh
# Written by the Cloudroom host daemon (ADR 0190); edits are overwritten.
set -e
version=0.1.13
uv_version=0.13.4
home=$(cd "$(dirname "$0")/.." && pwd)/browser-harness
venv="$home/$version"
export BH_TELEMETRY=0 BH_UPDATE_CHECK=0

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

if [ ! -f "$venv/.ready" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=aarch64-apple-darwin sum=e0b1d4743ce64c55d9f0f4a444afa6b81125680070ee04e853fcd0f6c1ebf8f1 ;;
    Darwin-x86_64) target=x86_64-apple-darwin sum=7be2dcd316122f4b3e5a0a7889f6248266c14425374e105ff7dc9779184603a6 ;;
    Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-gnu sum=1ae72b4718729e2ccc4f1ae2c6d1e531ca8467800e0546e9130b3886023a60ab ;;
    Linux-x86_64) target=x86_64-unknown-linux-gnu sum=2b428396f12572d4429cf210ca234dd599a33b3af0958a4d5ed569d63e3f344f ;;
    *) echo "browser-harness: $(uname -sm) is not supported" >&2; exit 1 ;;
  esac
  mkdir -p "$home"
  # One installer at a time; a lock left by a killed install expires after 10 minutes.
  find "$home" -maxdepth 1 -name install.lock -mmin +10 -exec rmdir {} + 2>/dev/null || true
  until mkdir "$home/install.lock" 2>/dev/null; do sleep 1; done
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"; rmdir "$home/install.lock" 2>/dev/null' EXIT
  if [ ! -f "$venv/.ready" ]; then
    echo "browser-harness: installing $version (first use only)..." >&2
    curl -fsSL --proto '=https' "https://github.com/astral-sh/uv/releases/download/$uv_version/uv-$target.tar.gz" -o "$tmp/uv.tgz"
    [ "$(sha256 "$tmp/uv.tgz")" = "$sum" ] || { echo 'browser-harness: uv checksum mismatch' >&2; exit 1; }
    tar -xzf "$tmp/uv.tgz" -C "$tmp"
    export UV_PYTHON_INSTALL_DIR="$home/python" UV_CACHE_DIR="$home/cache" UV_PYTHON_PREFERENCE=only-managed UV_NO_CONFIG=1
    rm -rf "$venv"
    "$tmp/uv-$target/uv" venv --quiet --python 3.12 "$venv"
    "$tmp/uv-$target/uv" pip install --quiet --python "$venv/bin/python" "browser-harness==$version"
    for old in "$home"/0.*; do [ "$old" = "$venv" ] || rm -rf "$old"; done
    touch "$venv/.ready"
  fi
  rm -rf "$tmp"; rmdir "$home/install.lock"; trap - EXIT
fi

# 0.1.13 misses Brave's Linux folders (upstream PRs 650 and 843). Drop once a release has them.
py="$venv/lib/python3.12/site-packages/browser_harness/daemon.py"
if [ "$(uname -s)" = Linux ] && ! grep -qs '".config/BraveSoftware/Brave-Browser"' "$py"; then
  sed -i 's|".config/google-chrome",|".config/google-chrome", ".config/BraveSoftware/Brave-Browser", ".config/BraveSoftware/Brave-Origin",|' "$py" 2>/dev/null || true
fi
# 0.1.13 reads each request with asyncio's 64 KiB line limit, so bigger ones failed with a broken pipe
# (upstream PR 377). Raise it to 64 MiB. Skips itself once a release changes the line.
ipc="$venv/lib/python3.12/site-packages/browser_harness/_ipc.py"
if grep -qs 'start_unix_server(handler, path=path)' "$ipc"; then
  sed -i.bak 's|start_unix_server(handler, path=path)|start_unix_server(handler, path=path, limit=1 << 26)|' "$ipc" 2>/dev/null && rm -f "$ipc.bak" || true
fi

# Use the user's default browser: when it is Chromium-based and closed, open it in the background so
# browser-harness attaches to it. Safari and Firefox have no DevTools protocol.
if [ "$(uname -s)" = Darwin ] && { [ $# -eq 0 ] || [ "$1" = -c ]; } && [ -z "$BU_CDP_WS$BU_CDP_URL$BU_NAME" ]; then
  app=$(osascript -l JavaScript -e '
    ObjC.import("AppKit");
    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com"));
    const id = url.isNil() ? "" : ($.NSBundle.bundleWithURL(url).bundleIdentifier.js || "");
    const chromium = /^(com[.]google[.]chrome|com[.]brave[.]browser|com[.]microsoft[.]edgemac|company[.]thebrowser[.](browser|dia)|org[.]chromium[.]chromium|ai[.]perplexity[.]comet)/i;
    chromium.test(id) && $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id).count === 0 ? id : "";
  ' 2>/dev/null || true)
  [ -z "$app" ] || open -g -b "$app" 2>/dev/null || true
fi
# One daemon per thread, so parallel agents never act in each other's tab. Daemons never exit on
# their own: stop the ones whose thread hasn't used the browser for 2 hours. They restart on next use.
if [ -z "$BU_NAME" ] && [ -n "$ROOM_THREAD_ID" ]; then
  BU_NAME=$(printf %s "$ROOM_THREAD_ID" | tr -c 'A-Za-z0-9_-' _ | cut -c1-64)
  export BU_NAME
  mkdir -p "$home/active"
  touch "$home/active/$BU_NAME"
  for idle in $(find "$home/active" -type f -mmin +120 2>/dev/null); do
    rm -f "$idle"
    BU_NAME=$(basename "$idle") "$venv/bin/browser-harness" --reload >/dev/null 2>&1 &
  done
fi
exec "$venv/bin/browser-harness" "$@"
`;

/** Writes the shim to `<dataDir>/bin` and returns that folder for agents' PATH. */
export async function installBrowserHarnessShim(
  dataDir: string,
): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const bin = join(dataDir, "bin");
  const file = join(bin, "browser-harness");
  await mkdir(bin, { recursive: true });
  if ((await readFile(file, "utf8").catch(() => "")) !== SHIM) {
    await writeFile(file, SHIM);
  }
  await chmod(file, 0o755);
  return bin;
}
