/**
 * @license
 * Slot below is ported from @radix-ui/react-slot 1.3.0, with its ref
 * composing from @radix-ui/react-compose-refs 1.1.3
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
// Slot renders its one child element with Slot's own props merged in, as
// Radix Slot does: both handlers run (the child's first), styles merge,
// classNames join, and refs compose. It also unwraps a Radix `Slottable`
// child (any copy: they share a global symbol). The package ran uncompiled,
// so the React Compiler must not memoize this file either.
"use no memo";

import * as React from "react";

type AnyProps = Record<string, unknown>;
type Handler = (...args: unknown[]) => unknown;
type PossibleRef = React.Ref<unknown> | undefined;
type SlottableProps =
  | {
      child: React.ReactNode;
      children: (slottable: React.ReactNode) => React.ReactNode;
    }
  | { children: React.ReactNode };
type SlotProps = React.HTMLAttributes<HTMLElement> & {
  children?: React.ReactNode;
};
interface LazyNode {
  $$typeof: symbol;
  _payload: PromiseLike<React.ReactNode>;
}

const SLOTTABLE_IDENTIFIER = Symbol.for("radix.slottable");
const REACT_LAZY_TYPE = Symbol.for("react.lazy");

function setRef(ref: PossibleRef, value: unknown) {
  if (typeof ref === "function") return ref(value);
  if (ref !== null && ref !== undefined) ref.current = value;
}

// One ref callback for both refs, keeping React 19 ref cleanups: a ref's own
// cleanup runs, otherwise the ref is set back to null.
function useComposedRefs(first: PossibleRef, second: PossibleRef) {
  return React.useCallback(
    (node: unknown) => {
      const refs = [first, second];
      const cleanups = refs.map((ref) => setRef(ref, node));
      if (!cleanups.some((cleanup) => typeof cleanup === "function")) return;
      return () => {
        cleanups.forEach((cleanup, index) => {
          if (typeof cleanup === "function") cleanup();
          else setRef(refs[index], null);
        });
      };
    },
    [first, second],
  );
}

// Same as Radix's createSlot: `ownerName` names the component and its errors.
function createSlot(ownerName: string) {
  const Slot = React.forwardRef<HTMLElement, SlotProps>(
    (props, forwardedRef) => {
      let { children, ...slotProps } = props;
      let slottableElement = null as React.ReactElement<AnyProps> | null;
      let hasSlottable = false as boolean;
      const newChildren: React.ReactNode[] = [];

      if (isLazyNode(children)) children = React.use(children._payload);

      React.Children.forEach(children, (maybeSlottable) => {
        if (!isSlottable(maybeSlottable)) {
          newChildren.push(maybeSlottable);
          return;
        }
        hasSlottable = true;
        const slottable = maybeSlottable.props;
        let child = "child" in slottable ? slottable.child : slottable.children;
        if (isLazyNode(child)) child = React.use(child._payload);
        slottableElement = slottableTarget(slottable, child);
        newChildren.push(slottableElement?.props.children as React.ReactNode);
      });

      if (slottableElement) {
        slottableElement = React.cloneElement(
          slottableElement,
          undefined,
          newChildren,
        );
      } else if (
        // A Slottable that didn't hold one element is an error below, not a target.
        !hasSlottable &&
        React.Children.count(children) === 1 &&
        React.isValidElement<AnyProps>(children)
      ) {
        slottableElement = children;
      }

      const slottableElementRef = slottableElement
        ? getElementRef(slottableElement)
        : undefined;
      const composedRef = useComposedRefs(forwardedRef, slottableElementRef);

      if (!slottableElement) {
        // Empty children render nothing; anything else can't be slotted.
        if (children || children === 0) {
          throw new Error(
            hasSlottable
              ? `${ownerName} failed to slot onto its \`Slottable\`. Expected \`Slottable\` to receive a single React element child.`
              : `${ownerName} failed to slot onto its children. Expected a single React element child or \`Slottable\`.`,
          );
        }
        return children;
      }

      const mergedProps = mergeProps(slotProps, slottableElement.props ?? {});
      // React 19 rejects a ref on a Fragment.
      if (slottableElement.type !== React.Fragment) {
        mergedProps.ref = forwardedRef ? composedRef : slottableElementRef;
      }
      return React.cloneElement(slottableElement, mergedProps);
    },
  );
  Slot.displayName = `${ownerName}.Slot`;
  return Slot;
}

const Slot = createSlot("Slot");

function slottableTarget(
  slottable: SlottableProps,
  child: React.ReactNode,
): React.ReactElement<AnyProps> | null {
  if ("child" in slottable) {
    const target = slottable.child;
    if (!React.isValidElement<AnyProps>(target)) return null;
    return React.cloneElement(
      target,
      undefined,
      slottable.children(target.props.children as React.ReactNode),
    );
  }
  return React.isValidElement<AnyProps>(child) ? child : null;
}

// The child's props win, except that handlers on both run (child first),
// styles merge, and classNames join.
function mergeProps(slotProps: AnyProps, childProps: AnyProps) {
  const overrideProps = { ...childProps };
  for (const propName in childProps) {
    const slotPropValue = slotProps[propName];
    const childPropValue = childProps[propName];
    if (/^on[A-Z]/.test(propName)) {
      if (slotPropValue && childPropValue) {
        overrideProps[propName] = (...args: unknown[]) => {
          const result = (childPropValue as Handler)(...args);
          (slotPropValue as Handler)(...args);
          return result;
        };
      } else if (slotPropValue) {
        overrideProps[propName] = slotPropValue;
      }
    } else if (propName === "style") {
      overrideProps[propName] = {
        ...(slotPropValue as object),
        ...(childPropValue as object),
      };
    } else if (propName === "className") {
      overrideProps[propName] = [slotPropValue, childPropValue]
        .filter(Boolean)
        .join(" ");
    }
  }
  return { ...slotProps, ...overrideProps };
}

// React 19 warns in development when `element.ref` is read, so read the ref
// from props then.
function getElementRef(element: React.ReactElement<AnyProps>): PossibleRef {
  const getter = Object.getOwnPropertyDescriptor(element, "ref")?.get;
  const props = element.props as { ref?: PossibleRef };
  if (getter && "isReactWarning" in getter && getter.isReactWarning) {
    return props.ref;
  }
  return props.ref || (element as { ref?: PossibleRef }).ref;
}

function isSlottable(
  child: React.ReactNode,
): child is React.ReactElement<SlottableProps> {
  return (
    React.isValidElement(child) &&
    typeof child.type === "function" &&
    "__radixId" in child.type &&
    child.type.__radixId === SLOTTABLE_IDENTIFIER
  );
}

function isLazyNode(node: unknown): node is LazyNode {
  return (
    node != null &&
    typeof node === "object" &&
    "$$typeof" in node &&
    node.$$typeof === REACT_LAZY_TYPE &&
    "_payload" in node &&
    typeof node._payload === "object" &&
    node._payload !== null &&
    "then" in node._payload
  );
}

export { Slot, createSlot };
