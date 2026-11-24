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

// A picked Local sticks to its project for 24 hours, then its new threads start in Cloud again. A project with no
// pick starts in Cloud. The app-wide value only serves composers outside the new-thread screen.
// The old cloudroom.executionTarget key saved picks and went stale.
const LAST_STARTED_KEY = "cloudroom.lastStartedMachine";
const LOCAL_STICKS_MS = 24 * 60 * 60_000;
const projectKey = (projectId: string) => `${LAST_STARTED_KEY}:${projectId}`;

// A value saved before the 24-hour rule has no time, so it never sticks. Either side of now, so a clock that
// jumped back can't keep Local for more than 48 hours.
function localSticks(projectId: string | null | undefined): boolean {
  const saved = projectId ? localStorage.getItem(projectKey(projectId)) : null;
  const pickedAt = saved?.startsWith("local:") ? Number(saved.slice(6)) : NaN;
  return Math.abs(Date.now() - pickedAt) < LOCAL_STICKS_MS;
}

export function saveStartedMachine(target: "local" | "cloud", projectId?: string | null) {
  localStorage.setItem(LAST_STARTED_KEY, target);
  // The 24 hours are a fixed window: another Local pick inside them keeps the first pick's time.
  if (!projectId || (target === "local" && localSticks(projectId))) return;
  localStorage.setItem(projectKey(projectId), target === "local" ? `local:${Date.now()}` : target);
}

export function saveNewThreadMachine(
  projectId: string | null,
  seeded: boolean,
  chosen: "local" | "cloud",
  started: "local" | "cloud",
  pickedLocal: boolean,
) {
  // Only a pick starts Local's 24 hours: a thread that starts on the remembered Local doesn't extend them.
  if (!seeded && chosen === started && (started === "cloud" || pickedLocal)) {
    saveStartedMachine(started, projectId);
  }
}

export function startingExecutionTarget(
  newThread: boolean,
  projectId?: string | null,
): "local" | "cloud" {
  if (!newThread) {
    const project = projectId ? localStorage.getItem(projectKey(projectId)) : null;
    return (project ?? localStorage.getItem(LAST_STARTED_KEY)) === "cloud" ? "cloud" : "local";
  }
  return getDefaultStore().get(startingMachineAtom) === "last" && localSticks(projectId) ? "local" : "cloud";
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
