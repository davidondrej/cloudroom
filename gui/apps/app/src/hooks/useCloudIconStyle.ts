import { useCallback } from "react";
import { getDefaultStore, useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createLocalStorageEnumStorage } from "@/lib/browser-storage";

export type CloudIconStyle = "electric-lime" | "crisp-white";

const cloudIconStyleAtom = atomWithStorage<CloudIconStyle>(
  "cloudroom.cloudIconStyle",
  "electric-lime",
  createLocalStorageEnumStorage<CloudIconStyle>(
    (value): value is CloudIconStyle =>
      value === "electric-lime" || value === "crisp-white",
  ),
  { getOnInit: true },
);

function setCloudIconAttribute(style: CloudIconStyle): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.cloudIcon = style;
  }
}

function applyCloudIconStyle(): void {
  setCloudIconAttribute(getDefaultStore().get(cloudIconStyleAtom));
}

export function initializeCloudIconStyle(): void {
  applyCloudIconStyle();
  getDefaultStore().sub(cloudIconStyleAtom, applyCloudIconStyle);
}

export function useCloudIconStyle() {
  const [style, setStyle] = useAtom(cloudIconStyleAtom);
  const update = useCallback(
    (next: CloudIconStyle) => {
      setStyle(next);
      setCloudIconAttribute(next);
    },
    [setStyle],
  );
  return [style, update] as const;
}
