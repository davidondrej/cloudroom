import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAntigravityStatus } from "../src/antigravity-status.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function writeFakeAgy(scriptBody: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudroom-fake-agy-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "agy");
  await fs.writeFile(scriptPath, `#!/usr/bin/env python3\n${scriptBody}`, {
    mode: 0o755,
  });
  return scriptPath;
}

describe.skipIf(process.platform === "win32")("readAntigravityStatus", () => {
  it("waits for quota that arrives more than 2 seconds after email", async () => {
    const fakeAgy = await writeFakeAgy(`
import json, subprocess, sys, time

settings = json.loads(sys.argv[sys.argv.index("--settings") + 1])
status_cmd = settings["statusLine"]["command"]

def emit(payload):
    subprocess.run(status_cmd, input=json.dumps(payload), text=True, shell=True, check=True)

emit({"email": "user@example.com"})
time.sleep(3.0)
emit({"email": "user@example.com", "quota": {"buckets": [{"id": "gemini-5h", "remaining": 0.9}]}})
time.sleep(30.0)
`);

    const status = await readAntigravityStatus(fakeAgy);
    expect(status).toEqual({
      email: "user@example.com",
      quota: { buckets: [{ id: "gemini-5h", remaining: 0.9 }] },
    });
  }, 15_000);

  it("returns email within the overall deadline when quota is never reported", async () => {
    const fakeAgy = await writeFakeAgy(`
import json, subprocess, sys, time

settings = json.loads(sys.argv[sys.argv.index("--settings") + 1])
status_cmd = settings["statusLine"]["command"]
subprocess.run(
    status_cmd,
    input=json.dumps({"email": "user@example.com"}),
    text=True,
    shell=True,
    check=True,
)
time.sleep(30.0)
`);

    const startedAt = Date.now();
    const status = await readAntigravityStatus(fakeAgy);
    const elapsedMs = Date.now() - startedAt;

    expect(status).toEqual({ email: "user@example.com" });
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);
});
