import { useDeferredValue, useState } from "react";
import { StartBranchPicker } from "@cloudroom/shared-ui/branch-picker-primitives";
import { useCloudProjectBranches } from "@/hooks/queries/cloudroom-queries";
import { useProjectSourceBranches } from "@/hooks/queries/project-queries";

interface CloudBranchPickerProps {
  gitlab?: boolean;
  projectId: string;
  /** The Mac whose checkout lists remote branches. */
  hostId: string | null;
  /** The project has no folder on that Mac (ADR 0181), so the repository host lists its branches instead. */
  fromRemote: boolean;
  /** null starts from the repository's default branch. */
  value: string | null;
  onChange: (branch: string | null) => void;
  disabled?: boolean;
}

/** Cloud threads start from a branch on the project’s remote (docs/scopes/sandboxes.md). */
export function CloudBranchPicker({
  gitlab = false,
  projectId,
  hostId,
  fromRemote,
  value,
  onChange,
  disabled = false,
}: CloudBranchPickerProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const branches = useProjectSourceBranches(projectId, hostId, {
    query: deferredQuery,
    selectedBranch: "",
    enabled: !fromRemote,
  });
  const remote = useCloudProjectBranches(projectId, fromRemote);
  const defaultBranch = fromRemote
    ? (remote.data?.defaultBranch ?? null)
    : (branches.data?.originDefaultBranch?.replace(/^origin\//, "") ??
      branches.data?.defaultBranch ??
      null);
  const remoteBranches = fromRemote
    ? (remote.data?.branches ?? []).filter((branch) =>
        branch.toLowerCase().includes(deferredQuery),
      )
    : (branches.data?.remoteBranches ?? [])
        .filter((branch) => branch.startsWith("origin/"))
        .map((branch) => branch.slice("origin/".length))
        .filter((branch) => branch !== "HEAD");
  const selected = value ?? defaultBranch;
  const unreadable =
    fromRemote && !remote.isFetching && !remote.data?.branches.length;

  return (
    <StartBranchPicker
      prefix="Branch from:"
      label={selected ?? "Default branch"}
      sections={[{ label: gitlab ? "On GitLab" : "On GitHub", icon: "Globe", branches: remoteBranches }]}
      selected={selected}
      badges={defaultBranch ? { [defaultBranch]: "default" } : undefined}
      note={
        unreadable
          ? (gitlab && remote.error?.message) || "Couldn’t read the remote branches. You can still use the default branch."
          : "Push a local branch to see it here."
      }
      isLoading={fromRemote ? remote.isFetching : branches.isFetching}
      disabled={disabled}
      onSelect={(branch) => onChange(branch === defaultBranch ? null : branch)}
      onOpen={() => {
        if (!fromRemote) void branches.refreshFromRemote().catch(() => undefined);
        else if (remote.isStale && !remote.isFetching) void remote.refetch();
      }}
      onQueryChange={setQuery}
    />
  );
}
