import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "../../lib/utils";

type ProgressProps = React.ComponentPropsWithoutRef<"div"> & {
  value?: number | null;
  max?: number;
  getValueLabel?: (value: number, max: number) => string;
  asChild?: boolean;
};

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  (
    { className, value, max: maxProp, getValueLabel: _getValueLabel, asChild, ...props },
    ref,
  ) => {
    const max =
      typeof maxProp === "number" && !Number.isNaN(maxProp) && maxProp > 0
        ? maxProp
        : 100;
    // The existing wrapper uses value only for the transform, not root semantics.
    const data = { "data-state": "indeterminate", "data-max": max };
    const Root = asChild ? Slot : "div";

    return (
      <Root
        ref={ref}
        aria-valuemax={max}
        aria-valuemin={0}
        aria-valuenow={undefined}
        aria-valuetext={undefined}
        role="progressbar"
        {...data}
        className={cn(
          "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
          className,
        )}
        {...props}
      >
        <div
          {...data}
          className="h-full w-full flex-1 bg-primary transition-transform"
          style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
        />
      </Root>
    );
  },
);
Progress.displayName = "Progress";

export { Progress };
