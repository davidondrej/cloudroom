import { useDeferredValue, useState } from "react";
import { StartBranchPicker } from "@cloudroom/shared-ui/branch-picker-primitives";
import { useGithubBranches } from "@/hooks/queries/cloudroom-queries";
import { useProjectSourceBranches } from "@/hooks/queries/project-queries";

interface CloudBranchPickerProps {
  projectId: string;
  /** The Mac whose checkout lists the GitHub branches. */
  hostId: string | null;
  /** The project has no folder on that Mac (ADR 0181), so GitHub lists the branches instead. */
  fromGithub: boolean;
  /** null starts from the repository's default branch. */
  value: string | null;
  onChange: (branch: string | null) => void;
  disabled?: boolean;
}

/** Cloud threads clone from GitHub, so only branches on GitHub can be picked (docs/scopes/sandboxes.md). */
export function CloudBranchPicker({
  projectId,
  hostId,
  fromGithub,
  value,
  onChange,
  disabled = false,
}: CloudBranchPickerProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const branches = useProjectSourceBranches(projectId, hostId, {
    query: deferredQuery,
    selectedBranch: "",
    enabled: !fromGithub,
  });
  const github = useGithubBranches(projectId, fromGithub);
  const defaultBranch = fromGithub
    ? (github.data?.defaultBranch ?? null)
    : (branches.data?.originDefaultBranch?.replace(/^origin\//, "") ??
      branches.data?.defaultBranch ??
      null);
  const githubBranches = fromGithub
    ? (github.data?.branches ?? []).filter((branch) =>
        branch.toLowerCase().includes(deferredQuery),
      )
    : (branches.data?.remoteBranches ?? [])
        .filter((branch) => branch.startsWith("origin/"))
        .map((branch) => branch.slice("origin/".length))
        .filter((branch) => branch !== "HEAD");
  const selected = value ?? defaultBranch;
  const unreadable =
    fromGithub && !github.isFetching && !github.data?.branches.length;

  return (
    <StartBranchPicker
      prefix="Branch from:"
      label={selected ?? "Default branch"}
      sections={[{ label: "On GitHub", icon: "Globe", branches: githubBranches }]}
      selected={selected}
      badges={defaultBranch ? { [defaultBranch]: "default" } : undefined}
      note={
        unreadable
          ? "Couldn't read this repo's branches from GitHub. The default branch still works."
          : "Not on GitHub? Push it first, or use Teleport."
      }
      isLoading={fromGithub ? github.isFetching : branches.isFetching}
      disabled={disabled}
      onSelect={(branch) => onChange(branch === defaultBranch ? null : branch)}
      onOpen={() => {
        if (!fromGithub) void branches.refreshFromRemote().catch(() => undefined);
        else if (github.isStale && !github.isFetching) void github.refetch();
      }}
      onQueryChange={setQuery}
    />
  );
}
