import * as React from "react";
import { Slot } from "./slot";

// Same DOM and props as Radix AspectRatio: a full-width wrapper sized by the
// padding-bottom trick, and an absolutely filled inner box for the content.
const AspectRatio = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<"div"> & {
    ratio?: number;
    asChild?: boolean;
  }
>(({ ratio = 1, asChild = false, style, ...props }, ref) => {
  const Comp = asChild ? Slot : "div";

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        paddingBottom: `${100 / ratio}%`,
      }}
      data-radix-aspect-ratio-wrapper=""
    >
      <Comp
        {...props}
        ref={ref}
        style={{
          ...style,
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
        }}
      />
    </div>
  );
});
AspectRatio.displayName = "AspectRatio";

export { AspectRatio };
