import { useCallback, useMemo } from "react";
import { atom, useAtomValue } from "jotai";
import { useAtomCallback } from "jotai/utils";
import { atomFamily } from "jotai-family";
import { useQueryClient } from "@tanstack/react-query";
import type { FileContents } from "@pierre/diffs";
import type {
  WorkspaceCommitSummary,
  WorkspaceDiffTarget,
} from "@cloudroom/domain";
import type {
  DiffFileEntry,
  EnvironmentDiffFileResponse,
} from "@cloudroom/server-contract";
import type { EnvironmentDiffFileArgs } from "@cloudroom/sdk/browser";
import type { JsonValue } from "@get-bb/plugin-sdk";
import type { AppFixedTabDestination } from "@/lib/app-fixed-tab-navigation";
import type { AppFixedTabReference } from "@/lib/app-navigation-host";
import { environmentDiffFileQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import type { GitDiffStats } from "./patch-utils";

// --- Shared Types ---

export type DiffFileContentsResult =
  | { file: FileContents; kind: "text" }
  | { dataUrl: string; kind: "image"; sizeBytes: number };

export type RequestDiffFileContents = (
  path: string,
  side: "old" | "new",
) => Promise<DiffFileContentsResult | null>;

export type GitDiffDisplayMode = "unified" | "split";
export type GitDiffDisplayModeChangeHandler = (
  mode: GitDiffDisplayMode,
) => void;
export type GitDiffSelectionValue = string | null;
export type GitDiffTabStatus = "loading" | "eligible" | "ineligible" | "error";

export interface GitDiffSelectionOption {
  label: string;
  monoPrefix?: string;
  value: string;
}

// --- Selection & Identity Helpers ---

export const GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD = 10;
export const ALL_GIT_DIFF_SELECTION = "all";
export const COMMITTED_GIT_DIFF_SELECTION = "branch_committed";
export const UNCOMMITTED_GIT_DIFF_SELECTION = "uncommitted";

export function buildGitDiffIdentity(args: {
  environmentId?: string;
  mergeBaseRef: string | null;
  target: WorkspaceDiffTarget | undefined;
}): string {
  const env = args.environmentId ?? "none";
  const t = args.target;
  if (!t) return `${env}:none`;
  if (t.type === "uncommitted") return `${env}:uncommitted`;
  if (t.type === "commit") return `${env}:commit:${t.sha}`;
  return `${env}:${t.type}:${t.mergeBaseBranch}:${args.mergeBaseRef ?? "pending"}`;
}

export function buildGitDiffTarget(
  selection: GitDiffSelectionValue,
  mergeBaseBranch: string | undefined,
): WorkspaceDiffTarget | undefined {
  if (selection === UNCOMMITTED_GIT_DIFF_SELECTION)
    return { type: "uncommitted" };
  if (selection === COMMITTED_GIT_DIFF_SELECTION) {
    return mergeBaseBranch
      ? { type: "branch_committed", mergeBaseBranch }
      : undefined;
  }
  if (selection) return { type: "commit", sha: selection };
  return mergeBaseBranch ? { type: "all", mergeBaseBranch } : undefined;
}

export function buildGitDiffSelectionOptions(
  commits: readonly WorkspaceCommitSummary[],
  opts: { hasUncommittedChanges: boolean } = { hasUncommittedChanges: false },
): GitDiffSelectionOption[] {
  const all: GitDiffSelectionOption = {
    value: ALL_GIT_DIFF_SELECTION,
    label: "All changes",
  };
  if (commits.length === 0 && !opts.hasUncommittedChanges) return [all];
  return [
    all,
    ...(commits.length > 0
      ? [{ value: COMMITTED_GIT_DIFF_SELECTION, label: "Committed changes" }]
      : []),
    ...(opts.hasUncommittedChanges
      ? [
          {
            value: UNCOMMITTED_GIT_DIFF_SELECTION,
            label: "Uncommitted changes",
          },
        ]
      : []),
    ...commits.map((c) => ({
      value: c.sha,
      label: c.subject,
      monoPrefix: c.shortSha,
    })),
  ];
}

export function shouldResetSelectedGitDiffSelection(
  selection: GitDiffSelectionValue,
  commits: readonly WorkspaceCommitSummary[],
  opts: { hasUncommittedChanges: boolean } = { hasUncommittedChanges: false },
): boolean {
  if (!selection) return false;
  if (selection === COMMITTED_GIT_DIFF_SELECTION) return commits.length === 0;
  if (selection === UNCOMMITTED_GIT_DIFF_SELECTION)
    return !opts.hasUncommittedChanges;
  return !commits.some((c) => c.sha === selection);
}

export function summarizeDiffFileEntries(
  files: readonly DiffFileEntry[],
): GitDiffStats {
  let insertions = 0;
  let deletions = 0;
  for (const f of files) {
    insertions += f.additions;
    deletions += f.deletions;
  }
  return { filesCount: files.length, insertions, deletions };
}

// --- Card Collapse & Height Store ---

interface CardUiState {
  collapsed: boolean;
}

interface CardKey {
  diffIdentity: string;
  path: string;
}

export function resolveDiffFileCardInitialState(args: {
  entry: DiffFileEntry;
  fileCount: number;
}): CardUiState {
  return {
    collapsed:
      args.fileCount > GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD ||
      args.entry.changeKind === "deleted",
  };
}

export const diffFileCardStateAtomFamily = atomFamily(
  (_key: CardKey) => atom<CardUiState | null>(null),
  (a, b) => a.diffIdentity === b.diffIdentity && a.path === b.path,
);

export function resolveCardCollapsed(
  stored: CardUiState | null,
  entry: DiffFileEntry,
  fileCount: number,
): boolean {
  return (
    stored?.collapsed ??
    resolveDiffFileCardInitialState({ entry, fileCount }).collapsed
  );
}

export function useDiffFilesCollapseControls(
  diffIdentity: string,
  files: readonly DiffFileEntry[],
) {
  const allCollapsedAtom = useMemo(
    () =>
      atom(
        (get) =>
          files.length > 0 &&
          files.every((entry) =>
            resolveCardCollapsed(
              get(
                diffFileCardStateAtomFamily({ diffIdentity, path: entry.path }),
              ),
              entry,
              files.length,
            ),
          ),
      ),
    [diffIdentity, files],
  );
  const areAllCollapsed = useAtomValue(allCollapsedAtom);
  const setAll = useAtomCallback(
    useCallback(
      (get, set, collapsed: boolean) => {
        for (const entry of files) {
          const a = diffFileCardStateAtomFamily({
            diffIdentity,
            path: entry.path,
          });
          const cur = get(a);
          if (cur?.collapsed !== collapsed)
            set(a, { ...(cur ?? {}), collapsed });
        }
      },
      [diffIdentity, files],
    ),
  );
  const toggleAllCollapsed = useCallback(
    () => setAll(!areAllCollapsed),
    [areAllCollapsed, setAll],
  );
  return { areAllCollapsed, toggleAllCollapsed, hasFiles: files.length > 0 };
}

export function clearDiffFileCardStates(activeDiffIdentity: string): void {
  for (const key of diffFileCardStateAtomFamily.getParams()) {
    if (key.diffIdentity !== activeDiffIdentity)
      diffFileCardStateAtomFamily.remove(key);
  }
}

export const DIFF_CARD_HEADER_HEIGHT_PX = 40;

export function estimateCardHeight(args: {
  collapsed: boolean;
  entry: DiffFileEntry;
}): number {
  const changed = args.entry.additions + args.entry.deletions;
  if (args.collapsed || changed === 0) return DIFF_CARD_HEADER_HEIGHT_PX;
  return DIFF_CARD_HEADER_HEIGHT_PX + 16 + Math.min(changed, 80) * 18;
}

// --- Diff File Contents Requester ---

const IMAGE_MIMES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

function toContentsResult(
  path: string,
  res: EnvironmentDiffFileResponse,
): DiffFileContentsResult | null {
  if (res.contentEncoding === "utf8")
    return { kind: "text", file: { name: path, contents: res.content } };
  if (res.mimeType && IMAGE_MIMES.has(res.mimeType)) {
    return {
      kind: "image",
      dataUrl: `data:${res.mimeType};base64,${res.content}`,
      sizeBytes: res.sizeBytes,
    };
  }
  return null;
}

export function useDiffFileContentsRequester(args: {
  environmentId?: string;
  mergeBaseRef: string | null;
  target?: WorkspaceDiffTarget;
}): RequestDiffFileContents | undefined {
  const queryClient = useQueryClient();
  const { environmentId, target, mergeBaseRef } = args;
  return useMemo<RequestDiffFileContents | undefined>(() => {
    if (!environmentId || !target) return undefined;
    if (
      (target.type === "branch_committed" || target.type === "all") &&
      !mergeBaseRef
    )
      return undefined;
    const targetKey =
      target.type === "uncommitted"
        ? null
        : target.type === "commit"
          ? target.sha
          : mergeBaseRef!;
    return async (path, side) => {
      const res = await queryClient.fetchQuery({
        queryKey: environmentDiffFileQueryKey(
          environmentId,
          target.type,
          targetKey,
          path,
          side,
        ),
        queryFn: ({ signal }) => {
          const req: EnvironmentDiffFileArgs =
            target.type === "uncommitted"
              ? { environmentId, path, side, signal, target: "uncommitted" }
              : target.type === "commit"
                ? {
                    environmentId,
                    path,
                    side,
                    signal,
                    target: "commit",
                    sha: target.sha,
                  }
                : {
                    environmentId,
                    path,
                    side,
                    signal,
                    target: target.type,
                    mergeBaseRef: mergeBaseRef!,
                  };
          return sdk.environments.diffFile(req);
        },
        staleTime: 5_000,
      });
      return toContentsResult(path, res);
    };
  }, [environmentId, mergeBaseRef, queryClient, target]);
}

// --- Tab Eligibility & Navigation ---

export function resolveGitDiffTabStatus(args: {
  environmentId: string | null;
  environmentIsGitRepo: boolean | undefined;
  environmentLoadFailed: boolean;
  environmentOwnsPath: boolean | undefined;
  hasResolvedThread: boolean;
  threadArchived: boolean;
}): GitDiffTabStatus {
  if (!args.hasResolvedThread) return "loading";
  if (args.environmentId === null) return "ineligible";
  if (args.threadArchived && args.environmentOwnsPath === false)
    return "ineligible";
  if (args.environmentIsGitRepo === true) return "eligible";
  if (args.environmentIsGitRepo === false) return "ineligible";
  return args.environmentLoadFailed ? "error" : "loading";
}

export const GIT_DIFF_FIXED_TAB_REFERENCE: AppFixedTabReference = {
  ownerId: "core:git-diff",
  tabId: "changes",
};

export function createGitDiffFixedTabDestination(args: {
  eligible: boolean;
  openCommit: (sha: string) => void;
  openFile: (path: string) => void;
  openOrdinary: () => void;
}): AppFixedTabDestination {
  return {
    tab: GIT_DIFF_FIXED_TAB_REFERENCE,
    open(target?: JsonValue) {
      if (!args.eligible) return false;
      if (target === undefined) {
        args.openOrdinary();
        return true;
      }
      if (
        typeof target !== "object" ||
        target === null ||
        Array.isArray(target)
      )
        return false;
      const keys = Object.keys(target);
      if (keys.length !== 2) return false;
      if (
        target.kind === "file" &&
        typeof target.path === "string" &&
        target.path.length > 0
      ) {
        args.openFile(target.path);
        return true;
      }
      if (
        target.kind === "commit" &&
        typeof target.sha === "string" &&
        target.sha.length > 0
      ) {
        args.openCommit(target.sha);
        return true;
      }
      return false;
    },
  };
}
