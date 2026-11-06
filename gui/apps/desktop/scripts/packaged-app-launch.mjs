import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const LINUX_DISABLE_SANDBOX_ARGUMENT = "--no-sandbox";

export function createPackagedAppLaunchArguments({ platform, userDataDir }) {
  const sandboxArguments =
    platform === "linux" ? [LINUX_DISABLE_SANDBOX_ARGUMENT] : [];
  return [...sandboxArguments, `--user-data-dir=${userDataDir}`];
}

// Node 24.22.1+ adds this Brotli error code with the fix for CVE-2026-111497 (#583); vulnerable Node prints undefined.
export async function assertPatchedBrotli(appBinary) {
  const { stdout } = await promisify(execFile)(
    appBinary,
    ["-e", "process.stdout.write(process.version + ' ' + require('zlib').constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH)"],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 },
  );
  if (!stdout.trim().endsWith(" -17")) {
    throw new Error(`Packaged Node lacks the Brotli fix (CVE-2026-111497): ${stdout.trim()}`);
  }
}
