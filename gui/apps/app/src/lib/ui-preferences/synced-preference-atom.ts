import { atom, type SetStateAction, type WritableAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  getUiPreferenceDefault,
  parseUiPreferenceValue,
  type UiPreferenceKey,
  type UiPreferenceValue,
} from "@cloudroom/domain";
import { createLocalStorageSyncStorage } from "@/lib/browser-storage";
import {
  registerSyncedUiPreference,
  scheduleUiPreferenceWrite,
} from "./ui-preferences-sync";

export type SyncedPreferenceAtom<Key extends UiPreferenceKey> = WritableAtom<
  UiPreferenceValue<Key>,
  [SetStateAction<UiPreferenceValue<Key>>],
  void
>;

type ValueAtom<Key extends UiPreferenceKey> = WritableAtom<
  UiPreferenceValue<Key>,
  [UiPreferenceValue<Key>],
  void
>;

type StringPreferenceKey = {
  [Key in UiPreferenceKey]: UiPreferenceValue<Key> extends string ? Key : never;
}[UiPreferenceKey];

function locallyCachedAtom<Key extends UiPreferenceKey>(
  key: Key,
  cacheKey: string,
): ValueAtom<Key> {
  return atomWithStorage(
    cacheKey,
    getUiPreferenceDefault(key),
    createLocalStorageSyncStorage<UiPreferenceValue<Key>>({
      parse: (stored, initial) => {
        const parsed = parseUiPreferenceValue(key, stored);
        return parsed.success ? parsed.value : initial;
      },
      serialize: String,
    }),
    { getOnInit: true },
  );
}

export function createSyncedPreferenceAtom<Key extends UiPreferenceKey>(
  key: Key,
  cacheKey?: Key extends StringPreferenceKey ? string : never,
): SyncedPreferenceAtom<Key> {
  const valueAtom: ValueAtom<Key> =
    cacheKey === undefined
      ? atom(getUiPreferenceDefault(key))
      : locallyCachedAtom(key, cacheKey);
  registerSyncedUiPreference(key, {
    localCopy: cacheKey !== undefined,
    valueAtom,
  });
  return atom(
    (get) => get(valueAtom),
    (get, set, update: SetStateAction<UiPreferenceValue<Key>>) => {
      const previous = get(valueAtom);
      set(valueAtom, typeof update === "function" ? update(previous) : update);
      scheduleUiPreferenceWrite(key, update);
    },
  );
}
