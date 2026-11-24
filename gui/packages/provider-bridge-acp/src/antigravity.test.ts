import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addAntigravitySkillFolders } from "./antigravity.js";

let home: string;
const configPath = () => join(home, ".gemini", "config", "skills.json");
const add = () => addAntigravitySkillFolders("agy", { HOME: home });
const read = async () => JSON.parse(await readFile(configPath(), "utf8"));

describe("addAntigravitySkillFolders", () => {
  afterEach(() => rm(home, { recursive: true, force: true }));

  it("lists existing folders once, by absolute path, and keeps the user's entries", async () => {
    home = await mkdtemp(join(tmpdir(), "agy-skills-"));
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    // A second path to the same folder is skipped.
    await symlink(join(home, ".agents", "skills"), join(home, ".claude", "skills"));
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ inherits: [], entries: [{ path: "/mine" }] }));

    await add();
    await add();

    expect(await read()).toEqual({
      inherits: [],
      entries: [{ path: "/mine" }, { path: join(home, ".agents", "skills") }],
    });
  });

  it("leaves a file it can't read as skills.json alone, and adds nothing without folders", async () => {
    home = await mkdtemp(join(tmpdir(), "agy-skills-"));
    await add();
    await expect(readFile(configPath(), "utf8")).rejects.toThrow();

    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(configPath(), "{ not json");
    await add();
    expect(await readFile(configPath(), "utf8")).toBe("{ not json");
  });
});
