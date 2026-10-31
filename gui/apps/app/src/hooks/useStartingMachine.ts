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

// Where the last new thread started, per project, with the app-wide value as the fallback for a project's first thread.
// The old cloudroom.executionTarget key saved picks and went stale.
const LAST_STARTED_KEY = "cloudroom.lastStartedMachine";

export function saveStartedMachine(target: "local" | "cloud", projectId?: string | null) {
  localStorage.setItem(LAST_STARTED_KEY, target);
  if (projectId) localStorage.setItem(`${LAST_STARTED_KEY}:${projectId}`, target);
}

export function saveNewThreadMachine(
  projectId: string | null,
  seeded: boolean,
  chosen: "local" | "cloud",
  started: "local" | "cloud",
) {
  if (!seeded && chosen === started) saveStartedMachine(started, projectId);
}

export function startingExecutionTarget(
  newThread: boolean,
  projectId?: string | null,
): "local" | "cloud" {
  const lastUsed =
    (projectId ? localStorage.getItem(`${LAST_STARTED_KEY}:${projectId}`) : null) ??
    localStorage.getItem(LAST_STARTED_KEY);
  const startInCloud =
    newThread &&
    (getDefaultStore().get(startingMachineAtom) !== "last" || lastUsed === null);
  return startInCloud || lastUsed === "cloud" ? "cloud" : "local";
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
