import type { IconSvgElement } from "@hugeicons/react";

const STROKE = {
  stroke: "currentColor",
  strokeWidth: "1.5",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const path = (d: string, key: string) =>
  ["path", { d, ...STROKE, key }] as const;

const dot = (cx: number, key: string) =>
  ["circle", { cx, cy: 12, r: 1.4, fill: "currentColor", key }] as const;

const bar = (x: number, y: number, height: number, key: string) =>
  ["rect", { x, y, width: 4, height, rx: 1.5, ...STROKE, key }] as const;

export const SoftNewThreadIcon: IconSvgElement = [
  path("M11.5 4H8a4 4 0 0 0-4 4v8a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4v-3.5", "0"),
  path("M17.4 3.85a2.05 2.05 0 0 1 2.9 2.9l-6.95 6.95-3.85.95.95-3.85z", "1"),
];

export const SoftPluginsIcon: IconSvgElement = [
  path("M9.5 3v4M14.5 3v4", "0"),
  path("M6.5 7h11v3a5.5 5.5 0 0 1-11 0z", "1"),
  path("M12 15.5v2a3 3 0 0 0 3 3h2", "2"),
];

export const SoftAutomationsIcon: IconSvgElement = [
  path(
    "M12 12c-1.9-2.6-3.7-4-5.5-4a4 4 0 0 0 0 8c1.8 0 3.6-1.4 5.5-4zm0 0c1.9 2.6 3.7 4 5.5 4a4 4 0 0 0 0-8c-1.8 0-3.6 1.4-5.5 4z",
    "0",
  ),
];

export const SoftMoreIcon: IconSvgElement = [
  dot(5, "0"),
  dot(12, "1"),
  dot(19, "2"),
];

export const SoftSettingsIcon: IconSvgElement = [
  path(
    "M9.74 5.8L10.08 2.95A9.25 9.25 0 0 1 13.92 2.95L14.26 5.8A6.6 6.6 0 0 1 16.24 6.94L18.87 5.81A9.25 9.25 0 0 1 20.8 9.14L18.5 10.85A6.6 6.6 0 0 1 18.5 13.15L20.8 14.86A9.25 9.25 0 0 1 18.87 18.19L16.24 17.06A6.6 6.6 0 0 1 14.26 18.2L13.92 21.05A9.25 9.25 0 0 1 10.08 21.05L9.74 18.2A6.6 6.6 0 0 1 7.76 17.06L5.13 18.19A9.25 9.25 0 0 1 3.2 14.86L5.5 13.15A6.6 6.6 0 0 1 5.5 10.85L3.2 9.14A9.25 9.25 0 0 1 5.13 5.81L7.76 6.94A6.6 6.6 0 0 1 9.74 5.8Z",
    "0",
  ),
  ["circle", { cx: 12, cy: 12, r: 2.75, ...STROKE, key: "1" }],
];

export const SoftMobileIcon: IconSvgElement = [
  [
    "rect",
    { x: 6, y: 2.5, width: 12, height: 19, rx: 3.5, ...STROKE, key: "0" },
  ],
  path("M10.5 18.5h3", "1"),
];

export const SoftUsageIcon: IconSvgElement = [
  bar(4, 13, 7.5, "0"),
  bar(10, 8.5, 12, "1"),
  bar(16, 3.5, 17, "2"),
];

export const SoftAccountIcon: IconSvgElement = [
  ["circle", { cx: 12, cy: 7.75, r: 3.75, ...STROKE, key: "0" }],
  path("M4.5 20.5c.9-3.5 3.8-5.75 7.5-5.75s6.6 2.25 7.5 5.75", "1"),
];

export const SoftFolderIcon: IconSvgElement = [
  path(
    "M2.5 7.5A3 3 0 0 1 5.5 4.5h3.2c.8 0 1.55.4 2 1.05l1.1 1.45H18.5a3 3 0 0 1 3 3v7.5a3 3 0 0 1-3 3h-13a3 3 0 0 1-3-3z",
    "0",
  ),
  path("M2.5 10h19", "1"),
];

export const SoftLaptopIcon: IconSvgElement = [
  path("M4 15.5V7.5A3.5 3.5 0 0 1 7.5 4h9A3.5 3.5 0 0 1 20 7.5v8", "0"),
  path(
    "M4 15.5h16l1.55 2.6a1.25 1.25 0 0 1-1.07 1.9H3.52a1.25 1.25 0 0 1-1.07-1.9z",
    "1",
  ),
];

export const SoftGitBranchIcon: IconSvgElement = [
  ["circle", { cx: 6, cy: 5.5, r: 2.25, ...STROKE, key: "0" }],
  ["circle", { cx: 18, cy: 5.5, r: 2.25, ...STROKE, key: "1" }],
  ["circle", { cx: 6, cy: 18.5, r: 2.25, ...STROKE, key: "2" }],
  path("M6 7.75v8.5", "3"),
  path("M8.25 18.5H13a5 5 0 0 0 5-5V7.75", "4"),
];

export const SoftSendIcon: IconSvgElement = [
  [
    "path",
    {
      d: "M12 19.5V4.5M5.4 11.1 12 4.5l6.6 6.6",
      ...STROKE,
      strokeWidth: "2.7",
      key: "0",
    },
  ],
];

export const SoftSendNowIcon: IconSvgElement = [
  ["circle", { cx: 12, cy: 12, r: 9.25, ...STROKE, key: "0" }],
  path("M12 16.5V7.75M8 11.5l4-3.75 4 3.75", "1"),
];

export const SoftEditIcon: IconSvgElement = [
  path(
    "M15.81 5.01a2.25 2.25 0 0 1 3.18 3.18L8 19.19l-3.12.63Q4 20 4.18 19.12l.63-3.12z",
    "0",
  ),
  path("M13.4 7.41l3.19 3.19", "1"),
  path("M13.5 20h6.5", "2"),
];

export const SoftTrashIcon: IconSvgElement = [
  path("M3.75 6.5h16.5", "0"),
  path("M9 6.5a3 3 0 0 1 6 0", "1"),
  path(
    "M5.75 6.5l1 11.75a3 3 0 0 0 3 2.75h4.5a3 3 0 0 0 3-2.75l1-11.75",
    "2",
  ),
];
