import type { ReasoningLevel } from "@cloudroom/domain";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";

const ULTRA_EFFORTS: readonly ReasoningLevel[] = ["ultracode", "ultra"];

export const showUltraEffortsAtom = createSyncedPreferenceAtom(
  "defaults.showUltraEfforts",
);

export function withoutHiddenUltraEfforts<T extends { value: ReasoningLevel }>(
  options: readonly T[],
  current: string,
  show: boolean,
): readonly T[] {
  return show
    ? options
    : options.filter(
        (option) =>
          option.value === current || !ULTRA_EFFORTS.includes(option.value),
      );
}
