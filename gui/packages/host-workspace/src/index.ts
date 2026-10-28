export { provisionWorkspace } from "./provision.js";
export type { HostWorkspace, ProvisionWorkspaceArgs } from "./provision.js";

export type { PullRequestActionOptions } from "./workspace.js";
export { formatShortstat, resolveWorkspaceFileStatusKind, resolveWorkspaceState } from "./workspace.js";
export { withGitRefMutationLock } from "bb-environment-provider-host/process-local-lock";

export {
  WorkspaceError,
  detectGitRepo,
  detectLinkedWorktree,
  detectGitRepoKind,
  fetchRemoteBranches,
  getCheckoutRef,
  getWorkspaceGitOperation,
  readWorkspaceGitState,
  getGitCommonDir,
  hasUncommittedChanges,
  listBranchRefsWithDefaults,
  parseNameStatusSourceEntries,
  parseNumstatEntriesZ,
  parsePorcelainEntries,
  readDefaultBranchRefs,
  readGitBlob,
  runGit,
} from "./git.js";
export type { GitProcessOptions } from "./git.js";
