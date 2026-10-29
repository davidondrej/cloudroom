import { COMPUTER } from "@cloudroom/domain/computer-name";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { StartBranchPicker } from "@cloudroom/shared-ui/branch-picker-primitives";
import {
  definePluginApp,
  experimental_useBranches,
  experimental_useCheckoutState,
  type CheckoutState,
  type JsonValue,
  type PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import type { CheckoutBranchSelection } from "./contract.js";
import { PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID } from "./provider-id.js";

interface CheckoutInputsValue {
  path: string | null;
  branch: CheckoutBranchSelection | null;
}

interface CheckoutBlocker {
  label: string;
  reason: string;
}

function readBranch(
  branch: JsonValue | undefined,
): CheckoutBranchSelection | null {
  if (typeof branch !== "object" || branch === null || Array.isArray(branch)) {
    return null;
  }
  if (branch.kind === "existing" && typeof branch.name === "string") {
    return { kind: "existing", name: branch.name };
  }
  if (branch.kind === "new" && typeof branch.baseBranch === "string") {
    return { kind: "new", baseBranch: branch.baseBranch };
  }
  return null;
}

export function readCheckoutInputs(
  value: JsonValue | null,
): CheckoutInputsValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { path: null, branch: null };
  }
  return {
    path: typeof value.path === "string" ? value.path : null,
    branch: readBranch(value.branch),
  };
}

export function buildCheckoutInputs(inputs: CheckoutInputsValue): JsonValue {
  return {
    ...(inputs.path === null ? {} : { path: inputs.path }),
    ...(inputs.branch === null ? {} : { branch: inputs.branch }),
  };
}

function operationName(state: CheckoutState): string {
  switch (state.operation.kind) {
    case "merge":
      return "Merge";
    case "rebase":
      return "Rebase";
    case "cherry-pick":
      return "Cherry-pick";
    case "revert":
      return "Revert";
    case "unknown":
      return "Operation";
    case "none":
      return "";
  }
}

export function checkoutBlocker(state: CheckoutState): CheckoutBlocker | null {
  if (state.isGit === null) {
    return { label: "Checking", reason: "Checking checkout state" };
  }
  if (!state.isGit) {
    return { label: "Unknown", reason: "Checkout state is unavailable" };
  }
  if (state.operation.kind !== "none") {
    if (state.operation.hasConflicts) {
      return {
        label: "Conflicts",
        reason: "Checkout blocked by unresolved conflicts",
      };
    }
    const name = operationName(state);
    return {
      label: name,
      reason: `Checkout blocked by an in-progress ${name.toLowerCase()}`,
    };
  }
  if (state.dirty) {
    return {
      label: "Dirty",
      reason: "Checkout blocked by uncommitted changes",
    };
  }
  if (state.detached) {
    return {
      label: "Detached",
      reason: "Checkout blocked while HEAD is detached",
    };
  }
  if (state.unborn) {
    return {
      label: "Empty repo",
      reason: "Checkout blocked before the first commit",
    };
  }
  return null;
}

function currentMenuLabel(state: CheckoutState): string {
  if (state.currentBranch !== null) return `Current: ${state.currentBranch}`;
  if (state.detached) return "Current (detached)";
  if (state.unborn) return "Current (empty repo)";
  if (state.isGit === null) return "Checking checkout";
  return "Unknown checkout";
}

function CheckoutInputsControl({
  projectId,
  target,
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  const hostId = target.kind === "existing-host" ? target.hostId : null;
  const inputs = useMemo(() => readCheckoutInputs(value), [value]);
  const checkout = experimental_useCheckoutState({ hostId, projectId });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const branchState = experimental_useBranches({
    hostId,
    projectId,
    query: deferredQuery.trim().toLowerCase(),
  });
  const blocker = hostId === null ? null : checkoutBlocker(checkout);
  const nextInputs = useMemo(
    () => buildCheckoutInputs(inputs),
    [inputs.branch, inputs.path],
  );
  const blockerReason = blocker?.reason ?? null;

  useEffect(() => {
    if (inputs.branch !== null && blockerReason !== null) {
      onChange({ status: "blocked", reason: blockerReason });
      return;
    }
    onChange({ status: "ready", value: nextInputs });
  }, [blockerReason, inputs.branch, nextInputs, onChange]);

  const current = hostId === null ? null : checkout.currentBranch;
  const picked =
    inputs.branch?.kind === "existing"
      ? inputs.branch.name
      : (inputs.branch?.baseBranch ?? null);
  const selected = picked ?? current;
  const localBranches = hostId === null ? [] : branchState.branches;
  const githubBranches = branchState.remoteBranches
    .filter((branch) => branch.startsWith("origin/"))
    .map((branch) => branch.slice("origin/".length))
    .filter((branch) => branch !== "HEAD" && !localBranches.includes(branch));
  const label =
    selected ?? (hostId === null ? "Default branch" : currentMenuLabel(checkout));

  return (
    <StartBranchPicker
      label={label}
      title={blockerReason ?? label}
      sections={[
        ...(hostId === null
          ? []
          : [
              {
                label: `On this ${COMPUTER}`,
                icon: "GitMerge" as const,
                branches: localBranches,
              },
            ]),
        { label: "On GitHub", icon: "Globe" as const, branches: githubBranches },
      ]}
      selected={selected}
      badges={current === null ? undefined : { [current]: "current" }}
      blockedReason={blockerReason}
      availableWhenBlocked={current}
      isLoading={branchState.isLoading}
      disabled={projectId === null}
      onSelect={(branch) =>
        onChange({
          status: "ready",
          value: buildCheckoutInputs({
            path: inputs.path,
            branch:
              branch === current ? null : { kind: "existing", name: branch },
          }),
        })
      }
      onOpen={() => void branchState.refresh().catch(() => undefined)}
      onQueryChange={setQuery}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
    component: CheckoutInputsControl,
  });
});
