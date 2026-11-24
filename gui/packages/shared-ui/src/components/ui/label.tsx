import * as React from "react";
import { Slot } from "./slot";

import { cn } from "../../lib/utils";

const Label = React.forwardRef<
  HTMLLabelElement,
  React.ComponentPropsWithoutRef<"label"> & { asChild?: boolean }
>(({ className, asChild, onMouseDown, ...props }, ref) => {
  const Component = asChild ? Slot : "label";
  return (
    <Component
      ref={ref}
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("button, input, select, textarea")) return;
        onMouseDown?.(event);
        if (!event.defaultPrevented && event.detail > 1) event.preventDefault();
      }}
    />
  );
});
Label.displayName = "Label";

export { Label };
