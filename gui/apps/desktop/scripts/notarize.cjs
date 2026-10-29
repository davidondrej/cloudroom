// Notarizes with Apple, retrying network failures so a dropped upload never costs a rebuild.
// electron-builder's own notarize gives up on the first error (v121 lost a signed build that way).
// Also the afterSign hook: run-electron-builder.mjs sets it only when notarization is enabled.
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const ATTEMPTS = 3;

function authArgs(env) {
  const profile = env.APPLE_KEYCHAIN_PROFILE?.trim();
  if (profile) return ["--keychain-profile", profile];
  return ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID];
}

function run(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.on("error", () => resolveRun({ code: 1, stdout }));
    child.on("close", (code) => resolveRun({ code, stdout }));
  });
}

async function withRetries(label, attempt) {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (error) {
      if (error.permanent || n === ATTEMPTS) throw error;
      console.log(`${label} failed (${error.message}). Retrying in ${30 * n} s (${n + 1}/${ATTEMPTS}).`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 30_000 * n));
    }
  }
}

// Uploads `file` and waits for Apple's verdict. A rejection is final; anything else (a dropped upload) retries.
async function submit(file) {
  await withRetries(`Notarizing ${path.basename(file)}`, async () => {
    const { code, stdout } = await run("xcrun", ["notarytool", "submit", file, ...authArgs(process.env), "--wait", "--output-format", "json"]);
    let result = {};
    try {
      result = JSON.parse(stdout);
    } catch {}
    if (result.status === "Accepted") return;
    if (result.status) {
      if (result.id) await run("xcrun", ["notarytool", "log", result.id, ...authArgs(process.env)]);
      throw Object.assign(new Error(`Apple returned ${result.status}`), { permanent: true });
    }
    throw new Error(`notarytool exited ${code}`);
  });
}

async function staple(file) {
  await withRetries(`Stapling ${path.basename(file)}`, async () => {
    const { code } = await run("xcrun", ["stapler", "staple", file]);
    if (code !== 0) throw new Error(`stapler exited ${code}`);
  });
}

async function notarize(file) {
  await submit(file);
  await staple(file);
}

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const dir = await mkdtemp(path.join(os.tmpdir(), "cloudroom-notarize-"));
  const zip = path.join(dir, `${path.basename(app, ".app")}.zip`);
  try {
    const { code } = await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
    if (code !== 0) throw new Error(`ditto exited ${code}`);
    await submit(zip);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await staple(app);
}

module.exports = afterSign;
module.exports.default = afterSign;
module.exports.notarize = notarize;
