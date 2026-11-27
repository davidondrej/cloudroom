/**
 * @license
 * Collapsible below is ported from @radix-ui/react-collapsible 1.1.16, with
 * its Presence from @radix-ui/react-presence 1.1.7
 * (https://github.com/radix-ui/primitives).
 *
 * MIT License
 *
 * Copyright (c) 2022 WorkOS
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Same behavior as Radix Collapsible 1.1: the trigger toggles the open state;
// closed content stays in the DOM, hidden and empty, but keeps its children
// through a closing CSS animation, and --radix-collapsible-content-height/width
// hold the content's size for open/close animations. Radix ran uncompiled, so
// the React Compiler must not memoize this file either (render reads the
// measured size from refs).
// The three parts share this file's own context, not Radix's: use them
// together, never mixed with parts from @radix-ui/react-collapsible.
"use no memo";

import * as React from "react";
import { createSlot } from "./slot";

type DivProps = React.ComponentPropsWithoutRef<"div"> & { asChild?: boolean };
interface CollapsibleProps extends DivProps {
  defaultOpen?: boolean;
  open?: boolean;
  disabled?: boolean;
  onOpenChange?(open: boolean): void;
}
type CollapsibleTriggerProps = React.ComponentPropsWithoutRef<"button"> & {
  asChild?: boolean;
};
interface CollapsibleContentProps extends DivProps {
  /** Mounts the content's children while closed, for animation libraries. */
  forceMount?: true;
}
type PossibleRef<T> = React.Ref<T> | undefined;

// Radix's Primitive slots, so asChild errors name the same element.
const DivSlot = createSlot("Primitive.div");
const ButtonSlot = createSlot("Primitive.button");

const CollapsibleContext = React.createContext<
  | {
      contentId: string;
      disabled?: boolean;
      open: boolean;
      onOpenToggle(): void;
    }
  | undefined
>(undefined);
CollapsibleContext.displayName = "CollapsibleContext";

function useCollapsibleContext(consumerName: string) {
  const context = React.useContext(CollapsibleContext);
  if (!context) {
    throw new Error(`\`${consumerName}\` must be used within \`Collapsible\``);
  }
  return context;
}

const getState = (open: boolean) => (open ? "open" : "closed");

// Like Radix: a controlled change reports at once and only if it differs; an
// uncontrolled one after it renders.
function useOpenState(
  prop: boolean | undefined,
  defaultProp: boolean,
  onChange: ((open: boolean) => void) | undefined,
) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultProp);
  const reportedRef = React.useRef(uncontrolled);
  const onChangeRef = React.useRef(onChange);
  React.useInsertionEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  React.useEffect(() => {
    if (reportedRef.current === uncontrolled) return;
    onChangeRef.current?.(uncontrolled);
    reportedRef.current = uncontrolled;
  }, [uncontrolled]);
  const setOpen = React.useCallback(
    (next: (open: boolean) => boolean) => {
      if (prop === undefined) return setUncontrolled(next);
      const value = next(prop);
      if (value !== prop) onChangeRef.current?.(value);
    },
    [prop],
  );
  return [prop === undefined ? uncontrolled : prop, setOpen] as const;
}

const Collapsible = React.forwardRef<HTMLDivElement, CollapsibleProps>(
  (
    { open: openProp, defaultOpen, disabled, onOpenChange, asChild, ...props },
    ref,
  ) => {
    const [open, setOpen] = useOpenState(
      openProp,
      defaultOpen ?? false,
      onOpenChange,
    );
    const contentId = `radix-${React.useId()}`;
    const onOpenToggle = React.useCallback(
      () => setOpen((previous) => !previous),
      [setOpen],
    );
    const context = React.useMemo(
      () => ({ disabled, contentId, open, onOpenToggle }),
      [disabled, contentId, open, onOpenToggle],
    );
    const Comp = asChild ? DivSlot : "div";
    return (
      <CollapsibleContext.Provider value={context}>
        <Comp
          data-state={getState(open)}
          data-disabled={disabled ? "" : undefined}
          {...props}
          ref={ref}
        />
      </CollapsibleContext.Provider>
    );
  },
);
Collapsible.displayName = "Collapsible";

const CollapsibleTrigger = React.forwardRef<
  HTMLButtonElement,
  CollapsibleTriggerProps
>(({ asChild, ...props }, ref) => {
  const context = useCollapsibleContext("CollapsibleTrigger");
  const Comp = asChild ? ButtonSlot : "button";
  return (
    <Comp
      type="button"
      aria-controls={context.open ? context.contentId : undefined}
      aria-expanded={context.open || false}
      data-state={getState(context.open)}
      data-disabled={context.disabled ? "" : undefined}
      disabled={context.disabled}
      {...props}
      ref={ref}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        props.onClick?.(event);
        if (!event?.defaultPrevented) context.onOpenToggle();
      }}
    />
  );
});
CollapsibleTrigger.displayName = "CollapsibleTrigger";

const CollapsibleContent = React.forwardRef<
  HTMLDivElement,
  CollapsibleContentProps
>(({ forceMount, ...props }, forwardedRef) => {
  const context = useCollapsibleContext("CollapsibleContent");
  const presence = usePresence(forceMount || context.open);
  const ref = useStableComposedRefs(presence.ref, forwardedRef);
  return (
    <CollapsibleContentImpl {...props} ref={ref} present={presence.isPresent} />
  );
});
CollapsibleContent.displayName = "CollapsibleContent";

const CollapsibleContentImpl = React.forwardRef<
  HTMLDivElement,
  DivProps & { present: boolean }
>(({ present, children, asChild, ...props }, forwardedRef) => {
  const context = useCollapsibleContext("CollapsibleContent");
  const [isPresent, setIsPresent] = React.useState(present);
  const nodeRef = React.useRef<HTMLDivElement>(null);
  const ref = React.useCallback(
    (node: HTMLDivElement | null) => composeRefs(forwardedRef, nodeRef)(node),
    [forwardedRef],
  );
  const sizeRef = React.useRef({ height: 0, width: 0 });
  const { height, width } = sizeRef.current;
  // Opening shows the content at once, to measure it; closing waits for
  // `present` to drop, so the size is read before it closes.
  const isOpen = context.open || isPresent;
  const isMountAnimationPreventedRef = React.useRef(isOpen);
  const originalStylesRef = React.useRef<{
    transitionDuration: string;
    animationName: string;
  }>(undefined);

  React.useEffect(() => {
    const frame = requestAnimationFrame(
      () => (isMountAnimationPreventedRef.current = false),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  React.useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    originalStylesRef.current ??= {
      transitionDuration: node.style.transitionDuration,
      animationName: node.style.animationName,
    };
    // Measure at full size with animations off, then turn them back on,
    // except on the first mount, which never animates.
    node.style.transitionDuration = "0s";
    node.style.animationName = "none";
    const rect = node.getBoundingClientRect();
    sizeRef.current = { height: rect.height, width: rect.width };
    if (!isMountAnimationPreventedRef.current) {
      node.style.transitionDuration =
        originalStylesRef.current.transitionDuration;
      node.style.animationName = originalStylesRef.current.animationName;
    }
    setIsPresent(present);
  }, [context.open, present]);

  const Comp = asChild ? DivSlot : "div";
  return (
    <Comp
      data-state={getState(context.open)}
      data-disabled={context.disabled ? "" : undefined}
      id={context.contentId}
      hidden={!isOpen}
      {...props}
      ref={ref}
      style={
        {
          "--radix-collapsible-content-height": height
            ? `${height}px`
            : undefined,
          "--radix-collapsible-content-width": width ? `${width}px` : undefined,
          ...props.style,
        } as React.CSSProperties
      }
    >
      {isOpen && children}
    </Comp>
  );
});

// Radix Presence: content stays present while a closing CSS animation runs.
type PresenceState = "mounted" | "unmountSuspended" | "unmounted";
type PresenceEvent = "MOUNT" | "UNMOUNT" | "ANIMATION_OUT" | "ANIMATION_END";
const PRESENCE_MACHINE: Record<
  PresenceState,
  Partial<Record<PresenceEvent, PresenceState>>
> = {
  mounted: { UNMOUNT: "unmounted", ANIMATION_OUT: "unmountSuspended" },
  unmountSuspended: { MOUNT: "mounted", ANIMATION_END: "unmounted" },
  unmounted: { MOUNT: "mounted" },
};

function usePresence(present: boolean) {
  const [node, setNode] = React.useState<HTMLElement | null>();
  const stylesRef = React.useRef<CSSStyleDeclaration | null>(null);
  const prevPresentRef = React.useRef(present);
  const prevAnimationNameRef = React.useRef("none");
  const mountAnimationNameRef = React.useRef<string | undefined>(undefined);
  const [state, send] = React.useReducer(
    (current: PresenceState, event: PresenceEvent) =>
      PRESENCE_MACHINE[current][event] ?? current,
    present ? "mounted" : "unmounted",
  );

  React.useEffect(() => {
    if (state === "mounted") {
      prevAnimationNameRef.current =
        mountAnimationNameRef.current ?? getAnimationName(stylesRef.current);
      mountAnimationNameRef.current = undefined;
    } else {
      prevAnimationNameRef.current = "none";
    }
  }, [state]);

  React.useLayoutEffect(() => {
    const styles = stylesRef.current;
    const wasPresent = prevPresentRef.current;
    if (wasPresent === present) return;
    const prevAnimationName = prevAnimationNameRef.current;
    const currentAnimationName = getAnimationName(styles);
    if (present) {
      mountAnimationNameRef.current = currentAnimationName;
      send("MOUNT");
    } else if (currentAnimationName === "none" || styles?.display === "none") {
      send("UNMOUNT");
    } else {
      // A new animation name means a closing animation started.
      const isAnimating = prevAnimationName !== currentAnimationName;
      send(wasPresent && isAnimating ? "ANIMATION_OUT" : "UNMOUNT");
    }
    prevPresentRef.current = present;
  }, [present]);

  React.useLayoutEffect(() => {
    if (!node) {
      send("ANIMATION_END");
      return;
    }
    let timeoutId: number | undefined;
    const ownerWindow = node.ownerDocument.defaultView ?? window;
    const handleAnimationEnd = (event: AnimationEvent) => {
      const isCurrentAnimation = getAnimationName(stylesRef.current).includes(
        CSS.escape(event.animationName),
      );
      if (event.target !== node || !isCurrentAnimation) return;
      send("ANIMATION_END");
      if (prevPresentRef.current) return;
      // Hold the closing animation's last frame until React removes the
      // children, so they don't flash back.
      const currentFillMode = node.style.animationFillMode;
      node.style.animationFillMode = "forwards";
      timeoutId = ownerWindow.setTimeout(() => {
        if (node.style.animationFillMode === "forwards") {
          node.style.animationFillMode = currentFillMode;
        }
      });
    };
    const handleAnimationStart = (event: AnimationEvent) => {
      if (event.target === node) {
        prevAnimationNameRef.current = getAnimationName(stylesRef.current);
      }
    };
    node.addEventListener("animationstart", handleAnimationStart);
    node.addEventListener("animationcancel", handleAnimationEnd);
    node.addEventListener("animationend", handleAnimationEnd);
    return () => {
      ownerWindow.clearTimeout(timeoutId);
      node.removeEventListener("animationstart", handleAnimationStart);
      node.removeEventListener("animationcancel", handleAnimationEnd);
      node.removeEventListener("animationend", handleAnimationEnd);
    };
  }, [node]);

  return {
    isPresent: state === "mounted" || state === "unmountSuspended",
    ref: React.useCallback((element: HTMLElement | null) => {
      if (element) {
        const styles = getComputedStyle(element);
        stylesRef.current = styles;
        mountAnimationNameRef.current = getAnimationName(styles);
      } else {
        stylesRef.current = null;
      }
      setNode(element);
    }, []),
  };
}

function getAnimationName(styles: CSSStyleDeclaration | null) {
  return styles?.animationName || "none";
}

function setRef<T>(ref: PossibleRef<T>, value: T | null) {
  if (typeof ref === "function") return ref(value);
  if (ref !== null && ref !== undefined) ref.current = value;
}

// Radix's composeRefs, including React 19 ref cleanups: a ref's own cleanup
// runs, otherwise the ref is set back to null.
function composeRefs<T>(...refs: PossibleRef<T>[]) {
  return (node: T | null) => {
    const cleanups = refs.map((ref) => setRef(ref, node));
    if (!cleanups.some((cleanup) => typeof cleanup === "function")) return;
    return () => {
      cleanups.forEach((cleanup, index) => {
        if (typeof cleanup === "function") cleanup();
        else setRef(refs[index], null);
      });
    };
  };
}

// One ref callback for the whole life of the content, reading the latest refs.
function useStableComposedRefs<T>(...refs: PossibleRef<T>[]) {
  const refsRef = React.useRef(refs);
  refsRef.current = refs;
  return React.useCallback(
    (node: T | null) => composeRefs(...refsRef.current)(node),
    [],
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
