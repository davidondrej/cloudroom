import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);
export const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export async function assertBundleStopped(bundle) {
  const { stdout } = await run("/bin/ps", ["-axo", "comm="], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const canonical = await realpath(bundle).catch((error) => {
    if (error.code === "ENOENT") return resolve(bundle);
    throw error;
  });
  const prefixes = [
    resolve(bundle) + sep,
    canonical + sep,
    canonical.replace(/^\/private(?=\/(?:tmp|var)\/)/, "") + sep,
  ];
  if (
    stdout
      .split("\n")
      .some((line) => prefixes.some((prefix) => line.trim().startsWith(prefix)))
  ) {
    throw new Error(
      `App is running: ${bundle}. Wait for active work, then quit it before installing or cleaning up.`,
    );
  }
}

export async function verifyBundle(bundle) {
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
}

export async function unregisterBundle(bundle) {
  const root = resolve(bundle);
  async function registeredPaths() {
    const { stdout } = await run(lsregister, ["-dump"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return [...stdout.matchAll(/^path:\s+(.+?) \(0x[0-9a-f]+\)$/gm)]
      .map((match) => match[1])
      .filter((path) => path === root || path.startsWith(root + sep));
  }
  const paths = await registeredPaths();
  if (paths.length === 0) return;
  try {
    await run(lsregister, ["-u", ...paths]);
  } catch (error) {
    if (
      !`${error.stdout}${error.stderr}`.includes("-10814") ||
      (await registeredPaths()).length > 0
    )
      throw error;
  }
}

export async function withPackagedAppFixture(binary, test) {
  const root = join(
    await realpath(tmpdir()),
    `cloudroom-smoke-${randomUUID()}.noindex`,
  );
  await mkdir(root, { mode: 0o700 });
  const source = resolve(dirname(binary), "..", "..");
  const bundle =
    process.platform === "darwin" ? join(root, basename(source)) : null;
  try {
    if (bundle !== null) {
      await run("/usr/bin/ditto", [source, bundle]);
      await verifyBundle(bundle);
    }
    return await test(
      bundle === null
        ? binary
        : join(bundle, "Contents", "MacOS", basename(binary)),
      root,
    );
  } finally {
    if (bundle !== null) {
      await assertBundleStopped(bundle);
      await unregisterBundle(bundle);
      await rm(bundle, { recursive: true, force: true });
    }
  }
}
