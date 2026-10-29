import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..", "..", "..");

it.each(["ci.yml", "gui-versions.yml"])(
  "keeps pull request jobs off the persistent Mac runner in %s",
  (workflow) => {
    const source = readFileSync(
      resolve(repoRoot, "..", ".github/workflows", workflow),
      "utf8",
    );
    const macRunnerLines = source
      .split("\n")
      .filter(
        (line) => line.includes("runs-on:") && line.includes("vars.MAC_RUNNER"),
      );
    expect(macRunnerLines.length).toBeGreaterThan(0);
    for (const line of macRunnerLines) {
      expect(line).toContain("github.event_name != 'pull_request'");
    }
  },
);

it("keeps desktop builds local without publishing", () => {
  const { scripts } = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/desktop/package.json"), "utf8"),
  );

  for (const command of ["desktop:build", "desktop:build:linux"]) {
    expect(scripts[command]).toContain("pnpm run build");
    expect(scripts[command]).toContain("--publish never");
  }
  expect(scripts.dist).toContain("pnpm run prepare-runtime");
  expect(scripts["dist:linux"]).toContain("pnpm run prepare-runtime");
});

it.each([".", "gui"])(
  "checks workspace %s without following directory symlinks",
  (directory) => {
    const fixture = mkdtempSync(join(tmpdir(), "cloudroom-source-check-"));
    onTestFinished(() => rmSync(fixture, { force: true, recursive: true }));
    const workspace = resolve(fixture, directory);
    mkdirSync(join(workspace, "scripts"), { recursive: true });
    mkdirSync(join(workspace, "skills"));
    symlinkSync("skills", join(workspace, "linked-skills"));
    writeFileSync(join(workspace, "source.ts"), 'export const ok = "yes";\n');
    writeFileSync(
      join(fixture, directory === "." ? "outside.png" : "outside.bin"),
      Buffer.from([0]),
    );
    const script = join(workspace, "scripts/check-source-nul.mjs");
    copyFileSync(join(repoRoot, "scripts/check-source-nul.mjs"), script);
    for (const args of [
      ["init", "-q"],
      ["add", "."],
    ]) {
      expect(spawnSync("git", args, { cwd: fixture }).status).toBe(0);
    }
    const run = () =>
      spawnSync(process.execPath, [script], { cwd: fixture, encoding: "utf8" });
    expect(run().status).toBe(0);
    writeFileSync(
      join(workspace, "source.ts"),
      Buffer.from('export const bad = "\0";\n'),
    );
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"source.ts":1: Literal NUL byte');
    unlinkSync(join(workspace, "source.ts"));
    expect(run().status).toBe(0);
  },
);

it.each([".", "gui"])(
  "requires SDK version bumps in workspace %s",
  (directory) => {
    const fixture = mkdtempSync(join(tmpdir(), "cloudroom-sdk-check-"));
    onTestFinished(() => rmSync(fixture, { force: true, recursive: true }));
    const workspace = resolve(fixture, directory);
    mkdirSync(join(workspace, "packages/plugin-sdk/src"), { recursive: true });
    const source = join(workspace, "packages/plugin-sdk/src/app-contract.ts");
    writeFileSync(source, "export const version = 1;\n");
    const git = (...args: string[]) =>
      spawnSync(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        { cwd: fixture },
      );
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "."],
      ["commit", "-qm", "base"],
      ["checkout", "-qb", "change"],
    ]) {
      expect(git(...args).status).toBe(0);
    }
    writeFileSync(source, "export const version = 2;\n");
    expect(git("commit", "-qam", "change SDK").status).toBe(0);
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, ".github/workflows/check-plugin-sdk-version.mjs")],
      {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, GITHUB_BASE_REF: "main" },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("surface changed without a version bump");
  },
);
