import * as React from "react";
import { Slot } from "./slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_[data-icon-root]]:pointer-events-none [&_[data-icon-root]]:size-4 [&_[data-icon-root]]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "border border-input bg-transparent shadow-sm hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-9 px-2 min-w-9",
        sm: "h-8 px-1.5 min-w-8",
        lg: "h-10 px-2.5 min-w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

// Same behavior as Radix Toggle 1.1: a button with aria-pressed and
// data-state "on" or "off" that flips on click unless disabled.
type ToggleProps = React.ComponentPropsWithoutRef<"button"> & {
  asChild?: boolean;
  pressed?: boolean;
  defaultPressed?: boolean;
  onPressedChange?(pressed: boolean): void;
};

// Like Radix: a controlled change reports at once, an uncontrolled one after render.
function usePressedState(
  prop: boolean | undefined,
  defaultProp: boolean | undefined,
  onChange: ((pressed: boolean) => void) | undefined,
) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultProp ?? false);
  const onChangeRef = React.useRef(onChange);
  React.useInsertionEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const reportedRef = React.useRef(uncontrolled);
  React.useEffect(() => {
    if (reportedRef.current === uncontrolled) return;
    onChangeRef.current?.(uncontrolled);
    reportedRef.current = uncontrolled;
  }, [uncontrolled]);
  const setPressed = (next: boolean) => {
    if (prop === undefined) setUncontrolled(next);
    else if (next !== prop) onChangeRef.current?.(next);
  };
  return [prop !== undefined ? prop : uncontrolled, setPressed] as const;
}

const Toggle = React.forwardRef<
  HTMLButtonElement,
  ToggleProps & VariantProps<typeof toggleVariants>
>(
  (
    {
      className,
      variant,
      size,
      asChild,
      pressed: pressedProp,
      defaultPressed,
      onPressedChange,
      ...props
    },
    ref,
  ) => {
    const [pressed, setPressed] = usePressedState(
      pressedProp,
      defaultPressed,
      onPressedChange,
    );
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        type="button"
        aria-pressed={pressed}
        data-state={pressed ? "on" : "off"}
        data-disabled={props.disabled ? "" : undefined}
        className={cn(toggleVariants({ variant, size, className }))}
        {...props}
        ref={ref}
        onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
          props.onClick?.(event);
          // As in Radix, a child that calls onClick() with no event still toggles.
          if (!event?.defaultPrevented && !props.disabled) setPressed(!pressed);
        }}
      />
    );
  },
);

Toggle.displayName = "Toggle";

export { Toggle, toggleVariants };
