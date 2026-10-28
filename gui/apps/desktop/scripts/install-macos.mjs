import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assertBundleStopped,
  lsregister,
  run,
  unregisterBundle,
  verifyBundle,
} from "./macos-bundle.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionApp = "/Applications/Cloudroom.app";
const migrationsPath =
  "Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/drizzle";
const hasNoindexParent = (path) =>
  dirname(path)
    .split(sep)
    .some((part) => part.endsWith(".noindex"));

async function treeHash(root) {
  const hash = createHash("sha256");
  async function visit(path, relative) {
    const info = await lstat(path);
    hash.update(JSON.stringify([relative, info.mode]));
    if (info.isSymbolicLink()) hash.update(await readlink(path));
    else if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await visit(join(path, name), join(relative, name));
    } else if (info.isFile()) {
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    } else throw new Error(`Unsupported bundle file: ${path}`);
  }
  await visit(root, "");
  return hash.digest("hex");
}

async function validateBundle(bundle) {
  const { stdout } = await run("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    join(bundle, "Contents/Info.plist"),
  ]);
  const info = JSON.parse(stdout);
  if (
    info.CFBundleIdentifier !== "dev.cloudroom.gui" ||
    info.CFBundleExecutable !== "Cloudroom"
  ) {
    throw new Error(`Not the stable Cloudroom app: ${bundle}`);
  }
  await verifyBundle(bundle);
  const migrations = await treeHash(join(bundle, migrationsPath));
  return { version: info.CFBundleShortVersionString, migrations };
}

async function install({
  source,
  destination,
  backups,
  check,
  prepare,
  prepared,
  previous: retainedPrevious,
}) {
  if (process.platform !== "darwin")
    throw new Error("This installer requires macOS.");
  if (prepare && (prepared || check))
    throw new Error("Use --prepare, --prepared, or --check separately.");
  const receiptPath = prepared ? await realpath(prepared) : null;
  if (
    receiptPath &&
    (basename(receiptPath) !== "prepared.json" ||
      !/^\.cloudroom-install-.+\.noindex$/.test(basename(dirname(receiptPath))))
  ) throw new Error("Not an installer preparation receipt.");
  const receipt = receiptPath
    ? JSON.parse(await readFile(receiptPath, "utf8"))
    : null;
  if (receipt) {
    source = join(dirname(receiptPath), "Cloudroom.app");
    destination = receipt.destination;
    retainedPrevious = receipt.previous;
  }
  source = await realpath(source);
  if (receiptPath && source !== join(dirname(receiptPath), "Cloudroom.app"))
    throw new Error("Prepared bundle must not be a symlink.");
  destination = join(
    await realpath(dirname(destination)),
    basename(destination),
  );
  if (
    basename(destination) !== "Cloudroom.app" ||
    (destination !== productionApp && !hasNoindexParent(destination))
  ) {
    throw new Error(
      "Destination must be /Applications/Cloudroom.app or Cloudroom.app inside a .noindex test directory.",
    );
  }
  if (!hasNoindexParent(source) || source === destination)
    throw new Error("Build the source app inside release.noindex first.");
  if (retainedPrevious) {
    retainedPrevious = resolve(retainedPrevious);
    if (
      !hasNoindexParent(retainedPrevious) ||
      retainedPrevious === source ||
      retainedPrevious === destination ||
      (await lstat(retainedPrevious).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }))
    )
      throw new Error(
        "Retained rollback must be a new path inside the caller's .noindex staging directory.",
      );
  }
  if (!prepare) await assertBundleStopped(destination);
  if (receiptPath && dirname(dirname(receiptPath)) !== dirname(destination))
    throw new Error("Preparation receipt belongs to another destination.");
  const candidate = await validateBundle(source);
  if (
    receipt &&
    (JSON.stringify(candidate) !== JSON.stringify(receipt.candidate) ||
      (await treeHash(source)) !== receipt.candidateHash)
  ) throw new Error("Prepared build changed; prepare it again before installation.");
  const exists = await lstat(destination)
    .then((s) => {
      if (!s.isDirectory() || s.isSymbolicLink())
        throw new Error(
          `Destination is not a regular app directory: ${destination}`,
        );
      return true;
    })
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  const current = exists ? await validateBundle(destination) : null;
  if (receipt && exists !== (receipt.before !== null))
    throw new Error("Installed app changed after preparation.");
  if (current && current.migrations !== candidate.migrations) {
    throw new Error(
      "Packaged migrations differ. Review the database change separately; app was not replaced.",
    );
  }
  if (check) {
    console.log(
      JSON.stringify({
        checked: true,
        source,
        destination,
        version: candidate.version,
      }),
    );
    return;
  }

  const lockPath = join(dirname(destination), ".cloudroom-install.lock");
  const lock = await open(lockPath, "wx").catch((error) => {
    if (error.code === "EEXIST")
      throw new Error(
        `Installation lock exists: ${lockPath}. Check its owner before removing a stale lock.`,
      );
    throw error;
  });
  const stage = receiptPath
    ? dirname(receiptPath)
    : join(dirname(destination), `.cloudroom-install-${randomUUID()}.noindex`);
  const staged = join(stage, "Cloudroom.app");
  const previous = retainedPrevious ?? join(stage, "previous", "Cloudroom.app");
  let preserveStage = Boolean(receipt);
  let archive = receipt?.backup;
  try {
    await lock.writeFile(`${process.pid}\n`);
    if (!receipt) await mkdir(stage, { mode: 0o700 });
    if (!prepare) await assertBundleStopped(destination);
    if (
      exists &&
      JSON.stringify(await validateBundle(destination)) !==
        JSON.stringify(current)
    ) {
      throw new Error(
        "Installed app changed before acquiring the installation lock; retry.",
      );
    }
    const before = receipt
      ? receipt.before
      : exists ? await treeHash(destination) : null;
    if (!receipt) {
      await run("/usr/bin/ditto", [source, staged]);
      if (
        JSON.stringify(await validateBundle(staged)) !== JSON.stringify(candidate)
      ) {
        throw new Error(
          "Build changed during preparation; retry after packaging finishes.",
        );
      }
    }
    if (exists && !receipt) {
      await mkdir(backups, { recursive: true, mode: 0o700 });
      archive = join(
        backups,
        `Cloudroom-${current.version}-${randomUUID()}.zip`,
      );
      const pending = join(stage, "backup.zip");
      const restored = join(stage, "restore");
      await run("/usr/bin/ditto", [
        "-c",
        "-k",
        "--sequesterRsrc",
        "--keepParent",
        destination,
        pending,
      ]);
      await run("/usr/bin/ditto", ["-x", "-k", pending, restored]);
      await verifyBundle(join(restored, "Cloudroom.app"));
      if ((await treeHash(join(restored, "Cloudroom.app"))) !== before)
        throw new Error("Backup verification failed; app was not replaced.");
      await rename(pending, archive);
      await unregisterBundle(restored);
      await rm(restored, { recursive: true, force: true });
    }
    if (prepare) {
      const receiptFile = join(stage, "prepared.json");
      await writeFile(receiptFile, JSON.stringify({
        destination, previous, backup: archive ?? null, before, candidate,
        candidateHash: await treeHash(staged),
      }), { mode: 0o600 });
      preserveStage = true;
      console.log(JSON.stringify({
        prepared: receiptFile, source: staged,
        backup: archive ?? null, version: candidate.version,
      }));
      return;
    }
    await assertBundleStopped(destination);
    if (exists && (await treeHash(destination)) !== before)
      throw new Error(
        "Installed app changed during preparation; retry after reviewing the other installation.",
      );
    if (exists) {
      await mkdir(dirname(previous), { recursive: true });
      await rename(destination, previous);
      preserveStage = true;
    }
    let placed = false;
    try {
      await rename(staged, destination);
      placed = true;
      await verifyBundle(destination);
    } catch (error) {
      if (placed) await rename(destination, staged);
      else if (await lstat(destination).catch(() => null)) throw error;
      if (exists) {
        await rename(previous, destination);
        preserveStage = false;
      }
      throw error;
    }
    preserveStage = false;
    if (exists) await unregisterBundle(previous);
    await unregisterBundle(source);
    await run(lsregister, ["-f", destination]);
    console.log(
      JSON.stringify({
        installed: destination,
        version: candidate.version,
        backup: archive ?? null,
      }),
    );
  } finally {
    try {
      if (!preserveStage) {
        await unregisterBundle(stage);
        await rm(stage, { recursive: true, force: true });
      } else {
        console.error(`Preparation and recovery files preserved at ${stage}`);
      }
    } finally {
      await lock.close();
      await rm(lockPath);
    }
  }
}

const { values } = parseArgs({
  options: {
    source: {
      type: "string",
      default: join(packageRoot, "release.noindex/mac-arm64/Cloudroom.app"),
    },
    destination: { type: "string", default: productionApp },
    backups: {
      type: "string",
      default: join(
        homedir(),
        "Library/Application Support/Cloudroom/installer-backups.noindex",
      ),
    },
    previous: { type: "string" },
    check: { type: "boolean", default: false },
    prepare: { type: "boolean", default: false },
    prepared: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/install-macos.mjs [--check | --prepare | --prepared RECEIPT] [--source APP] [--destination APP] [--backups DIR] [--previous PATH]\n--prepare stages a verified build and ZIP rollback while the app runs. --prepared swaps that build after shutdown.\n--previous retains the old bundle for health-check rollback. Never quits, launches, or migrates data.",
  );
} else {
  await install({
    ...values,
    source: resolve(values.source),
    destination: resolve(values.destination),
    backups: resolve(values.backups),
  }).catch((error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
