const { chmod, copyFile, rename } = require("node:fs/promises");
const path = require("node:path");

const LAUNCHER_PATH = path.resolve(__dirname, "..", "build", "linux-launcher.sh");

/** Puts the AppImage launcher in place of the Linux app binary, which moves to `<name>.bin` (#75). */
async function installLinuxLauncher(appOutDir, executableName) {
  const binaryPath = path.join(appOutDir, executableName);
  await rename(binaryPath, `${binaryPath}.bin`);
  await copyFile(LAUNCHER_PATH, binaryPath);
  await chmod(binaryPath, 0o755);
}

module.exports = { installLinuxLauncher };
