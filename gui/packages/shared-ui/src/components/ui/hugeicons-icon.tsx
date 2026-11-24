/**
 * @license
 * HugeiconsIcon below is ported from @hugeicons/react 1.1.6
 * (https://github.com/hugeicons/react).
 *
 * MIT License
 *
 * Copyright (c) 2025 Hugeicons
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
import { createElement, type Ref, type SVGProps } from "react";

// Draws a Hugeicons glyph (the [tag, attributes] list @hugeicons/core-free-icons
// exports) with the same SVG markup, props, and ref as @hugeicons/react 1.1.6.

export type IconSvgElement = readonly (readonly [
  string,
  { readonly [key: string]: string | number },
])[];

export interface HugeiconsIconProps extends Omit<
  SVGProps<SVGSVGElement>,
  "ref" | "strokeWidth"
> {
  icon: IconSvgElement;
  altIcon?: IconSvgElement;
  showAlt?: boolean;
  size?: string | number;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
  primaryColor?: string;
  secondaryColor?: string;
  disableSecondaryOpacity?: boolean;
  ref?: Ref<SVGSVGElement>;
}

export function HugeiconsIcon({
  color = "currentColor",
  size = 24,
  strokeWidth,
  absoluteStrokeWidth = false,
  className = "",
  altIcon,
  showAlt = false,
  icon,
  primaryColor,
  secondaryColor,
  disableSecondaryOpacity = false,
  ...rest
}: HugeiconsIconProps) {
  const strokeProps =
    strokeWidth === undefined
      ? {}
      : {
          strokeWidth: absoluteStrokeWidth
            ? (Number(strokeWidth) * 24) / Number(size)
            : strokeWidth,
          stroke: "currentColor",
        };
  const mainColor = primaryColor || color;
  // Two-tone layers (the ones with an opacity) draw first, under the rest.
  const children = [...(showAlt && altIcon ? altIcon : icon)]
    .sort(([, a], [, b]) =>
      b.opacity !== undefined ? 1 : a.opacity !== undefined ? -1 : 0,
    )
    .map(([tag, attrs]) => {
      const secondary = attrs.opacity !== undefined;
      return createElement(tag, {
        ...attrs,
        ...strokeProps,
        ...(secondaryColor
          ? {
              [attrs.stroke !== undefined ? "stroke" : "fill"]: secondary
                ? secondaryColor
                : mainColor,
            }
          : {}),
        opacity:
          secondary && !disableSecondaryOpacity ? attrs.opacity : undefined,
        key: attrs.key,
      });
    });
  return createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      color: mainColor,
      className,
      ...strokeProps,
      ...rest,
    },
    children,
  );
}
