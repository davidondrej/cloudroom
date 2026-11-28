import type { LoggedWorkSessionDeps } from "../../types.js";
import { getPluginSkillRootContributions } from "../plugins/plugin-agent-contributions.js";
import { generatedSkillsRootPath } from "../plugins/plugin-commands-skill.js";
import { resolveSharedBuiltinSkillsRootPath } from "./builtin-skills-copy.js";
import {
  resolveSkillCatalogEntries,
  type ProjectInjectedSkillSource,
  type ResolvedSkillCatalogEntry,
  type SharedInjectedSkillSource,
} from "./injected-skills.js";

interface ResolveSkillCatalogSourcesArgs {
  pluginSkillSelections?: ReadonlyMap<string, ReadonlySet<string>>;
  projectSkillSources?: readonly ProjectInjectedSkillSource[];
  sharedSkillSources?: readonly SharedInjectedSkillSource[];
  includeTreeHash?: boolean;
}

let commandCatalogRevision = 0;

export function getCommandCatalogRevision(): number {
  return commandCatalogRevision;
}

export function invalidateCommandCatalog(): void {
  commandCatalogRevision += 1;
}

export function resolveSkillCatalog(
  deps: Pick<LoggedWorkSessionDeps, "config" | "logger" | "skillTreeRegistry">,
  args: ResolveSkillCatalogSourcesArgs = {},
): ResolvedSkillCatalogEntry[] {
  return resolveSkillCatalogEntries(deps.logger, {
    builtinSkillsRootPath: resolveSharedBuiltinSkillsRootPath(
      deps.config.builtinSkillsRootPath,
    ),
    additionalSkillsRootPaths: [
      ...deps.config.inheritedSkillsRootPaths,
      generatedSkillsRootPath(deps.config.dataDir),
    ],
    userSkillsRootPath: deps.config.userSkillsRootPath,
    pluginSkillRoots: getPluginSkillRootContributions(),
    ...(args.pluginSkillSelections !== undefined
      ? { pluginSkillSelections: args.pluginSkillSelections }
      : {}),
    ...(args.projectSkillSources !== undefined
      ? { projectSkillSources: args.projectSkillSources }
      : {}),
    ...(args.sharedSkillSources !== undefined
      ? { sharedSkillSources: args.sharedSkillSources }
      : {}),
    ...(args.includeTreeHash !== undefined
      ? { includeTreeHash: args.includeTreeHash }
      : {}),
    skillTreeRegistry: deps.skillTreeRegistry,
  });
}
