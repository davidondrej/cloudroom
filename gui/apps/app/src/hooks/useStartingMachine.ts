import { getDefaultStore, useAtom } from "jotai";
import { cloudCanRunHarness } from "@/hooks/queries/cloudroom-queries";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";

export type StartingMachine = "cloud" | "last";

const startingMachineAtom = createSyncedPreferenceAtom(
  "defaults.startingMachine",
  "cloudroom.startingMachine",
);

export function useStartingMachine() {
  return useAtom(startingMachineAtom);
}

export function startingExecutionTarget(newThread: boolean): "local" | "cloud" {
  const startInCloud =
    newThread && getDefaultStore().get(startingMachineAtom) !== "last";
  return startInCloud ||
    localStorage.getItem("cloudroom.executionTarget") === "cloud"
    ? "cloud"
    : "local";
}

export function agentExecutionTarget(
  target: "local" | "cloud",
  cloudPicked: boolean,
  providerId: string,
): "local" | "cloud" {
  return target === "cloud" && !cloudPicked && providerId !== "" &&
    !cloudCanRunHarness(providerId)
    ? "local"
    : target;
}
