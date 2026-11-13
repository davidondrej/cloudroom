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
  # uv runs from this download outside any sandbox, so it stays in the data folder, never the OS temp folder, which
  # Read-only Mac commands and sandboxed agents can change. A stopped install removes it too.
  tmp=$(mktemp -d "$home/install.XXXXXX")
  trap 'rm -rf "$tmp"; rmdir "$home/install.lock" 2>/dev/null' EXIT
  trap 'exit 1' HUP INT TERM
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
  rm -rf "$tmp"; rmdir "$home/install.lock"; trap - EXIT HUP INT TERM
fi

# 0.1.13 misses Brave's Linux folders (upstream PRs 650 and 843). Drop once a release has them.
py="$venv/lib/python3.12/site-packages/browser_harness/daemon.py"
if [ "$(uname -s)" = Linux ] && ! grep -qs '".config/BraveSoftware/Brave-Browser"' "$py"; then
  sed -i 's|".config/google-chrome",|".config/google-chrome", ".config/BraveSoftware/Brave-Browser", ".config/BraveSoftware/Brave-Origin",|' "$py" 2>/dev/null || true
fi
# 0.1.13 attaches to the first live browser in a fixed list, Chrome first, so a default Brave lost to an
# open Chrome (#981). Check the profile folder in BH_CLOUDROOM_PREFER_PROFILE first; the order is
# unchanged without it. Swapped in by rename like run.py; skips itself once a release changes the line.
if grep -qs '^PROFILES = profile_dirs()$' "$py"; then
  sed 's|^PROFILES = profile_dirs()$|PROFILES = sorted(profile_dirs(), key=lambda p, pref=os.environ.get("BH_CLOUDROOM_PREFER_PROFILE"): not (pref and p.as_posix().endswith("/" + pref)))|' "$py" > "$py.$$" 2>/dev/null && mv -f "$py.$$" "$py" 2>/dev/null || rm -f "$py.$$"
fi
# 0.1.13 reads each request with asyncio's 64 KiB line limit, so bigger ones failed with a broken pipe
# (upstream PR 377). Raise it to 64 MiB. Skips itself once a release changes the line.
ipc="$venv/lib/python3.12/site-packages/browser_harness/_ipc.py"
if grep -qs 'start_unix_server(handler, path=path)' "$ipc"; then
  sed -i.bak 's|start_unix_server(handler, path=path)|start_unix_server(handler, path=path, limit=1 << 26)|' "$ipc" 2>/dev/null && rm -f "$ipc.bak" || true
fi
# 0.1.13 runs snippets in run.py's own globals, so a snippet variable like "time" or "sys" replaced the
# runner's module and broke every later helper and the error report. Run each snippet in its own module
# instead, registered in sys.modules so dataclasses and pickling still find it. Swapped in by rename, so a
# parallel run never finds run.py missing.
run="$venv/lib/python3.12/site-packages/browser_harness/run.py"
if grep -qs 'exec(code, globals())' "$run"; then
  sed 's|exec(code, globals())|snippet = __import__("types").ModuleType("browser_harness_snippet"); snippet.__dict__.update(globals(), __name__=snippet.__name__); sys.modules[snippet.__name__] = snippet; exec(code, snippet.__dict__)|' "$run" > "$run.$$" 2>/dev/null && mv -f "$run.$$" "$run" 2>/dev/null || rm -f "$run.$$"
fi
# 0.1.13 press_key sends a printable key's text as a separate char event, so a page that cancels the keydown (a "?"
# shortcut that opens a search box) still got the character. Put the text on keyDown, as Puppeteer does, so Chromium
# drops it when the page cancels. Changes nothing unless both lines match; swapped in by rename like run.py.
helpers="$venv/lib/python3.12/site-packages/browser_harness/helpers.py"
if grep -qs 'type="char", text=text' "$helpers"; then
  "$venv/bin/python" -I - "$helpers" <<'PY' 2>/dev/null || true
import os, sys
path = sys.argv[1]
src = open(path).read()
down = '**({} if printable_char or not text else {"text": text})'
char = '''    if printable_char:
        cdp("Input.dispatchKeyEvent", type="char", text=text, **{k: v for k, v in base.items() if k != "text"})
'''
if src.count(down) == 1 and src.count(char) == 1:
    open(path + ".tmp%d" % os.getpid(), "w").write(src.replace(down, '**({"text": text} if text else {})').replace(char, ""))
    os.replace(path + ".tmp%d" % os.getpid(), path)
PY
fi

# 0.1.13 retries a daemon that exits at startup three times, then reports only "didn't come up", so the
# daemon's own reason (such as Chrome's remote debugging being off) never reached the agent. Add a fixed
# hint when the log bytes this start wrote contain a known failure. Log text is never shown, so nothing in
# it can leak. Runs once and swaps the file in by rename; skips itself once a release changes these lines.
admin="$venv/lib/python3.12/site-packages/browser_harness/admin.py"
if grep -qs '^    raise RuntimeError(f"daemon .* come up -- check {ipc.log_path(name or NAME)}")$' "$admin"; then
  "$venv/bin/python" - "$admin" <<'PY' 2>/dev/null || true
import os, sys
path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()
helpers = '''# Cloudroom (#1115): fixed hints for known daemon failures. Log text is never shown.
_CLOUDROOM_HINTS = (
    ((b"Operation not permitted", b"DevToolsActivePort"), "macOS blocked reading a browser profile folder. Ask the user to turn on Full Disk Access for Cloudroom (System Settings > Privacy & Security > Full Disk Access), then quit and reopen Cloudroom."),
    ((b"chrome://inspect/#remote-debugging",), "Chrome is running without remote debugging. Ask the user to open chrome://inspect/#remote-debugging in Chrome and tick 'Allow remote debugging for this browser instance', then retry."),
    ((b"chrome-not-running",), "No Chromium-based browser is running. Ask the user to open Chrome, then retry."),
)


def _cloudroom_log_state(name):
    try:
        st = ipc.log_path(name or NAME).stat()
        return st.st_size, st.st_mtime_ns
    except OSError:
        return 0, None


def _cloudroom_hint(name, before):
    """Fixed hint for a known failure in the log bytes written since before, else ""."""
    try:
        size, mtime = before
        log = ipc.log_path(name or NAME)
        st = log.stat()
        if (st.st_size, st.st_mtime_ns) == (size, mtime):
            return ""
        # The daemon truncates its log when it starts: a log that did not grow was rewritten.
        start = size if st.st_size > size else 0
        with open(log, "rb") as f:
            f.seek(max(start, st.st_size - 65536))
            data = f.read(65536)
        for markers, hint in _CLOUDROOM_HINTS:
            if all(m in data for m in markers):
                return ". " + hint
    except Exception:
        pass
    return ""
'''
nl = chr(10)
spawn = "                    p = subprocess.Popen("
final = '    raise RuntimeError(f"daemon {name or NAME} didn' + "'" + 't come up -- check {ipc.log_path(name or NAME)}")'
anchors = ("def ensure_daemon(wait=None, name=None, env=None):", spawn, final)
if all(lines.count(a) == 1 for a in anchors):
    out = []
    for line in lines:
        if line == anchors[0]:
            out.append(helpers)
        elif line == spawn:
            out.append("                    cloudroom_log = _cloudroom_log_state(name)")
        elif line == final:
            line = line[:-1] + ' + _cloudroom_hint(name, locals().get("cloudroom_log")))'
        out.append(line)
    tmp = f"{path}.{os.getpid()}"
    open(tmp, "w", encoding="utf-8").write(nl.join(out) + nl)
    os.replace(tmp, path)
PY
fi

# 0.1.13 reads BU_CDP_URL as an HTTP address and polls its /json/version, so a WebSocket address there, such as a
# built-in browser lease's endpoint, failed after 30 s (#1335). Pass a ws:// or wss:// one on as BU_CDP_WS.
case "$BU_CDP_URL" in ws://* | wss://*) [ -n "$BU_CDP_WS" ] || BU_CDP_WS=$BU_CDP_URL; export BU_CDP_WS; unset BU_CDP_URL ;; esac
# Use the user's default browser: tell the daemon its profile folder, so it wins over other open
# browsers, and when it is Chromium-based and closed, open it in the background. Prints
# "profile|bundle id to open". Safari and Firefox have no DevTools protocol.
if [ "$(uname -s)" = Darwin ] && { [ $# -eq 0 ] || [ "$1" = -c ]; } && [ -z "$BU_CDP_WS$BU_CDP_URL$BU_NAME" ]; then
  browser=$(osascript -l JavaScript -e '
    ObjC.import("AppKit");
    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com"));
    const id = url.isNil() ? "" : ($.NSBundle.bundleWithURL(url).bundleIdentifier.js || "");
    const chromium = /^(com[.]google[.]chrome|com[.]brave[.]browser|com[.]microsoft[.]edgemac|company[.]thebrowser[.](browser|dia)|org[.]chromium[.]chromium|ai[.]perplexity[.]comet)/i;
    const profile = {"com.google.chrome": "Google/Chrome", "com.brave.browser": "BraveSoftware/Brave-Browser", "com.microsoft.edgemac": "Microsoft Edge", "company.thebrowser.browser": "Arc/User Data", "company.thebrowser.dia": "Dia/User Data", "ai.perplexity.comet": "Comet"}[id.toLowerCase()] || "";
    profile + "|" + (chromium.test(id) && $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id).count === 0 ? id : "");
  ' 2>/dev/null || true)
  app=$(printf %s "$browser" | cut -s -d'|' -f2)
  [ -z "$app" ] || open -g -b "$app" 2>/dev/null || true
  BH_CLOUDROOM_PREFER_PROFILE=$(printf %s "$browser" | cut -s -d'|' -f1)
  export BH_CLOUDROOM_PREFER_PROFILE
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
elif [ "$(printf %s "$BU_NAME" | tr -cd 'A-Za-z0-9_-')" = "$BU_NAME" ] && [ -f "$home/active/$BU_NAME" ]; then
  # Using a per-thread daemon by its explicit name counts as use too (#1174). Other names, such as the
  # user's own daemons or "default", never get a marker, so cleanup never stops them.
  touch "$home/active/$BU_NAME"
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
