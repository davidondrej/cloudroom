import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10_000;

const STATUSLINE_PTY_SCRIPT = `
import json, os, pty, select, subprocess, sys, time
cmd, out_file, cwd = sys.argv[1], sys.argv[2], sys.argv[3]
settings = json.dumps({"statusLine": {"type": "command", "command": f"cat > {json.dumps(out_file)}"}})
master, slave = pty.openpty()
env = dict(os.environ)
env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "1"
p = subprocess.Popen([cmd, "--settings", settings], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env, close_fds=True)
os.close(slave)
data = None
email_seen_at = None
deadline = time.time() + 10.0
try:
    while time.time() < deadline:
        r, _, _ = select.select([master], [], [], 0.2)
        if r:
            try:
                os.read(master, 4096)
            except OSError:
                break
        if os.path.exists(out_file) and os.path.getsize(out_file) > 10:
            try:
                parsed = json.loads(open(out_file, "r", encoding="utf-8").read())
                if isinstance(parsed, dict) and (parsed.get("quota") or parsed.get("email")):
                    data = parsed
                    if parsed.get("quota"):
                        break
                    if email_seen_at is None:
                        email_seen_at = time.time()
                    elif time.time() - email_seen_at >= 2.0:
                        break
            except Exception:
                pass
        if p.poll() is not None:
            break
finally:
    p.terminate()
    try:
        p.wait(timeout=2)
    except Exception:
        p.kill()
    try:
        os.close(master)
    except OSError:
        pass
if data is not None:
    print(json.dumps(data))
`.trim();

/** Runs `agy` briefly in a PTY with a session-only `statusLine` hook to read email and live quota buckets without
 *  spending tokens. `env` picks the login: the Accounts plugin passes an added account's HOME (docs/scopes/
 *  multiple-subscriptions.md, 35). Null when agy printed nothing, such as when it is signed out. */
export async function readAntigravityStatus(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  if (process.platform === "win32") return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudroom-agy-usage-"));
  const outFile = path.join(dir, "status.json");
  try {
    const { stdout } = await execFileAsync(
      "python3",
      ["-c", STATUSLINE_PTY_SCRIPT, command, outFile, dir],
      {
        timeout: TIMEOUT_MS + 4_000,
        env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
        windowsHide: true,
      },
    );
    const trimmed = stdout.trim();
    return trimmed ? (JSON.parse(trimmed) as unknown) : null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
