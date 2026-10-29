import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Cloudroom's own user skills: `~/.cloudroom/skills/<name>/SKILL.md`, shared by every Cloudroom instance on this computer. */
export function resolveUserSkillsRootPath(homeDir: string): string {
  return join(homeDir, ".cloudroom", "skills");
}

/** Moves skills from the old `<dataDir>/skills` folder into `~/.cloudroom/skills`. A name already in the new folder stays put. */
export async function moveLegacyUserSkills(args: {
  dataDir: string;
  userSkillsRootPath: string;
}): Promise<{ moved: string[]; skipped: string[] }> {
  const legacyRootPath = join(args.dataDir, "skills");
  const names = (await readdir(legacyRootPath).catch(() => [])).filter(
    (name) => !name.startsWith("."),
  );
  const moved: string[] = [];
  const skipped: string[] = [];
  if (names.length > 0) {
    await mkdir(args.userSkillsRootPath, { recursive: true });
  }
  for (const name of names) {
    const target = join(args.userSkillsRootPath, name);
    const taken = await stat(target).then(() => true, () => false);
    // A data folder on another disk cannot be renamed across; those skills stay put too.
    const ok =
      !taken &&
      (await rename(join(legacyRootPath, name), target).then(
        () => true,
        () => false,
      ));
    (ok ? moved : skipped).push(name);
  }
  // Only removes the old folder once it is empty.
  await rmdir(legacyRootPath).catch(() => undefined);
  return { moved, skipped };
}
