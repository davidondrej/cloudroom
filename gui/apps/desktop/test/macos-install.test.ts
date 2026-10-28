import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const installer = resolve("scripts/install-macos.mjs");
const helper = resolve("scripts/macos-bundle.mjs");
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const roots: string[] = [];
const migrationPath =
  "Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/drizzle";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await run(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { unregisterBundle } from ${JSON.stringify(helper)}; for (const app of process.argv.slice(1)) await unregisterBundle(app);`,
      ...["source", "installed", "restored"].map((folder) =>
        join(root, folder, "Cloudroom.app"),
      ),
    ]);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

async function fixture() {
  const root = join(
    await realpath(tmpdir()),
    `cloudroom-install-test-${randomUUID()}.noindex`,
  );
  roots.push(root);
  const source = join(root, "source/Cloudroom.app");
  const destination = join(root, "installed/Cloudroom.app");
  for (const [bundle, version] of [
    [source, "2.0.0"],
    [destination, "1.0.0"],
  ]) {
    await mkdir(join(bundle, "Contents/MacOS"), { recursive: true });
    await mkdir(join(bundle, migrationPath), { recursive: true });
    await copyFile("/bin/sleep", join(bundle, "Contents/MacOS/Cloudroom"));
    await writeFile(
      join(bundle, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.cloudroom.gui</string><key>CFBundleExecutable</key><string>Cloudroom</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
    );
    await writeFile(join(bundle, migrationPath, "schema.sql"), "select 1;\n");
    await writeFile(join(bundle, "Contents/Resources/version.txt"), version);
    await symlink(
      "version.txt",
      join(bundle, "Contents/Resources/version-link"),
    );
    await sign(bundle);
  }
  const args = [
    installer,
    "--source",
    source,
    "--destination",
    destination,
    "--backups",
    join(root, "backups"),
  ];
  return { root, source, destination, args };
}

async function sign(bundle: string) {
  await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
}

const versionFile = (app: string) =>
  join(app, "Contents/Resources/version.txt");

describe.skipIf(process.platform !== "darwin")("macOS app installation", () => {
  it("replaces twice, preserves verified ZIP rollbacks, and leaves no staging apps", async () => {
    const { root, destination, args } = await fixture();
    for (let cycle = 0; cycle < 2; cycle++) {
      const previous = join(root, "retained.bundle");
      const result = JSON.parse(
        (
          await run(
            process.execPath,
            cycle === 0 ? args : [...args, "--previous", previous],
          )
        ).stdout,
      );
      if (cycle === 1) {
        expect(await readFile(versionFile(previous), "utf8")).toBe("2.0.0");
        await run("/usr/bin/codesign", [
          "--verify",
          "--deep",
          "--strict",
          previous,
        ]);
      }
      expect(result.installed).toBe(destination);
      expect(await readFile(versionFile(destination), "utf8")).toBe("2.0.0");
      const restored = join(root, "restored");
      await run("/usr/bin/ditto", ["-x", "-k", result.backup, restored]);
      await run("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        join(restored, "Cloudroom.app"),
      ]);
      expect(
        await readFile(versionFile(join(restored, "Cloudroom.app")), "utf8"),
      ).toBe(cycle === 0 ? "1.0.0" : "2.0.0");
      expect(
        await readlink(
          join(restored, "Cloudroom.app/Contents/Resources/version-link"),
        ),
      ).toBe("version.txt");
      expect(await readdir(join(root, "installed"))).toEqual(["Cloudroom.app"]);
    }
    expect(
      (await readdir(join(root, "backups"))).filter((name) =>
        name.endsWith(".zip"),
      ),
    ).toHaveLength(2);
  }, 60_000);

  it("prepares a rollback while running but refuses to replace the app until shutdown", async () => {
    const { root, destination, args } = await fixture();
    let prepared: string | undefined;
    const child = spawn(
      join(
        destination.replace(/^\/private(?=\/tmp\/)/, ""),
        "Contents/MacOS/Cloudroom",
      ),
      ["60"],
    );
    await once(child, "spawn");
    try {
      await expect(run(process.execPath, args)).rejects.toThrow(
        "App is running",
      );
      expect(child.exitCode).toBeNull();
      expect(await readFile(versionFile(destination), "utf8")).toBe("1.0.0");
      const result = JSON.parse((await run(process.execPath, [
        ...args, "--prepare", "--previous", join(root, "previous.bundle"),
      ])).stdout);
      prepared = result.prepared;
      expect(child.exitCode).toBeNull();
      expect(await readFile(versionFile(destination), "utf8")).toBe("1.0.0");
      await run("/usr/bin/ditto", ["-x", "-k", result.backup, join(root, "restored")]);
      expect(await readFile(versionFile(join(root, "restored/Cloudroom.app")), "utf8")).toBe("1.0.0");
      await expect(run(process.execPath, [installer, "--prepared", prepared!])).rejects.toThrow("App is running");
    } finally {
      child.kill();
      await once(child, "exit");
    }
    await run(process.execPath, [installer, "--prepared", prepared!]);
    expect(await readFile(versionFile(destination), "utf8")).toBe("2.0.0");
    expect(await readFile(versionFile(join(root, "previous.bundle")), "utf8")).toBe("1.0.0");
  }, 60_000);

  it("refuses migration changes, invalid signatures, and overlapping installations", async () => {
    const { source, destination, args } = await fixture();
    await writeFile(join(source, migrationPath, "schema.sql"), "select 2;\n");
    await sign(source);
    await expect(run(process.execPath, args)).rejects.toThrow(
      "Packaged migrations differ",
    );
    await writeFile(join(source, migrationPath, "schema.sql"), "select 1;\n");
    await expect(run(process.execPath, args)).rejects.toThrow("codesign");
    await sign(source);
    await writeFile(
      join(destination, "..", ".cloudroom-install.lock"),
      "another installer",
    );
    await expect(run(process.execPath, args)).rejects.toThrow(
      "Installation lock exists",
    );
    expect(await readFile(versionFile(destination), "utf8")).toBe("1.0.0");
  });

  it("refuses changed prepared or installed bundles, even when re-signed", async () => {
    const { destination, args } = await fixture();
    const result = JSON.parse((await run(process.execPath, [...args, "--prepare"])).stdout);
    const apply = [installer, "--prepared", result.prepared];
    await writeFile(versionFile(result.source), "changed candidate");
    await sign(result.source);
    await expect(run(process.execPath, apply)).rejects.toThrow("Prepared build changed");
    await writeFile(versionFile(result.source), "2.0.0");
    await sign(result.source);
    await writeFile(versionFile(destination), "changed installed app");
    await sign(destination);
    await expect(run(process.execPath, apply)).rejects.toThrow("Installed app changed");
    expect(await readFile(versionFile(destination), "utf8")).toBe("changed installed app");
  }, 60_000);

  it("removes and unregisters its temporary test bundle even when the test fails, keeping logs", async () => {
    const { root, source } = await fixture();
    const record = join(root, "smoke-root.txt");
    const script = `
      import { writeFile } from 'node:fs/promises';
      import { withPackagedAppFixture, run, lsregister } from ${JSON.stringify(helper)};
      import { dirname, resolve, join } from 'node:path';
      await withPackagedAppFixture(process.argv[1], async (binary, root) => {
        await writeFile(process.argv[2], root);
        await writeFile(join(root, 'electron.log'), 'expected failure');
        const bundle = resolve(dirname(binary), '../..');
        const nested = join(bundle, 'Contents/Frameworks/Fixture.app');
        await run('/usr/bin/ditto', [resolve(dirname(process.argv[1]), '../..'), nested]);
        await run(lsregister, ['-f', bundle, nested]);
        throw new Error('simulated test failure');
      });`;
    await expect(
      run(process.execPath, [
        "--input-type=module",
        "--eval",
        script,
        join(source, "Contents/MacOS/Cloudroom"),
        record,
      ]),
    ).rejects.toThrow("simulated test failure");
    const smokeRoot = await readFile(record, "utf8");
    roots.push(smokeRoot);
    expect(smokeRoot.endsWith(".noindex")).toBe(true);
    expect(await readdir(smokeRoot)).toEqual(["electron.log"]);
    expect(
      (await run(lsregister, ["-dump"], { maxBuffer: 32 * 1024 * 1024 }))
        .stdout,
    ).not.toContain(join(smokeRoot, "Cloudroom.app"));
  }, 60_000);
});
