import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "../../lib/utils";

type SeparatorProps = React.ComponentPropsWithoutRef<"div"> & {
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
  asChild?: boolean;
};

const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  (
    {
      className,
      orientation = "horizontal",
      decorative = true,
      asChild,
      ...props
    },
    ref,
  ) => {
    const Root = asChild ? Slot : "div";
    // Like Radix: an unknown orientation falls back to horizontal.
    const direction = orientation === "vertical" ? "vertical" : "horizontal";
    return (
      <Root
        ref={ref}
        data-orientation={direction}
        role={decorative ? "none" : "separator"}
        aria-orientation={
          !decorative && direction === "vertical" ? "vertical" : undefined
        }
        className={cn(
          "shrink-0 bg-border",
          orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
          className,
        )}
        {...props}
      />
    );
  },
);
Separator.displayName = "Separator";

export { Separator };
