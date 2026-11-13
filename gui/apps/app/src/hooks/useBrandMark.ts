import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { booleanLocalStorage } from "@/lib/browser-storage";

// The Cloudroom logo and name in the top bar. On by default for everyone.
const brandMarkAtom = atomWithStorage(
  "cloudroom.brandMark",
  true,
  booleanLocalStorage,
  { getOnInit: true },
);

export function useBrandMark() {
  return useAtom(brandMarkAtom);
}
