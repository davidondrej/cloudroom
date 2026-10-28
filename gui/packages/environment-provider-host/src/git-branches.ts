import type {
  DefaultBranchRefs,
  DefaultBranchRelation,
  GitProcessOptions,
  runGit,
} from "./git.js";

interface GitTimeoutOptions extends GitProcessOptions {
  timeoutMs?: number;
}

interface GitBranchDependencies {
  runGit: typeof runGit;
  ensureGitRepo: (cwd: string, options?: GitTimeoutOptions) => Promise<void>;
}

function trimOutput(value: string): string {
  return value.trim().replace(/\n+$/u, "");
}

export function resolvePreferredLocalDefaultBranch(
  localBranches: readonly string[],
  originDefaultBranchName: string | undefined,
): string | undefined {
  if (
    originDefaultBranchName &&
    localBranches.includes(originDefaultBranchName)
  ) {
    return originDefaultBranchName;
  }
  if (localBranches.includes("main")) {
    return "main";
  }
  if (localBranches.includes("master")) {
    return "master";
  }
  return localBranches[0];
}

export function createGitBranchQueries({
  runGit,
  ensureGitRepo,
}: GitBranchDependencies) {
  async function readLocalBranches(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<string[]> {
    const branches = await runGit(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      { cwd, ...options },
    );
    return branches.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async function readDefaultBranch(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<string | undefined> {
    await ensureGitRepo(cwd, options);
    const originHeadBranch = await readOriginHeadBranchName(cwd, options);
    if (originHeadBranch !== undefined) {
      return originHeadBranch;
    }
    return resolvePreferredLocalDefaultBranch(
      await readLocalBranches(cwd, options),
      undefined,
    );
  }

  async function hasRef(
    cwd: string,
    ref: string,
    options: GitTimeoutOptions = {},
  ): Promise<boolean> {
    await ensureGitRepo(cwd, options);
    const result = await runGit(["show-ref", "--verify", "--quiet", ref], {
      cwd,
      ...options,
      allowFailure: true,
    });
    return result.exitCode === 0;
  }

  async function readOriginHeadBranchName(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<string | undefined> {
    const originHead = await runGit(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      { cwd, ...options, allowFailure: true },
    );
    const remoteHead = trimOutput(originHead.stdout);
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
    return undefined;
  }

  async function readOriginDefaultBranch(
    cwd: string,
    localDefaultBranch: string | undefined,
    options: GitTimeoutOptions = {},
  ): Promise<string | undefined> {
    const originHeadBranch = await readOriginHeadBranchName(cwd, options);
    if (
      originHeadBranch &&
      (await hasRef(cwd, `refs/remotes/origin/${originHeadBranch}`, options))
    ) {
      return `origin/${originHeadBranch}`;
    }

    if (
      localDefaultBranch &&
      (await hasRef(cwd, `refs/remotes/origin/${localDefaultBranch}`, options))
    ) {
      return `origin/${localDefaultBranch}`;
    }

    return undefined;
  }

  async function revParseRef(
    cwd: string,
    ref: string,
    options: GitTimeoutOptions = {},
  ): Promise<string | undefined> {
    const result = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd,
      ...options,
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    return trimOutput(result.stdout) || undefined;
  }

  async function isAncestorRef(
    cwd: string,
    ancestorRef: string,
    descendantRef: string,
    options: GitTimeoutOptions = {},
  ): Promise<boolean | undefined> {
    const result = await runGit(
      ["merge-base", "--is-ancestor", ancestorRef, descendantRef],
      { cwd, ...options, allowFailure: true },
    );
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    return undefined;
  }

  async function readDefaultBranchRelation(
    cwd: string,
    localDefaultBranch: string | undefined,
    originDefaultBranch: string | undefined,
    options: GitTimeoutOptions = {},
  ): Promise<DefaultBranchRelation | undefined> {
    if (!localDefaultBranch || !originDefaultBranch) {
      return undefined;
    }

    const localRef = `refs/heads/${localDefaultBranch}`;
    const originRef = `refs/remotes/${originDefaultBranch}`;
    const [localSha, originSha] = await Promise.all([
      revParseRef(cwd, localRef, options),
      revParseRef(cwd, originRef, options),
    ]);
    if (!localSha || !originSha) {
      return "unknown";
    }
    if (localSha === originSha) {
      return "equal";
    }

    const localIsAncestor = await isAncestorRef(
      cwd,
      localRef,
      originRef,
      options,
    );
    if (localIsAncestor === true) {
      return "local-behind";
    }
    if (localIsAncestor === undefined) {
      return "unknown";
    }

    const originIsAncestor = await isAncestorRef(
      cwd,
      originRef,
      localRef,
      options,
    );
    if (originIsAncestor === true) {
      return "local-ahead";
    }
    if (originIsAncestor === undefined) {
      return "unknown";
    }

    return "diverged";
  }

  async function readDefaultBranchRefs(
    cwd: string,
    options: GitTimeoutOptions = {},
  ): Promise<DefaultBranchRefs> {
    await ensureGitRepo(cwd, options);
    const originHeadBranch = await readOriginHeadBranchName(cwd, options);
    const localBranches = await readLocalBranches(cwd, options);
    const defaultBranch = resolvePreferredLocalDefaultBranch(
      localBranches,
      originHeadBranch,
    );
    const originDefaultBranch = await readOriginDefaultBranch(
      cwd,
      defaultBranch,
      options,
    );
    const defaultBranchRelation = await readDefaultBranchRelation(
      cwd,
      defaultBranch,
      originDefaultBranch,
      options,
    );

    return {
      defaultBranch,
      defaultBranchRelation,
      originDefaultBranch,
    };
  }

  return {
    readDefaultBranch,
    readDefaultBranchRefs,
    readLocalBranches,
    readOriginHeadBranchName,
    hasRef,
  };
}
