import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@cloudroom/shared-ui/tooltip";
import type { ProviderPickerOption } from "./model-brand-prefix";

const FADE_PX = 28;

/** Fades a scroll area's edge only while more content is hidden past it. */
export function useEdgeFade(
  ref: RefObject<HTMLElement | null>,
  axis: "x" | "y",
) {
  const [fade, setFade] = useState({ start: false, end: false });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const at = axis === "x" ? el.scrollLeft : el.scrollTop;
    const size = axis === "x" ? el.clientWidth : el.clientHeight;
    const full = axis === "x" ? el.scrollWidth : el.scrollHeight;
    const start = at > 2;
    const end = at + size < full - 2;
    setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
  };
  useLayoutEffect(measure);
  const mask = `linear-gradient(to ${axis === "x" ? "right" : "bottom"}, transparent, #000 ${fade.start ? FADE_PX : 0}px, #000 calc(100% - ${fade.end ? FADE_PX : 0}px), transparent)`;
  return { measure, style: { maskImage: mask, WebkitMaskImage: mask } };
}

function revealHarness(
  button: HTMLButtonElement | null,
  inline: ScrollLogicalPosition,
) {
  button?.scrollIntoView({ block: "nearest", inline, behavior: "instant" });
}

/** Harness icons in one row that scrolls sideways; the open harness shows its name. */
export function ModelPickerHarnessStrip({
  options,
  activeId,
  activeButtonRef,
  onSelect,
  children,
}: {
  options: readonly ProviderPickerOption[];
  activeId: string;
  activeButtonRef: RefObject<HTMLButtonElement | null>;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const { measure, style } = useEdgeFade(viewportRef, "x");

  useLayoutEffect(() => {
    revealHarness(activeButtonRef.current, "center");
  }, [activeButtonRef, activeId, options.length]);

  return (
    <TooltipProvider delayDuration={250}>
      <div
        role="group"
        aria-label="Harnesses"
        className="flex shrink-0 items-center gap-1 p-1.5 pb-0.5"
      >
        <div
          ref={viewportRef}
          onScroll={measure}
          onWheel={(event) => {
            // A plain mouse wheel scrolls the row sideways too.
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
              event.currentTarget.scrollLeft += event.deltaY;
            }
          }}
          style={style}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {options.map(({ value, label, icon: Logo }) => {
            const active = value === activeId;
            return (
              <Tooltip key={value}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    ref={active ? activeButtonRef : undefined}
                    aria-label={label}
                    aria-pressed={active}
                    onFocus={(event) => revealHarness(event.currentTarget, "nearest")}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (!active) onSelect(value);
                    }}
                    className={cn(
                      "flex h-7 shrink-0 items-center rounded-lg px-1.5 text-xs outline-none pointer-coarse:h-10 pointer-coarse:px-2.5",
                      active
                        ? "bg-state-hover font-medium text-foreground"
                        : "text-subtle-foreground hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground",
                    )}
                  >
                    {Logo ? (
                      <Logo className="size-4 shrink-0 pointer-coarse:size-5" />
                    ) : (
                      <span className="w-4 text-center font-medium">
                        {label.charAt(0)}
                      </span>
                    )}
                    <span
                      className={cn(
                        "grid transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none",
                        active
                          ? "grid-cols-[1fr] opacity-100"
                          : "grid-cols-[0fr] opacity-0",
                      )}
                    >
                      <span className="overflow-hidden whitespace-nowrap">
                        <span className="pl-1.5 pr-1">{label}</span>
                      </span>
                    </span>
                  </button>
                </TooltipTrigger>
                {/* The open harness already shows its name. */}
                {active ? null : (
                  <TooltipContent side="top">{label}</TooltipContent>
                )}
              </Tooltip>
            );
          })}
        </div>
        {children}
      </div>
    </TooltipProvider>
  );
}
