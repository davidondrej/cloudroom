import { useState, type ReactNode } from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";

interface AnimatedBodyProps {
  id: string;
  labelledBy: string;
  isExpanded: boolean;
  collapsedBorder: "reserve" | "none";
  seamless?: boolean;
  children: ReactNode;
}

export function AnimatedBody({
  id,
  labelledBy,
  isExpanded,
  collapsedBorder,
  seamless = false,
  children,
}: AnimatedBodyProps) {
  const [hasRealizedBody, setHasRealizedBody] = useState(isExpanded);
  if (isExpanded && !hasRealizedBody) {
    setHasRealizedBody(true);
  }
  const isBodyRealized = hasRealizedBody || isExpanded;

  return (
    <section
      id={id}
      role="region"
      aria-labelledby={labelledBy}
      aria-hidden={!isExpanded}
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
        isExpanded
          ? cn(
              "grid-rows-[1fr] opacity-100",
              !seamless && "border-t border-border",
            )
          : cn(
              "pointer-events-none w-0 min-w-full grid-rows-[0fr] opacity-0",
              collapsedBorder === "reserve" && "border-t border-transparent",
            ),
      )}
    >
      <div className={cn("overflow-hidden", !seamless && "bg-popover")}>
        {isBodyRealized ? children : null}
      </div>
    </section>
  );
}
