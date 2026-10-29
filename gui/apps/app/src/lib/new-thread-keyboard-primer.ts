import { COMPACT_VIEWPORT_QUERY } from "@cloudroom/shared-ui/hooks/use-compact-viewport";
import { POINTER_COARSE_QUERY } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import { APP_ROOT_ROUTE_PATH } from "@/lib/route-paths";

export function installNewThreadKeyboardPrimer() {
  const isPhone = () =>
    window.matchMedia(POINTER_COARSE_QUERY).matches &&
    window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
  let pathBeforeTap = window.location.pathname;
  window.addEventListener(
    "click",
    () => {
      pathBeforeTap = window.location.pathname;
    },
    true,
  );
  window.addEventListener("click", () => {
    if (pathBeforeTap === APP_ROOT_ROUTE_PATH) return;
    if (window.location.pathname !== APP_ROOT_ROUTE_PATH) return;
    if (!isPhone()) return;
    primeSoftKeyboard();
  });
}

function primeSoftKeyboard() {
  const input = document.createElement("input");
  input.setAttribute("aria-hidden", "true");
  input.tabIndex = -1;
  input.style.cssText =
    "position:fixed;bottom:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none;";
  document.body.append(input);
  input.addEventListener("blur", () => input.remove(), { once: true });
  input.focus({ preventScroll: true });
  window.setTimeout(() => input.remove(), 2000);
}
