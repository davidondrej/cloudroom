import { cp, mkdir } from "node:fs/promises";
import { constants as fsConstants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface CopyBuiltinSkillsArgs {
  skillsRootPath: string;
  targetPath: string;
}

interface ResolveBuiltinSkillsRootPathArgs {
  moduleDir: string;
}

export const BUILTIN_SKILLS_DIRECTORY_NAME = "builtin-skills";
export const SHARED_SKILLS_DIRECTORY_NAME = "shared-skills";
const BUILTIN_SKILLS_SENTINEL_PATH = path.join("room-cli", "SKILL.md");
const BUILTIN_SKILLS_COPY_MODE = fsConstants.COPYFILE_FICLONE;
const builtinSkillsModuleDir = path.dirname(fileURLToPath(import.meta.url));

function hasBuiltinSkillsRoot(skillsRootPath: string): boolean {
  return existsSync(path.join(skillsRootPath, BUILTIN_SKILLS_SENTINEL_PATH));
}

export function resolveBuiltinSkillsRootPathForModuleDir(
  args: ResolveBuiltinSkillsRootPathArgs,
): string {
  const skillsRootPath = path.resolve(
    args.moduleDir,
    existsSync(
      path.join(args.moduleDir, "skills", BUILTIN_SKILLS_SENTINEL_PATH),
    )
      ? "skills"
      : BUILTIN_SKILLS_DIRECTORY_NAME,
  );
  if (!hasBuiltinSkillsRoot(skillsRootPath)) {
    throw new Error(`Missing built-in skills at ${skillsRootPath}`);
  }
  return skillsRootPath;
}

export function resolveBuiltinSkillsRootPath(): string {
  return resolveBuiltinSkillsRootPathForModuleDir({
    moduleDir: existsSync(
      path.resolve(
        builtinSkillsModuleDir,
        "../../../../../plugins/bb-guide/skills",
      ),
    )
      ? path.resolve(builtinSkillsModuleDir, "../../../../../plugins/bb-guide")
      : builtinSkillsModuleDir,
  });
}

export async function copyBuiltinSkills(
  args: CopyBuiltinSkillsArgs,
): Promise<void> {
  await cp(args.skillsRootPath, args.targetPath, {
    force: false,
    mode: BUILTIN_SKILLS_COPY_MODE,
    recursive: true,
  });
}

export function resolveSharedBuiltinSkillsRootPath(
  builtinRoot: string,
): string {
  const candidates = [
    path.resolve(builtinRoot, "..", SHARED_SKILLS_DIRECTORY_NAME),
    path.resolve(builtinRoot, "../../../../skills"),
    path.resolve(builtinRoot, "../../../skills"),
  ];
  const root = candidates.find((candidate) =>
    existsSync(path.join(candidate, "manifest.json")),
  );
  if (!root) throw new Error("Missing shared built-in skills manifest");
  return root;
}

export function readSharedBuiltinSkillNames(root: string): string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  const names: unknown = manifest.skills;
  if (
    !Array.isArray(names) ||
    !names.every(
      (name): name is string =>
        typeof name === "string" &&
        /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name),
    ) ||
    new Set(names).size !== names.length
  ) {
    throw new Error(`Invalid built-in skills manifest at ${root}`);
  }
  return names;
}

export async function copySharedBuiltinSkills(
  root: string,
  target: string,
): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const name of readSharedBuiltinSkillNames(root)) {
    readFileSync(path.join(root, name, "SKILL.md"));
    await cp(path.join(root, name), path.join(target, name), {
      recursive: true,
      mode: BUILTIN_SKILLS_COPY_MODE,
    });
  }
  await cp(
    path.join(root, "manifest.json"),
    path.join(target, "manifest.json"),
  );
}
