const RECHECK_MS = 2_000;
const MARK = "data-unfocused-paused";

export function installUnfocusedAnimationPause(): void {
  if (
    typeof window === "undefined" ||
    typeof document.getAnimations !== "function"
  )
    return;
  const marked = new Set<Element>();
  let recheck: number | undefined;
  const markEndless = () => {
    for (const animation of document.getAnimations()) {
      const { effect } = animation;
      if (
        animation.playState !== "running" ||
        !(effect instanceof KeyframeEffect) ||
        !effect.target ||
        effect.getTiming().iterations !== Infinity
      )
        continue;
      effect.target.setAttribute(MARK, "");
      marked.add(effect.target);
    }
  };
  const pause = () => {
    if (document.hasFocus() || recheck !== undefined) return;
    markEndless();
    recheck = window.setInterval(markEndless, RECHECK_MS);
  };
  window.addEventListener("blur", () => window.setTimeout(pause));
  window.addEventListener("focus", () => {
    window.clearInterval(recheck);
    recheck = undefined;
    for (const element of marked) element.removeAttribute(MARK);
    marked.clear();
  });
  pause();
}
