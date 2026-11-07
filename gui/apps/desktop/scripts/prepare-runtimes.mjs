import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../.bundled-runtimes/", import.meta.url));
const gitCommit = "67ad42147a7acc2af6074753ebd03d904476118f";
const pythonRelease = "https://github.com/astral-sh/python-build-standalone/releases/download/20260510/";
const archives = [
  ["python.tar.gz", pythonRelease + "cpython-3.12.13+20260510-aarch64-apple-darwin-install_only_stripped.tar.gz", "55bc1a5edbc8ac4da0081f4f5731ed2d1ed10c57cb37a820b2a0dbc7cad742e9"],
  ["python-full.tar.zst", pythonRelease + "cpython-3.12.13+20260510-aarch64-apple-darwin-pgo+lto-full.tar.zst", "0750a735a09181ce203fb357df7221eab78d8ff4372d5cb6d58a2053765befdb"],
  ["git.tar.gz", "https://github.com/desktop/dugite-native/releases/download/v2.53.0-4/dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz", "f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe"],
  ["git-source.tar.gz", `https://github.com/git/git/archive/${gitCommit}.tar.gz`, "89b73762be55037144c92eaf5d0657b644330770f66c584c1ba2e7b90b6218cf"],
  ["git-build-source.tar.gz", "https://github.com/desktop/dugite-native/archive/refs/tags/v2.53.0-4.tar.gz", "6600bdf3c7e2cbb127ac63d9d38da3a91267610c6034ecb8ff73e94f89508f33"],
  ["cacert.pem", "https://curl.se/ca/cacert-2026-10-20.pem", "796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe"],
];
// Windows bundles only Python; Git for Windows is required instead (scope decision, #323).
const windowsArchives = [
  ["python-windows.tar.gz", pythonRelease + "cpython-3.12.13+20260510-x86_64-pc-windows-msvc-install_only_stripped.tar.gz", "24168aff2e7d93784c6a436124c4ebb79b076a4e289bde4902c08333507b71d0"],
  ["python-windows-full.tar.zst", pythonRelease + "cpython-3.12.13+20260510-x86_64-pc-windows-msvc-pgo-full.tar.zst", "e6dd25775677966bde76d1764cabd81be87611cbe5c3ce0a91b69ee1ac686a3d"],
  archives.at(-1),
];
// Windows: the standard library goes into python312.zip (precompiled, read in place by Python), and pip and the C
// headers' import libraries are dropped. ~1,100 fewer files, which Defender would scan on every install and update.
const zipWindowsStdlib = `
import os, py_compile, shutil, sys, tempfile, zipfile
root = sys.argv[1]; lib = os.path.join(root, "Lib"); pyc = os.path.join(tempfile.mkdtemp(), "m.pyc")
skip = {"site-packages", "__pycache__", "test", "idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3"}
with zipfile.ZipFile(os.path.join(root, "python312.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    for folder, folders, files in os.walk(lib):
        folders[:] = [name for name in folders if name not in skip]
        for name in files:
            path = os.path.join(folder, name); entry = os.path.relpath(path, lib).replace(os.sep, "/")
            if not name.endswith(".py"):
                z.write(path, entry); continue
            py_compile.compile(path, cfile=pyc, dfile=entry, doraise=True, invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
            z.write(pyc, entry + "c")
for name in ("Lib", "libs", "Scripts"):
    shutil.rmtree(os.path.join(root, name))
`;
const pythonCheck = "import ssl, sqlite3, sys, tomllib; assert ssl.create_default_context(cafile=sys.prefix + '/cacert.pem').cert_store_stats()['x509_ca'] > 100";

async function checksum(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function download([name, url, sha256]) {
  const archive = join(root, name), temporary = archive + ".download";
  try {
    if (await checksum(archive) === sha256) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`${name}: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    if (await checksum(temporary) !== sha256) throw new Error(`${name}: checksum mismatch`);
    await rename(temporary, archive);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function prepareWindowsPython() {
  await mkdir(root, { recursive: true });
  await Promise.all(windowsArchives.map(download));
  await rm(join(root, "python"), { recursive: true, force: true });
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-xf", join(root, "python-windows.tar.gz"), "-C", root]);
  execFileSync(tar, ["-xf", join(root, "python-windows-full.tar.zst"), "-C", root, "python/licenses"]);
  await cp(join(root, "cacert.pem"), join(root, "python/cacert.pem"));
  execFileSync(join(root, "python/python.exe"), ["-I", "-B", "-c", zipWindowsStdlib, join(root, "python")], { stdio: "inherit" });
  execFileSync(join(root, "python/python.exe"), ["-I", "-B", "-c", pythonCheck], { stdio: "inherit" });
  console.log("Bundled Python 3.12.13 for Windows x64: checksums verified; licenses included.");
}

/** The Rust Mac helper (`cloudroom helper` in Core), behind the rust-helper switch in the server's previews.ts. */
async function prepareHelper() {
  const core = fileURLToPath(new URL("../../../../core/", import.meta.url));
  const rustup = join(homedir(), ".cargo/bin/cargo");
  const cargo = process.env.CARGO ?? (existsSync(rustup) ? rustup : "cargo");
  execFileSync(cargo, ["build", "--release", "--locked", "--manifest-path", join(core, "Cargo.toml")], { stdio: "inherit" });
  const binary = join(root, "cloudroom-core/cloudroom");
  await rm(join(root, "cloudroom-core"), { recursive: true, force: true });
  await mkdir(join(root, "cloudroom-core"));
  await cp(join(process.env.CARGO_TARGET_DIR ?? join(core, "target"), "release/cloudroom"), binary);
  execFileSync("/usr/bin/strip", ["-x", binary]);
  execFileSync(binary, ["--version"], { stdio: "inherit" });
}

export async function prepareRuntimes() {
  if (process.platform === "win32" && process.arch === "x64") return prepareWindowsPython();
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Bundled runtimes require an Apple Silicon macOS build host.");
  }
  await mkdir(root, { recursive: true });
  await Promise.all(archives.map(download));
  for (const name of ["python", "git", "git-extract"]) {
    await rm(join(root, name), { recursive: true, force: true });
  }
  execFileSync("/usr/bin/tar", ["-xf", join(root, "python.tar.gz"), "-C", root]);
  execFileSync("/usr/bin/tar", ["-xf", join(root, "python-full.tar.zst"), "-C", root, "python/licenses"]);
  await cp(join(root, "cacert.pem"), join(root, "python/cacert.pem"));
  const staging = join(root, "git-extract"), git = join(root, "git");
  await mkdir(staging);
  execFileSync("/usr/bin/tar", ["-xf", join(root, "git.tar.gz"), "-C", staging]);
  const copy = (from, to) => cp(from, to, { recursive: true, verbatimSymlinks: true });
  await mkdir(join(git, "libexec/git-core"), { recursive: true });
  for (const name of ["bin/git", "etc/gitconfig", "share/git-core"]) {
    await copy(join(staging, name), join(git, name));
  }
  for (const name of await readdir(join(staging, "libexec/git-core"))) {
    if ((name === "git" || name.startsWith("git-")) && !name.startsWith("git-credential-manager") && name !== "git-lfs") {
      await copy(join(staging, "libexec/git-core", name), join(git, "libexec/git-core", name));
    }
  }
  await writeFile(join(git, "bin/git"), '#!/bin/sh\nroot=$(CDPATH= cd -- "${0%/*}/.." && pwd)\nexec "$root/libexec/git-core/git" --exec-path="$root/libexec/git-core" -c "init.templateDir=$root/share/git-core/templates" "$@"\n', { mode: 0o755 });
  await mkdir(join(git, "sources"));
  for (const name of ["git-source.tar.gz", "git-build-source.tar.gz"]) await copy(join(root, name), join(git, "sources", name));
  await writeFile(join(git, "COPYING"), execFileSync("/usr/bin/tar", ["-xOf", join(root, "git-source.tar.gz"), `git-${gitCommit}/COPYING`]));
  await writeFile(join(git, "sources/BUILD.txt"), "Git 2.53.0, unmodified core binaries from desktop/dugite-native v2.53.0-4.\nCorresponding Git sources and compilation scripts are included here.\nGit LFS and Git Credential Manager are not bundled.\n");
  await rm(staging, { recursive: true, force: true });
  execFileSync(join(root, "python/bin/python3"), ["-I", "-B", "-c", pythonCheck], { stdio: "inherit" });
  execFileSync(join(git, "bin/git"), ["--version"], { stdio: "inherit" });
  await prepareHelper();
  console.log("Bundled Python 3.12.13 and Git 2.53.0: checksums verified; licenses and Git sources included.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareRuntimes();
