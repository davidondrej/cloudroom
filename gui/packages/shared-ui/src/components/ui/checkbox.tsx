import * as React from "react";
import { Slot } from "./slot";

import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";
import { Icon } from "../../components/ui/icon.js";

// Same behavior as Radix Checkbox 1.3: a role="checkbox" button, followed by a
// hidden native checkbox while inside a form, so submit, reset, and change
// listeners see it like a real input.
type CheckedState = boolean | "indeterminate";
type CheckboxProps = Omit<
  React.ComponentPropsWithoutRef<"button"> & { asChild?: boolean },
  "checked" | "defaultChecked"
> & {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  required?: boolean;
  onCheckedChange?(checked: CheckedState): void;
};

const isIndeterminate = (checked?: CheckedState) => checked === "indeterminate";
const getState = (checked: CheckedState) =>
  isIndeterminate(checked) ? "indeterminate" : checked ? "checked" : "unchecked";

// Like Radix: a controlled change reports at once, an uncontrolled one after render.
function useCheckedState(
  prop: CheckedState | undefined,
  defaultProp: CheckedState | undefined,
  onChange: ((checked: CheckedState) => void) | undefined,
) {
  const [uncontrolled, setUncontrolled] = React.useState<CheckedState>(
    defaultProp ?? false,
  );
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
  const setChecked = React.useCallback(
    (next: React.SetStateAction<CheckedState>) => {
      if (prop === undefined) return setUncontrolled(next);
      const value = typeof next === "function" ? next(prop) : next;
      if (value !== prop) onChangeRef.current?.(value);
    },
    [prop],
  );
  return [prop !== undefined ? prop : uncontrolled, setChecked] as const;
}

const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  (
    {
      className,
      asChild,
      checked: checkedProp,
      defaultChecked,
      required,
      disabled,
      value = "on",
      onCheckedChange,
      name,
      form,
      onKeyDown,
      onClick,
      ...props
    },
    forwardedRef,
  ) => {
    const [checked, setChecked] = useCheckedState(
      checkedProp,
      defaultChecked,
      onCheckedChange,
    );
    const [control, setControl] = React.useState<HTMLButtonElement | null>(null);
    const [input, setInput] = React.useState<HTMLInputElement | null>(null);
    const stoppedPropagationRef = React.useRef(false);
    // Until the button mounts, assume a form, as Radix does for no-JS forms.
    const isFormControl = control ? !!form || !!control.closest("form") : true;
    // Radix's composeRefs, including React 19 ref cleanups.
    const ref = React.useCallback(
      (node: HTMLButtonElement | null) => {
        let cleanup: unknown;
        if (typeof forwardedRef === "function") cleanup = forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
        setControl(node);
        if (typeof cleanup !== "function") return;
        return () => {
          cleanup();
          setControl(null);
        };
      },
      [forwardedRef],
    );

    const initialCheckedRef = React.useRef(checked);
    React.useEffect(() => {
      const owner = control?.form;
      if (!owner) return;
      const reset = () => setChecked(initialCheckedRef.current);
      owner.addEventListener("reset", reset);
      return () => owner.removeEventListener("reset", reset);
    }, [control, setChecked]);

    const Comp = asChild ? Slot : "button";
    return (
      <>
        <Comp
          type="button"
          role="checkbox"
          aria-checked={isIndeterminate(checked) ? "mixed" : checked}
          aria-required={required}
          data-state={getState(checked)}
          data-disabled={disabled ? "" : undefined}
          disabled={disabled}
          value={value}
          className={cn(
            `peer group size-4 shrink-0 rounded-sm border border-input shadow-xs ${CONTROL_HOVER_TRANSITION} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-ring data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-ring data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground`,
            className,
          )}
          {...props}
          ref={ref}
          onKeyDown={(event: React.KeyboardEvent<HTMLButtonElement>) => {
            onKeyDown?.(event);
            // Checkboxes toggle on Space only (WAI-ARIA).
            if (!event.defaultPrevented && event.key === "Enter") {
              event.preventDefault();
            }
          }}
          onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
            onClick?.(event);
            if (event.defaultPrevented) return;
            setChecked((prev) => (isIndeterminate(prev) ? true : !prev));
            if (input && isFormControl) {
              // The hidden input's click carries the event to the form instead.
              stoppedPropagationRef.current = event.isPropagationStopped();
              if (!stoppedPropagationRef.current) event.stopPropagation();
            }
          }}
        >
          {(checked === true || isIndeterminate(checked)) && (
            <span
              data-state={getState(checked)}
              data-disabled={disabled ? "" : undefined}
              className="flex items-center justify-center text-current"
              style={{ pointerEvents: "none" }}
            >
              <Icon name="Check" className="size-3.5 group-data-[state=indeterminate]:hidden" />
              <span className="hidden h-0.5 w-2 rounded-full bg-current group-data-[state=indeterminate]:block" />
            </span>
          )}
        </Comp>
        {isFormControl && (
          <BubbleInput
            control={control}
            input={input}
            setInput={setInput}
            stoppedPropagationRef={stoppedPropagationRef}
            checked={checked}
            defaultChecked={
              isIndeterminate(defaultChecked) ? false : defaultChecked
            }
            required={required}
            disabled={disabled}
            name={name}
            value={value}
            form={form}
          />
        )}
      </>
    );
  },
);
Checkbox.displayName = "Checkbox";

function BubbleInput({
  control,
  input,
  setInput,
  stoppedPropagationRef,
  checked,
  defaultChecked,
  ...props
}: Pick<
  React.ComponentPropsWithoutRef<"input">,
  "required" | "disabled" | "name" | "value" | "form"
> & {
  control: HTMLButtonElement | null;
  input: HTMLInputElement | null;
  setInput: (input: HTMLInputElement | null) => void;
  stoppedPropagationRef: React.RefObject<boolean>;
  checked: CheckedState;
  defaultChecked: boolean | undefined;
}) {
  // Match the button's size, so native validation bubbles point at it.
  const [size, setSize] = React.useState<{ width: number; height: number }>();
  React.useLayoutEffect(() => {
    if (!control) return setSize(undefined);
    setSize({ width: control.offsetWidth, height: control.offsetHeight });
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const box = Array.isArray(entry.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry.borderBoxSize;
      setSize(
        box
          ? { width: box.inlineSize, height: box.blockSize }
          : { width: control.offsetWidth, height: control.offsetHeight },
      );
    });
    observer.observe(control, { box: "border-box" });
    return () => observer.unobserve(control);
  }, [control]);

  // Each change after mount clicks the input, which forms and their listeners see.
  const lastCheckedRef = React.useRef(checked);
  React.useEffect(() => {
    const changed = lastCheckedRef.current !== checked;
    lastCheckedRef.current = checked;
    const setNativeChecked = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "checked",
    )?.set;
    if (!input || !changed || !setNativeChecked) return;
    const event = new Event("click", { bubbles: !stoppedPropagationRef.current });
    input.indeterminate = isIndeterminate(checked);
    setNativeChecked.call(input, isIndeterminate(checked) ? false : checked);
    input.dispatchEvent(event);
  }, [input, checked, stoppedPropagationRef]);

  const [mountChecked] = React.useState(isIndeterminate(checked) ? false : checked);
  return (
    <input
      type="checkbox"
      aria-hidden
      defaultChecked={defaultChecked ?? mountChecked}
      {...props}
      tabIndex={-1}
      ref={setInput}
      style={{
        ...size,
        position: "absolute",
        pointerEvents: "none",
        opacity: 0,
        margin: 0,
        // Rendered after the button; this pulls it back on top of it.
        transform: "translateX(-100%)",
      }}
    />
  );
}

export { Checkbox };
