import { useEffect } from "react";
import { atom, useAtomValue, useSetAtom, type PrimitiveAtom } from "jotai";

const browserDimmingModalCountAtom = atom(0);
const nativeBrowserViewCountAtom = atom(0);

function useCount(countAtom: PrimitiveAtom<number>, active: boolean): void {
  const setCount = useSetAtom(countAtom);
  useEffect(() => {
    if (!active) {
      return;
    }
    setCount((count) => count + 1);
    return () => setCount((count) => count - 1);
  }, [active, setCount]);
}

export function useBrowserDimmingOverlay(active: boolean): void {
  useCount(browserDimmingModalCountAtom, active);
}

export function useBrowserDimmingModal(active: boolean): void {
  useBrowserDimmingOverlay(active);
}

export function useIsBrowserDimmingModalOpen(): boolean {
  return useAtomValue(browserDimmingModalCountAtom) > 0;
}

export function useNativeBrowserViewShown(active: boolean): void {
  useCount(nativeBrowserViewCountAtom, active);
}

export function useIsNativeBrowserViewShown(): boolean {
  return useAtomValue(nativeBrowserViewCountAtom) > 0;
}
