export { provisionWorkspace } from "./provision.js";
export { coreGitTarget } from "./core-git.js";
export type { HostWorkspace, ProvisionWorkspaceArgs } from "./provision.js";

export type { PullRequestActionOptions } from "./provision.js";
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
  parsePorcelainEntries,
  readDefaultBranchRefs,
  readGitBlob,
  runGit,
} from "./git.js";
export type { GitProcessOptions } from "./git.js";
