import type { Dirent } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  DiscoveredSkill,
  HostCommandOrigin,
  HostCommandSource,
  HostProviderCommand,
  SkillRootKind,
} from "@cloudroom/host-daemon-contract";
import { isPathWithinDirectory } from "@cloudroom/process-utils";
import { parse as parseYaml } from "yaml";

export const SKILL_FILE_NAME = "SKILL.md";
const MARKDOWN_FILE_EXTENSION = ".md";
const FRONTMATTER_DELIMITER = "---";
const FRONTMATTER_PATTERN = /^\uFEFF?---([\s\S]*?)(?:\r?\n---|$)/u;

const MAX_SCAN_DEPTH = 24;
export const MAX_SCAN_ENTRY_COUNT = 5_000;
const SCAN_CONCURRENCY = 16;
const FRONTMATTER_READ_BYTES = 8 * 1024;
const FRONTMATTER_CLOSED_PATTERN = /^\uFEFF?---[\s\S]*?\r?\n---(?:\r?\n|$)/u;
const FRONTMATTER_CACHE_MAX_ENTRIES = 512;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index]!, index);
      }
    }),
  );
  return results;
}

interface CommandScanRootBase {
  namePrefix: string;
  skipIfManifest?: string;
  source: HostCommandSource;
  origin: HostCommandOrigin;
  skillIdentitySeed?: string;
}

interface CommandScanDirectoryRoot extends CommandScanRootBase {
  boundaryPath?: string;
  rootPath: string;
  shape: "skill" | "skill-recursive" | "skill-directory" | "command";
}

interface CommandScanFileRoot extends CommandScanRootBase {
  filePath: string;
  shape: "command-file";
}

interface CommandScanSkillFileRoot extends CommandScanRootBase {
  fallbackName: string;
  filePath: string;
  shape: "skill-file";
  source: "skill";
}

export type CommandScanRoot =
  | CommandScanDirectoryRoot
  | CommandScanFileRoot
  | CommandScanSkillFileRoot;

interface DiscoverProviderCommandsArgs {
  roots: readonly CommandScanRoot[];
}

interface ScanRootArgs {
  budget: ScanBudget;
  root: CommandScanRoot;
}

interface ScanBudget {
  remainingEntries: number;
  visitedDirs: Set<string>;
}

interface SkillDirectoryCheckArgs {
  entry: Dirent;
  entryPath: string;
  root: CommandScanDirectoryRoot;
}

interface WalkMarkdownTreeArgs {
  budget: ScanBudget;
  currentPath: string;
  depth: number;
  matchedFiles: string[];
  matches: (entry: Dirent) => boolean;
}

interface ParsedFrontmatter {
  name: string | null;
  description: string | null;
  argumentHint: string | null;
}

interface SkillFileMatch {
  filePath: string;
  frontmatter: ParsedFrontmatter;
  linked: boolean;
  name: string;
}

function newScanBudget(): ScanBudget {
  return { remainingEntries: MAX_SCAN_ENTRY_COUNT, visitedDirs: new Set() };
}

function sortDirentsByName(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name);
}

async function readDirEntries(
  dirPath: string,
  budget?: ScanBudget,
): Promise<Dirent[] | null> {
  try {
    const directory = await fs.opendir(dirPath);
    const entries: Dirent[] = [];
    for await (const entry of directory) {
      if (budget?.remainingEntries === 0) {
        break;
      }
      if (budget !== undefined) {
        budget.remainingEntries -= 1;
      }
      entries.push(entry);
    }
    return entries.sort(sortDirentsByName);
  } catch {
    return null;
  }
}

function hasSupportedFrontmatterDelimiter(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith(`${FRONTMATTER_DELIMITER}\n`) ||
    trimmed.startsWith(`${FRONTMATTER_DELIMITER}\r\n`)
  );
}

function parseFrontmatterData(content: string): Record<string, unknown> {
  const yaml = FRONTMATTER_PATTERN.exec(content)?.[1];
  const data: unknown = yaml === undefined ? {} : parseYaml(yaml);
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)
    : {};
}

function readFrontmatterString(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const value = data[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const frontmatterCache = new Map<
  string,
  { mtimeMs: number; size: number; frontmatter: ParsedFrontmatter }
>();

async function readFrontmatterText(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(FRONTMATTER_READ_BYTES);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      FRONTMATTER_READ_BYTES,
      0,
    );
    const head = buffer.toString("utf8", 0, bytesRead);
    if (
      bytesRead < FRONTMATTER_READ_BYTES ||
      !hasSupportedFrontmatterDelimiter(head) ||
      FRONTMATTER_CLOSED_PATTERN.test(head)
    ) {
      return head;
    }
  } finally {
    await handle.close();
  }
  return fs.readFile(filePath, "utf8");
}

async function parseFrontmatter(
  filePath: string,
  fileStat?: { mtimeMs: number; size: number },
): Promise<ParsedFrontmatter> {
  const stat =
    fileStat ?? (await fs.stat(filePath).catch(() => null));
  if (stat !== null) {
    const cached = frontmatterCache.get(filePath);
    if (
      cached !== undefined &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.frontmatter;
    }
  }

  let content: string;
  try {
    content = await readFrontmatterText(filePath);
  } catch {
    return { name: null, description: null, argumentHint: null };
  }

  let parsed: ParsedFrontmatter;
  if (!hasSupportedFrontmatterDelimiter(content)) {
    parsed = { name: null, description: null, argumentHint: null };
  } else {
    try {
      const data = parseFrontmatterData(content);
      parsed = {
        name: readFrontmatterString(data, "name"),
        description: readFrontmatterString(data, "description"),
        argumentHint: readFrontmatterString(data, "argument-hint"),
      };
    } catch {
      parsed = { name: null, description: null, argumentHint: null };
    }
  }

  if (stat !== null) {
    if (
      frontmatterCache.size >= FRONTMATTER_CACHE_MAX_ENTRIES &&
      !frontmatterCache.has(filePath)
    ) {
      const oldestKey = frontmatterCache.keys().next().value;
      if (oldestKey !== undefined) frontmatterCache.delete(oldestKey);
    }
    frontmatterCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      frontmatter: parsed,
    });
  }
  return parsed;
}

function canFollowSkillSymlink(root: CommandScanRoot): boolean {
  return root.origin === "user" && root.source === "skill";
}

async function isSkillDirectory(
  args: SkillDirectoryCheckArgs,
): Promise<boolean> {
  if (args.entry.isDirectory()) {
    return true;
  }
  if (!args.entry.isSymbolicLink() || !canFollowSkillSymlink(args.root)) {
    return false;
  }
  try {
    const stat = await fs.stat(args.entryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function statSkillFile(
  filePath: string,
  root: CommandScanRoot,
): Promise<{ linked: boolean; mtimeMs: number; size: number } | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isFile()) {
      return { linked: false, mtimeMs: stat.mtimeMs, size: stat.size };
    }
    if (!stat.isSymbolicLink() || !canFollowSkillSymlink(root)) {
      return null;
    }
    const targetStat = await fs.stat(filePath);
    return targetStat.isFile()
      ? { linked: true, mtimeMs: targetStat.mtimeMs, size: targetStat.size }
      : null;
  } catch {
    return null;
  }
}

async function isSymbolicLinkPath(filePath: string): Promise<boolean> {
  return (
    (await fs.lstat(filePath).catch(() => null))?.isSymbolicLink() ?? false
  );
}

async function buildRecord(
  args: CommandScanRoot,
  filePath: string,
  name: string,
): Promise<HostProviderCommand> {
  const frontmatter = await parseFrontmatter(filePath);
  return buildRecordFromFrontmatter(args, name, frontmatter);
}

function buildRecordFromFrontmatter(
  args: CommandScanRoot,
  name: string,
  frontmatter: ParsedFrontmatter,
): HostProviderCommand {
  return {
    name: `${args.namePrefix}${name}`,
    source: args.source,
    origin: args.origin,
    description: frontmatter.description,
    argumentHint: frontmatter.argumentHint,
  };
}

async function hasManifestMarker(
  root: CommandScanRootBase,
  skillDirPath: string,
): Promise<boolean> {
  if (root.skipIfManifest === undefined) {
    return false;
  }
  try {
    const manifestStat = await fs.lstat(
      path.join(skillDirPath, root.skipIfManifest),
    );
    return manifestStat.isFile();
  } catch {
    return false;
  }
}

async function scanSkillRootFiles(
  root: CommandScanDirectoryRoot,
): Promise<SkillFileMatch[]> {
  const entries = await readDirEntries(root.rootPath);
  if (entries === null) {
    return [];
  }
  const rootLinked = await isSymbolicLinkPath(root.rootPath);
  const results = await mapWithConcurrency(
    entries,
    SCAN_CONCURRENCY,
    async (entry): Promise<SkillFileMatch | null> => {
      const skillDirPath = path.join(root.rootPath, entry.name);
      if (!(await isSkillDirectory({ entry, entryPath: skillDirPath, root }))) {
        return null;
      }
      if (await hasManifestMarker(root, skillDirPath)) {
        return null;
      }
      const skillFilePath = path.join(skillDirPath, SKILL_FILE_NAME);
      const skillFile = await statSkillFile(skillFilePath, root);
      if (skillFile === null) {
        return null;
      }
      return {
        filePath: skillFilePath,
        frontmatter: await parseFrontmatter(skillFilePath, skillFile),
        linked: rootLinked || entry.isSymbolicLink() || skillFile.linked,
        name: entry.name,
      };
    },
  );
  return results.filter((match): match is SkillFileMatch => match !== null);
}

async function walkMarkdownTree(args: WalkMarkdownTreeArgs): Promise<void> {
  if (args.depth > MAX_SCAN_DEPTH || args.budget.remainingEntries === 0) {
    return;
  }
  const entries = await readDirEntries(args.currentPath, args.budget);
  if (entries === null) {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(args.currentPath, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdownTree({
        budget: args.budget,
        currentPath: entryPath,
        depth: args.depth + 1,
        matchedFiles: args.matchedFiles,
        matches: args.matches,
      });
      continue;
    }
    if (entry.isFile() && args.matches(entry)) {
      args.matchedFiles.push(entryPath);
    }
  }
}

async function resolveRecursiveRootPath(
  root: CommandScanDirectoryRoot,
): Promise<string | null> {
  const resolvedRoot = await fs.realpath(root.rootPath).catch(() => null);
  if (resolvedRoot === null) {
    return null;
  }
  if (root.origin !== "project" || root.boundaryPath === undefined) {
    return resolvedRoot;
  }
  const resolvedBoundary = await fs
    .realpath(root.boundaryPath)
    .catch(() => null);
  return resolvedBoundary !== null &&
    isPathWithinDirectory(resolvedBoundary, resolvedRoot)
    ? resolvedRoot
    : null;
}

interface SkillTreeFile {
  filePath: string;
  linked: boolean;
}

// A skill folder's own files are resources, not skills, so the walk stops at
// SKILL.md. Otherwise big skills (or synced copies) use up the shared budget
// and silently drop every skill that sorts after them.
async function walkSkillTree(args: {
  budget: ScanBudget;
  currentPath: string;
  depth: number;
  followSymlinks: boolean;
  linked: boolean;
  matchedFiles: SkillTreeFile[];
}): Promise<void> {
  if (args.depth > MAX_SCAN_DEPTH || args.budget.remainingEntries === 0) {
    return;
  }
  const realPath = await fs.realpath(args.currentPath).catch(() => null);
  if (realPath === null || args.budget.visitedDirs.has(realPath)) {
    return;
  }
  args.budget.visitedDirs.add(realPath);
  const entries = await readDirEntries(args.currentPath, args.budget);
  if (entries === null) {
    return;
  }
  if (
    entries.some((entry) => entry.name === SKILL_FILE_NAME && entry.isFile())
  ) {
    args.matchedFiles.push({
      filePath: path.join(args.currentPath, SKILL_FILE_NAME),
      linked: args.linked,
    });
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(args.currentPath, entry.name);
    const linkedDir =
      entry.isSymbolicLink() &&
      args.followSymlinks &&
      ((await fs.stat(entryPath).catch(() => null))?.isDirectory() ?? false);
    if (entry.isDirectory() || linkedDir) {
      await walkSkillTree({
        ...args,
        currentPath: entryPath,
        depth: args.depth + 1,
        linked: args.linked || linkedDir,
      });
    }
  }
}

async function scanRecursiveSkillRootFiles(
  root: CommandScanDirectoryRoot,
  budget: ScanBudget,
): Promise<SkillFileMatch[]> {
  const rootPath = await resolveRecursiveRootPath(root);
  if (rootPath === null) {
    return [];
  }
  const matchedFiles: SkillTreeFile[] = [];
  await walkSkillTree({
    budget,
    currentPath: rootPath,
    depth: 0,
    followSymlinks: canFollowSkillSymlink(root),
    linked: await isSymbolicLinkPath(root.rootPath),
    matchedFiles,
  });
  return mapWithConcurrency(
    matchedFiles,
    SCAN_CONCURRENCY,
    async (match) => ({
      filePath: path.join(
        root.rootPath,
        path.relative(rootPath, match.filePath),
      ),
      frontmatter: await parseFrontmatter(match.filePath),
      linked: match.linked,
      name: path.basename(path.dirname(match.filePath)),
    }),
  );
}

async function scanSingleSkillDirectoryFiles(
  root: CommandScanDirectoryRoot,
): Promise<SkillFileMatch[]> {
  const skillFilePath = path.join(root.rootPath, SKILL_FILE_NAME);
  const skillFile = await statSkillFile(skillFilePath, root);
  if (skillFile === null) {
    return [];
  }
  return [
    {
      filePath: skillFilePath,
      frontmatter: await parseFrontmatter(skillFilePath, skillFile),
      linked: (await isSymbolicLinkPath(root.rootPath)) || skillFile.linked,
      name: path.basename(root.rootPath),
    },
  ];
}

async function scanSkillFileRootFiles(
  root: CommandScanSkillFileRoot,
): Promise<SkillFileMatch[]> {
  const skillFile = await statSkillFile(root.filePath, root);
  if (skillFile === null) {
    return [];
  }
  const frontmatter = await parseFrontmatter(root.filePath, skillFile);
  return [
    {
      filePath: root.filePath,
      frontmatter,
      linked: skillFile.linked,
      name: frontmatter.name ?? root.fallbackName,
    },
  ];
}

async function scanSkillFiles(args: ScanRootArgs): Promise<SkillFileMatch[]> {
  const { root } = args;
  switch (root.shape) {
    case "skill":
      return scanSkillRootFiles(root);
    case "skill-recursive":
      return scanRecursiveSkillRootFiles(root, args.budget);
    case "skill-directory":
      return scanSingleSkillDirectoryFiles(root);
    case "skill-file":
      return scanSkillFileRootFiles(root);
    case "command":
    case "command-file":
      return [];
  }
}

function commandNameFromPath(rootPath: string, filePath: string): string {
  const relativePath = path.relative(rootPath, filePath);
  const withoutExtension = relativePath.slice(
    0,
    relativePath.length - MARKDOWN_FILE_EXTENSION.length,
  );
  return withoutExtension.split(path.sep).join(":");
}

async function scanCommandRoot(
  args: ScanRootArgs,
): Promise<HostProviderCommand[]> {
  const { root } = args;
  if (root.shape !== "command") {
    throw new Error("scanCommandRoot requires a command root");
  }
  const matchedFiles: string[] = [];
  await walkMarkdownTree({
    budget: args.budget,
    currentPath: root.rootPath,
    depth: 0,
    matchedFiles,
    matches: (entry) => entry.name.endsWith(MARKDOWN_FILE_EXTENSION),
  });

  return mapWithConcurrency(
    matchedFiles,
    SCAN_CONCURRENCY,
    async (filePath) => {
      const name = commandNameFromPath(root.rootPath, filePath);
      return buildRecord(root, filePath, name);
    },
  );
}

async function scanCommandFileRoot(
  args: ScanRootArgs,
): Promise<HostProviderCommand[]> {
  if (args.root.shape !== "command-file") {
    throw new Error("scanCommandFileRoot requires a command-file root");
  }
  try {
    const stat = await fs.lstat(args.root.filePath);
    if (!stat.isFile()) {
      return [];
    }
  } catch {
    return [];
  }
  const name = path.basename(args.root.filePath, MARKDOWN_FILE_EXTENSION);
  return [await buildRecord(args.root, args.root.filePath, name)];
}

async function scanRoot(args: ScanRootArgs): Promise<HostProviderCommand[]> {
  switch (args.root.shape) {
    case "skill":
    case "skill-recursive":
    case "skill-directory":
    case "skill-file":
      return (await scanSkillFiles(args)).map((match) =>
        buildRecordFromFrontmatter(args.root, match.name, match.frontmatter),
      );
    case "command":
      return scanCommandRoot(args);
    case "command-file":
      return scanCommandFileRoot(args);
  }
}

export async function discoverProviderCommands(
  args: DiscoverProviderCommandsArgs,
): Promise<HostProviderCommand[]> {
  const records: HostProviderCommand[] = [];
  const budget = newScanBudget();
  for (const root of args.roots) {
    records.push(...(await scanRoot({ budget, root })));
  }
  return records;
}

export type SkillScanRoot = CommandScanRoot & {
  identitySeed: string;
  rootKind: SkillRootKind;
};

interface DiscoverSkillsArgs {
  roots: readonly SkillScanRoot[];
}

async function buildSkillRecord(
  root: SkillScanRoot,
  match: SkillFileMatch,
): Promise<DiscoveredSkill> {
  const rootPath =
    "rootPath" in root ? root.rootPath : path.dirname(root.filePath);
  const logicalPath = path
    .relative(rootPath, match.filePath)
    .split(path.sep)
    .join("/");
  return {
    id: `skill_${createHash("sha256")
      .update(`${root.identitySeed}\0${logicalPath}`)
      .digest("hex")}`,
    name: `${root.namePrefix}${match.name}`,
    description: match.frontmatter.description,
    filePath: match.filePath,
    rootKind: root.rootKind,
    linked: match.linked,
    // File commands reject a symlinked root, so reads use the real folder.
    realDirectoryPath: match.linked
      ? await fs.realpath(path.dirname(match.filePath)).catch(() => undefined)
      : undefined,
  };
}

export async function discoverSkills(
  args: DiscoverSkillsArgs,
): Promise<DiscoveredSkill[]> {
  const records: DiscoveredSkill[] = [];
  const budget = newScanBudget();
  for (const root of args.roots) {
    const matches = await scanSkillFiles({ budget, root });
    const built = await mapWithConcurrency(
      matches,
      SCAN_CONCURRENCY,
      (match) => buildSkillRecord(root, match),
    );
    records.push(...built);
  }
  const canonicalPaths = await mapWithConcurrency(
    records,
    SCAN_CONCURRENCY,
    (record) => fs.realpath(record.filePath).catch(() => record.filePath),
  );
  const uniqueRecords: DiscoveredSkill[] = [];
  const seenFiles = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const canonicalFilePath = canonicalPaths[index]!;
    if (!seenFiles.has(canonicalFilePath)) {
      seenFiles.add(canonicalFilePath);
      uniqueRecords.push(records[index]!);
    }
  }
  return uniqueRecords;
}
