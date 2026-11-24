import { z } from "zod";
import {
  desktopBrowserImportSelectionSchema,
  desktopBrowserProfileSchema,
  type DesktopBrowserImportOutcome,
  type DesktopBrowserImportSource,
} from "@cloudroom/host-daemon-contract";

export const ROOM_DESKTOP_BROWSER_MAX_URL_LENGTH = 4096;
export const ROOM_DESKTOP_BROWSER_MAX_TITLE_LENGTH = 1024;

export const roomDesktopBrowserTargetSchema = z
  .object({
    hostId: z.string().min(1),
    instanceId: z.string().min(1),
    generation: z.string().min(1),
  })
  .strict();
export type RoomDesktopBrowserTarget = z.infer<
  typeof roomDesktopBrowserTargetSchema
>;

export const roomDesktopBrowserControlSchema = z
  .object({
    leaseId: z.string().min(1),
    controllerLabel: z.string().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type RoomDesktopBrowserControl = z.infer<
  typeof roomDesktopBrowserControlSchema
>;
export const roomDesktopBrowserControlStateSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    control: roomDesktopBrowserControlSchema.nullable(),
  })
  .strict();
export type RoomDesktopBrowserControlState = z.infer<
  typeof roomDesktopBrowserControlStateSchema
>;
export const roomDesktopBrowserRevealRequestSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    desktopTarget: roomDesktopBrowserTargetSchema,
  })
  .strict();
export type RoomDesktopBrowserRevealRequest = z.infer<
  typeof roomDesktopBrowserRevealRequestSchema
>;

const roomDesktopBrowserViewBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  })
  .strict();
export type RoomDesktopBrowserViewBounds = z.infer<
  typeof roomDesktopBrowserViewBoundsSchema
>;

export interface RoomDesktopBrowserViewportBounds {
  width: number;
  height: number;
}

interface ClampIntegerToRangeArgs {
  max: number;
  min: number;
  value: number;
}

interface ClampRoomDesktopBrowserViewBoundsArgs {
  bounds: RoomDesktopBrowserViewBounds;
  viewport: RoomDesktopBrowserViewportBounds;
}

function clampIntegerToRange(args: ClampIntegerToRangeArgs): number {
  return Math.min(Math.max(args.value, args.min), args.max);
}

export function clampRoomDesktopBrowserViewBounds(
  args: ClampRoomDesktopBrowserViewBoundsArgs,
): RoomDesktopBrowserViewBounds {
  const viewportRight = Math.max(0, Math.round(args.viewport.width));
  const viewportBottom = Math.max(0, Math.round(args.viewport.height));
  const x = clampIntegerToRange({
    value: args.bounds.x,
    min: 0,
    max: viewportRight,
  });
  const y = clampIntegerToRange({
    value: args.bounds.y,
    min: 0,
    max: viewportBottom,
  });
  const right = clampIntegerToRange({
    value: args.bounds.x + args.bounds.width,
    min: x,
    max: viewportRight,
  });
  const bottom = clampIntegerToRange({
    value: args.bounds.y + args.bounds.height,
    min: y,
    max: viewportBottom,
  });

  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

export const roomDesktopBrowserAttachRequestSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    url: z.string().max(ROOM_DESKTOP_BROWSER_MAX_URL_LENGTH),
    existingOnly: z.literal(true).optional(),
    bounds: roomDesktopBrowserViewBoundsSchema,
    visible: z.boolean(),
  })
  .strict();
export type RoomDesktopBrowserAttachRequest = z.infer<
  typeof roomDesktopBrowserAttachRequestSchema
>;

export const roomDesktopBrowserNavigateRequestSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().min(1).max(ROOM_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type RoomDesktopBrowserNavigateRequest = z.infer<
  typeof roomDesktopBrowserNavigateRequestSchema
>;

export const roomDesktopBrowserSetBoundsRequestSchema = z
  .object({
    tabId: z.string().min(1),
    bounds: roomDesktopBrowserViewBoundsSchema,
  })
  .strict();
export type RoomDesktopBrowserSetBoundsRequest = z.infer<
  typeof roomDesktopBrowserSetBoundsRequestSchema
>;

export const roomDesktopBrowserSetVisibleRequestSchema = z
  .object({
    tabId: z.string().min(1),
    visible: z.boolean(),
  })
  .strict();
export type RoomDesktopBrowserSetVisibleRequest = z.infer<
  typeof roomDesktopBrowserSetVisibleRequestSchema
>;

export const roomDesktopBrowserTabRefSchema = z
  .object({
    tabId: z.string().min(1),
  })
  .strict();
export type RoomDesktopBrowserTabRef = z.infer<
  typeof roomDesktopBrowserTabRefSchema
>;

export const roomDesktopBrowserStateSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().max(ROOM_DESKTOP_BROWSER_MAX_URL_LENGTH),
    title: z.string().max(ROOM_DESKTOP_BROWSER_MAX_TITLE_LENGTH).nullable(),
    isLoading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    errorText: z.string().max(ROOM_DESKTOP_BROWSER_MAX_TITLE_LENGTH).nullable(),
  })
  .strict();
export type RoomDesktopBrowserState = z.infer<typeof roomDesktopBrowserStateSchema>;

export const roomDesktopBrowserOpenTabRequestSchema = z
  .object({
    url: z.string().min(1).max(ROOM_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type RoomDesktopBrowserOpenTabRequest = z.infer<
  typeof roomDesktopBrowserOpenTabRequestSchema
>;

export const roomDesktopBrowserScopedOpenTabRequestSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().min(1).max(ROOM_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type RoomDesktopBrowserScopedOpenTabRequest = z.infer<
  typeof roomDesktopBrowserScopedOpenTabRequestSchema
>;

const ROOM_DESKTOP_BROWSER_MAX_SNAPSHOT_DATA_URL_LENGTH = 8_388_608;

export const roomDesktopBrowserSnapshotSchema = z
  .object({
    tabId: z.string().min(1),
    dataUrl: z
      .string()
      .max(ROOM_DESKTOP_BROWSER_MAX_SNAPSHOT_DATA_URL_LENGTH)
      .nullable(),
  })
  .strict();
export type RoomDesktopBrowserSnapshot = z.infer<
  typeof roomDesktopBrowserSnapshotSchema
>;

export const ROOM_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH = 1024;

export const roomDesktopBrowserFindInPageRequestSchema = z
  .object({
    tabId: z.string().min(1),
    text: z.string().min(1).max(ROOM_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH),
    forward: z.boolean(),
    newSession: z.boolean(),
  })
  .strict();
export type RoomDesktopBrowserFindInPageRequest = z.infer<
  typeof roomDesktopBrowserFindInPageRequestSchema
>;

export const roomDesktopBrowserStopFindInPageRequestSchema = z
  .object({
    tabId: z.string().min(1),
    action: z.enum(["clearSelection", "keepSelection", "activateSelection"]),
  })
  .strict();
export type RoomDesktopBrowserStopFindInPageRequest = z.infer<
  typeof roomDesktopBrowserStopFindInPageRequestSchema
>;

export const roomDesktopBrowserFindResultSchema = z
  .object({
    tabId: z.string().min(1),
    requestId: z.number().int(),
    activeMatchOrdinal: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative(),
    finalUpdate: z.boolean(),
  })
  .strict();
export type RoomDesktopBrowserFindResult = z.infer<
  typeof roomDesktopBrowserFindResultSchema
>;

export type RoomDesktopBrowserStateHandler = (
  state: RoomDesktopBrowserState,
) => void;
export type RoomDesktopBrowserOpenTabHandler = (
  request: RoomDesktopBrowserOpenTabRequest,
) => void;
export type RoomDesktopBrowserScopedOpenTabHandler = (
  request: RoomDesktopBrowserScopedOpenTabRequest,
) => void;
export type RoomDesktopBrowserSnapshotHandler = (
  snapshot: RoomDesktopBrowserSnapshot,
) => void;
export type RoomDesktopBrowserFocusHandler = (tabId: string) => void;
export type RoomDesktopBrowserFindResultHandler = (
  result: RoomDesktopBrowserFindResult,
) => void;
export type RoomDesktopBrowserUnsubscribe = () => void;

export const roomDesktopBrowserImportCookiesRequestSchema =
  desktopBrowserImportSelectionSchema
    .extend({ profile: desktopBrowserProfileSchema })
    .strict();
export type RoomDesktopBrowserImportCookiesRequest = z.infer<
  typeof roomDesktopBrowserImportCookiesRequestSchema
>;
export type RoomDesktopBrowserImportSourcesResult = {
  sources: DesktopBrowserImportSource[];
};
export type RoomDesktopBrowserImportCookiesResult = DesktopBrowserImportOutcome;

export interface RoomDesktopBrowserApi {
  listImportSources?(): Promise<RoomDesktopBrowserImportSourcesResult>;
  importCookies?(
    request: RoomDesktopBrowserImportCookiesRequest,
  ): Promise<RoomDesktopBrowserImportCookiesResult>;
  openFullDiskAccessSettings?(): void;
  getTarget?(): Promise<RoomDesktopBrowserTarget | null>;
  getControl?(tabId: string): Promise<RoomDesktopBrowserControlState | null>;
  releaseControl?(tabId: string): void;
  onControl?(
    listener: (state: RoomDesktopBrowserControlState) => void,
  ): RoomDesktopBrowserUnsubscribe;
  onReveal?(
    listener: (request: RoomDesktopBrowserRevealRequest) => void,
  ): RoomDesktopBrowserUnsubscribe;
  attach(request: RoomDesktopBrowserAttachRequest): void;
  detach(tabId: string): void;
  navigate(request: RoomDesktopBrowserNavigateRequest): void;
  goBack(tabId: string): void;
  goForward(tabId: string): void;
  reload(tabId: string): void;
  stop(tabId: string): void;
  focus?(tabId: string): void;
  setBounds(request: RoomDesktopBrowserSetBoundsRequest): void;
  setVisible(request: RoomDesktopBrowserSetVisibleRequest): void;
  setVisibleWithoutFocus?(request: RoomDesktopBrowserSetVisibleRequest): void;
  onState(listener: RoomDesktopBrowserStateHandler): RoomDesktopBrowserUnsubscribe;
  onOpenTab(
    listener: RoomDesktopBrowserOpenTabHandler,
  ): RoomDesktopBrowserUnsubscribe;
  onScopedOpenTab?(
    listener: RoomDesktopBrowserScopedOpenTabHandler,
  ): RoomDesktopBrowserUnsubscribe;
  onFocus?(listener: RoomDesktopBrowserFocusHandler): RoomDesktopBrowserUnsubscribe;
  onSnapshot?(
    listener: RoomDesktopBrowserSnapshotHandler,
  ): RoomDesktopBrowserUnsubscribe;
  findInPage?(request: RoomDesktopBrowserFindInPageRequest): void;
  stopFindInPage?(request: RoomDesktopBrowserStopFindInPageRequest): void;
  onFindResult?(
    listener: RoomDesktopBrowserFindResultHandler,
  ): RoomDesktopBrowserUnsubscribe;
}
