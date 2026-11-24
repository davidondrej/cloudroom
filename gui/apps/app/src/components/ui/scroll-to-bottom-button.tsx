import { cn } from "@cloudroom/shared-ui/lib/utils";

interface ScrollToBottomButtonProps {
  visible: boolean;
  active?: boolean;
  onClick: () => void;
}

// A soft disc with a chevron. On hover a primary-color disc blooms behind the
// chevron, and the chevron drops and gently bobs.
export function ScrollToBottomButton({
  visible,
  active = false,
  onClick,
}: ScrollToBottomButtonProps) {
  return (
    <div className="flex h-0 items-center justify-center">
      <button
        onClick={onClick}
        className={cn(
          "group relative isolate z-20 -mt-20 flex size-9 cursor-pointer items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--foreground)_8%,var(--background))] text-foreground transition-[translate,opacity,visibility,scale,color] duration-200 hover:text-primary-foreground active:scale-90",
          "before:absolute before:inset-0 before:-z-10 before:scale-0 before:rounded-full before:bg-primary before:transition-[scale] before:duration-400 before:ease-[cubic-bezier(.34,1.56,.64,1)] hover:before:scale-100",
          visible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none invisible translate-y-2 opacity-0",
        )}
        aria-label="Scroll to latest event"
        type="button"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={cn(
            "size-5 overflow-visible",
            active && visible && "animate-shine-icon",
          )}
        >
          <g className="transition-[translate] duration-450 ease-[cubic-bezier(.34,1.8,.64,1)] group-hover:translate-y-0.5 group-hover:animate-[scroll-bottom-bob_1.1s_ease-in-out_0.45s_infinite] motion-reduce:group-hover:animate-none">
            <path d="M5.5 9l6.5 6.5L18.5 9" />
          </g>
        </svg>
      </button>
    </div>
  );
}
