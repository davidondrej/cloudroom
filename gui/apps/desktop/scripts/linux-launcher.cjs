const { chmod, copyFile, lstat, readdir, rename } = require("node:fs/promises");
const path = require("node:path");

const LAUNCHER_PATH = path.resolve(__dirname, "..", "build", "linux-launcher.sh");

/** Electron's Linux zip stores 0777 and 0666 modes, and electron-builder applies them as-is. */
async function removeGroupWorldWrite(target) {
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) return;
  if (stats.mode & 0o022) await chmod(target, stats.mode & 0o7755);
  if (!stats.isDirectory()) return;
  for (const name of await readdir(target)) {
    await removeGroupWorldWrite(path.join(target, name));
  }
}

/** Puts the AppImage launcher in place of the Linux app binary, which moves to `<name>.bin` (#75). */
async function installLinuxLauncher(appOutDir, executableName) {
  const binaryPath = path.join(appOutDir, executableName);
  await rename(binaryPath, `${binaryPath}.bin`);
  await copyFile(LAUNCHER_PATH, binaryPath);
  await chmod(binaryPath, 0o755);
  await removeGroupWorldWrite(appOutDir);
}

module.exports = { installLinuxLauncher };
