/**
 * @license
 * The icons below come from Lucide (https://lucide.dev).
 *
 * ISC License
 *
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * All icons below except grip-vertical are derived from Feather, licensed
 * under the MIT License below.
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2013-present Cole Bemis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import * as React from "react";

// The Lucide icons our shadcn components use, with the same SVG markup,
// classes, aria-hidden rule, ref, and props as lucide-react 1.23.0.

export type LucideProps = Omit<React.SVGProps<SVGSVGElement>, "ref"> & {
  size?: string | number;
  absoluteStrokeWidth?: boolean;
};

type IconNode = [tag: "path" | "circle", attrs: Record<string, string>][];

function mergeClasses(...classes: (string | undefined)[]) {
  return classes
    .filter(
      (name, index, all) =>
        !!name && name.trim() !== "" && all.indexOf(name) === index,
    )
    .join(" ")
    .trim();
}

function hasA11yProp(props: object) {
  return Object.keys(props).some(
    (prop) => prop.startsWith("aria-") || prop === "role" || prop === "title",
  );
}

function createIcon(name: string, iconNode: IconNode) {
  const Icon = React.forwardRef<SVGSVGElement, LucideProps>(
    (
      {
        color,
        size,
        strokeWidth,
        absoluteStrokeWidth,
        className,
        children,
        ...rest
      },
      ref,
    ) => (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size ?? 24}
        height={size ?? 24}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color ?? "currentColor"}
        strokeWidth={
          absoluteStrokeWidth
            ? (Number(strokeWidth ?? 2) * 24) / Number(size ?? 24)
            : (strokeWidth ?? 2)
        }
        strokeLinecap="round"
        strokeLinejoin="round"
        className={mergeClasses(
          "lucide",
          mergeClasses(`lucide-${name}`, className),
        )}
        {...(children || hasA11yProp(rest)
          ? {}
          : { "aria-hidden": "true" as const })}
        {...rest}
      >
        {iconNode.map(([Tag, attrs], index) => (
          <Tag key={index} {...attrs} />
        ))}
        {children}
      </svg>
    ),
  );
  Icon.displayName = name.replace(/(^|-)(\w)/g, (_match, _dash, letter) =>
    letter.toUpperCase(),
  );
  return Icon;
}

export const ArrowLeft = createIcon("arrow-left", [
  ["path", { d: "m12 19-7-7 7-7" }],
  ["path", { d: "M19 12H5" }],
]);
export const ArrowRight = createIcon("arrow-right", [
  ["path", { d: "M5 12h14" }],
  ["path", { d: "m12 5 7 7-7 7" }],
]);
export const Check = createIcon("check", [["path", { d: "M20 6 9 17l-5-5" }]]);
export const ChevronDown = createIcon("chevron-down", [
  ["path", { d: "m6 9 6 6 6-6" }],
]);
export const ChevronLeft = createIcon("chevron-left", [
  ["path", { d: "m15 18-6-6 6-6" }],
]);
export const ChevronRight = createIcon("chevron-right", [
  ["path", { d: "m9 18 6-6-6-6" }],
]);
export const Circle = createIcon("circle", [
  ["circle", { cx: "12", cy: "12", r: "10" }],
]);
export const GripVertical = createIcon("grip-vertical", [
  ["circle", { cx: "9", cy: "12", r: "1" }],
  ["circle", { cx: "9", cy: "5", r: "1" }],
  ["circle", { cx: "9", cy: "19", r: "1" }],
  ["circle", { cx: "15", cy: "12", r: "1" }],
  ["circle", { cx: "15", cy: "5", r: "1" }],
  ["circle", { cx: "15", cy: "19", r: "1" }],
]);
export const Minus = createIcon("minus", [["path", { d: "M5 12h14" }]]);
export const MoreHorizontal = createIcon("ellipsis", [
  ["circle", { cx: "12", cy: "12", r: "1" }],
  ["circle", { cx: "19", cy: "12", r: "1" }],
  ["circle", { cx: "5", cy: "12", r: "1" }],
]);
export const Search = createIcon("search", [
  ["path", { d: "m21 21-4.34-4.34" }],
  ["circle", { cx: "11", cy: "11", r: "8" }],
]);
export const X = createIcon("x", [
  ["path", { d: "M18 6 6 18" }],
  ["path", { d: "m6 6 12 12" }],
]);
