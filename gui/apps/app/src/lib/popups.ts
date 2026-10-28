import { useEffect } from "react";
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { getLocalStorage } from "@/lib/browser-storage";

const ORDER = ["credits", "star", "install"] as const;
export type Popup = (typeof ORDER)[number];
type Detail = "starred" | "opened" | "already" | "migrated";
type State = { closed: Popup[]; shownAt: number | null; credits: boolean };
type Unsaved = { popup: Popup; detail?: Detail };
const PATH = "/api/v1/cloudroom/popups";
const KEY = ["cloudroom-popups"];
const DAY = 86_400_000;
const UNSAVED_KEY = "cloudroom.popups.unsaved";
const LEGACY_KEYS: Partial<Record<Popup, string>> = { credits: "cloudroom.creditsExplainerSeen", install: "cloudroom.installApp.dismissed" };
const statusAtom = atom<Partial<Record<Popup, boolean | null>>>({});
const openAtom = atom<Popup | "claiming" | null>(null);

const send = async (body: { popup: Popup; event: "shown" | "closed"; detail?: Detail }) => {
  const response = await fetchWithAppSurface(PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("The pop-up could not be saved.");
  return (await response.json() as { ok?: boolean }).ok === true;
};

const readUnsaved = (): Unsaved[] => {
  try {
    const list = JSON.parse(getLocalStorage()?.getItem(UNSAVED_KEY) ?? "[]") as Unsaved[];
    return Array.isArray(list) ? list.filter((item) => ORDER.includes(item?.popup)) : [];
  } catch { return []; }
};
const writeUnsaved = (list: Unsaved[]) => {
  const storage = getLocalStorage();
  if (list.length) storage?.setItem(UNSAVED_KEY, JSON.stringify(list));
  else storage?.removeItem(UNSAVED_KEY);
};
const closedBefore = (popup: Popup) => {
  const key = LEGACY_KEYS[popup];
  const value = key ? getLocalStorage()?.getItem(key) : null;
  return value === "1" || value === "true";
};

async function saveClosed(item: Unsaved) {
  writeUnsaved([...readUnsaved().filter((other) => other.popup !== item.popup), item]);
  const saved = await send({ popup: item.popup, event: "closed", ...(item.detail ? { detail: item.detail } : {}) }).then(() => true, () => false);
  if (saved) writeUnsaved(readUnsaved().filter((other) => other.popup !== item.popup));
}

function usePopupState() {
  return useQuery<State | null>({
    queryKey: KEY, retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetchWithAppSurface(PATH, { signal });
      const state = response.ok ? await response.json() as State | null : null;
      if (!state) return null;
      const legacy = ORDER.filter(closedBefore).map((popup): Unsaved => ({ popup, detail: "migrated" }));
      const unsaved = [...readUnsaved(), ...legacy].filter((item) => !state.closed.includes(item.popup));
      for (const item of unsaved) void saveClosed(item);
      return { ...state, closed: [...new Set([...state.closed, ...unsaved.map((item) => item.popup)])] };
    },
  });
}

export const useCreditsCohort = () => {
  const { data } = usePopupState();
  return data === undefined ? undefined : data?.credits === true;
};

export function usePopup(id: Popup, eligible: boolean | null) {
  const state = usePopupState().data;
  const client = useQueryClient();
  const setStatus = useSetAtom(statusAtom);
  const statuses = useAtomValue(statusAtom);
  const [open, setOpen] = useAtom(openAtom);
  useEffect(() => { setStatus((current) => ({ ...current, [id]: eligible })); }, [eligible, id, setStatus]);
  useEffect(() => () => setStatus((current) => ({ ...current, [id]: false })), [id, setStatus]);
  const first = state ? ORDER.find((popup) => !state.closed.includes(popup) && statuses[popup] !== false) : undefined;
  const ready = first === id && statuses[id] === true;
  useEffect(() => {
    if (!ready || open !== null || !state || (state.shownAt !== null && Date.now() - state.shownAt < DAY)) return;
    setOpen("claiming");
    void send({ popup: id, event: "shown" }).catch(() => false).then((claimed) => {
      client.setQueryData<State | null>(KEY, (current) => current && { ...current, shownAt: Date.now() });
      setOpen(claimed ? id : null);
    });
  }, [client, id, open, ready, setOpen, state]);
  const close = (detail?: Detail) => {
    setOpen(null);
    client.setQueryData<State | null>(KEY, (current) => current && { ...current, closed: [...new Set([...current.closed, id])] });
    void saveClosed({ popup: id, ...(detail ? { detail } : {}) });
  };
  return { open: open === id, close };
}
