import { getDefaultStore, useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createLocalStorageEnumStorage } from "@/lib/browser-storage";

export type Corners = "sharp" | "rounded";

const cornersAtom = atomWithStorage<Corners>(
  "bb.corners",
  "rounded",
  createLocalStorageEnumStorage<Corners>(
    (value): value is Corners => value === "sharp" || value === "rounded",
  ),
  { getOnInit: true },
);

function applyCorners(): void {
  document.documentElement.dataset.corners = getDefaultStore().get(cornersAtom);
}

export function initializeCorners(): void {
  applyCorners();
  getDefaultStore().sub(cornersAtom, applyCorners);
}

export function useCorners() {
  return useAtom(cornersAtom);
}
