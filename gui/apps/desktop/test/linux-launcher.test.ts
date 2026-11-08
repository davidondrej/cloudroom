import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(resolve(process.cwd(), "package.json"));
const {
  installLinuxLauncher,
}: {
  installLinuxLauncher(
    appOutDir: string,
    executableName: string,
  ): Promise<void>;
} = require("./scripts/linux-launcher.cjs");

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o7777;
}

describe("installLinuxLauncher", () => {
  // Windows does not implement POSIX group/world permission bits.
  it.skipIf(process.platform === "win32")("leaves no group- or world-writable files from the Electron zip", async () => {
    root = await mkdtemp(join(tmpdir(), "linux-launcher-"));
    // electron-builder applies the modes stored in Electron's Linux zip: 0777 binaries, 0666 data.
    await writeFile(join(root, "gui-cloudroom"), "elf");
    await chmod(join(root, "gui-cloudroom"), 0o777);
    await writeFile(join(root, "chrome-sandbox"), "elf");
    await chmod(join(root, "chrome-sandbox"), 0o777);
    await mkdir(join(root, "locales"));
    await chmod(join(root, "locales"), 0o777);
    await writeFile(join(root, "locales", "en-US.pak"), "pak");
    await chmod(join(root, "locales", "en-US.pak"), 0o666);
    await writeFile(join(root, "resources.pak"), "pak");
    await chmod(join(root, "resources.pak"), 0o640);
    await symlink("resources.pak", join(root, "link.pak"));

    await installLinuxLauncher(root, "gui-cloudroom");

    expect((await modeOf(join(root, "gui-cloudroom.bin"))).toString(8)).toBe(
      "755",
    );
    expect((await modeOf(join(root, "gui-cloudroom"))).toString(8)).toBe("755");
    expect((await modeOf(join(root, "chrome-sandbox"))).toString(8)).toBe(
      "755",
    );
    expect((await modeOf(join(root, "locales"))).toString(8)).toBe("755");
    expect((await modeOf(join(root, "locales", "en-US.pak"))).toString(8)).toBe(
      "644",
    );
    expect((await modeOf(join(root, "resources.pak"))).toString(8)).toBe("640");
  });
});
