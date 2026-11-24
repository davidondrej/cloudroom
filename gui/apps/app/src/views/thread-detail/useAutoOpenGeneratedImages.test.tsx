// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import type { TimelineRow } from "@cloudroom/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarkdownPreviewLocalFileLink } from "@/components/ui/markdown-local-file-link";
import {
  findLinkedImages,
  useAutoOpenGeneratedImages,
  type UseAutoOpenGeneratedImagesArgs,
} from "./useAutoOpenGeneratedImages";

function userRow(
  seq: number,
  text = "go",
  options?: {
    kind?: "message" | "steer";
    localImagePaths?: string[];
  },
): TimelineRow {
  return {
    attachments:
      options?.localImagePaths === undefined
        ? null
        : {
            imageUrls: [],
            localFilePaths: [],
            localFiles: 0,
            localImagePaths: options.localImagePaths,
            localImages: options.localImagePaths.length,
            webImages: 0,
          },
    createdAt: seq,
    id: `user-${seq}`,
    initiator: "user",
    kind: "conversation",
    mentions: [],
    role: "user",
    senderThreadId: null,
    sourceSeqEnd: seq,
    sourceSeqStart: seq,
    startedAt: seq,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    text,
    threadId: "thr_1",
    turnId: `turn-${seq}`,
    turnRequest: {
      isGrouped: false,
      kind: options?.kind ?? "message",
      status: "accepted",
    },
  };
}

function assistantRow(seq: number, text: string, turnId = "turn-1"): TimelineRow {
  return {
    attachments: null,
    createdAt: seq,
    id: `assistant-${seq}`,
    kind: "conversation",
    role: "assistant",
    sourceSeqEnd: seq,
    sourceSeqStart: seq,
    startedAt: seq,
    text,
    threadId: "thr_1",
    turnId,
    turnRequest: null,
  };
}

function createOpenImageMock() {
  return vi.fn<(link: MarkdownPreviewLocalFileLink) => boolean>(() => true);
}

function createArgs(
  overrides: Partial<UseAutoOpenGeneratedImagesArgs> = {},
): UseAutoOpenGeneratedImagesArgs {
  return {
    enabled: true,
    isThreadStatusFresh: true,
    openImage: createOpenImageMock(),
    rows: [],
    threadId: "thr_1",
    threadStatus: "idle",
    workspaceRootPath: "/w",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("findLinkedImages", () => {
  it("excludes inline embeds with nested brackets, normalized /./ paths, and user attachments", () => {
    const rows: TimelineRow[] = [
      userRow(1, "check ![user [v1]](/w/user.png)", {
        localImagePaths: ["/w/attached.png"],
      }),
      assistantRow(
        2,
        [
          "![chart [v2]](/w/./chart.png)",
          "[chart](/w/chart.png)",
          "[user](/w/user.png)",
          "[attached](/w/attached.png)",
          "[fresh](/w/./fresh.png)",
        ].join("\n"),
      ),
    ];

    const linked = findLinkedImages({
      afterSeq: 1,
      rows,
      workspaceRootPath: "/w",
    });

    expect(linked.map((image) => image.key)).toEqual(["/w/fresh.png"]);
  });
});

describe("useAutoOpenGeneratedImages", () => {
  it("stays silent on idle mount, stale refetch, and cached active->idle refresh", () => {
    const openImage = vi.fn(() => true);
    const { rerender } = renderHook(
      (props: UseAutoOpenGeneratedImagesArgs) =>
        useAutoOpenGeneratedImages(props),
      {
        initialProps: createArgs({
          isThreadStatusFresh: false,
          openImage,
          rows: [userRow(1)],
          threadStatus: "active",
        }),
      },
    );

    // Server refresh reveals the turn had already finished while away.
    rerender(
      createArgs({
        isThreadStatusFresh: true,
        openImage,
        rows: [userRow(1), assistantRow(5, "[img](/w/old.png)")],
        threadStatus: "idle",
      }),
    );

    expect(openImage).not.toHaveBeenCalled();
  });

  it("does not treat waiting-for-host as a turn completion", () => {
    const openImage = vi.fn(() => true);
    const { rerender } = renderHook(
      (props: UseAutoOpenGeneratedImagesArgs) =>
        useAutoOpenGeneratedImages(props),
      {
        initialProps: createArgs({
          openImage,
          rows: [userRow(1)],
          threadStatus: "active",
        }),
      },
    );

    rerender(
      createArgs({
        openImage,
        rows: [userRow(1), assistantRow(5, "[img](/w/a.png)")],
        threadStatus: "waiting-for-host",
      }),
    );

    expect(openImage).not.toHaveBeenCalled();
  });

  it("opens once on live running->idle, disarms for later idle refetches, and skips repeats", () => {
    const openImage = vi.fn(() => true);
    const { rerender } = renderHook(
      (props: UseAutoOpenGeneratedImagesArgs) =>
        useAutoOpenGeneratedImages(props),
      {
        initialProps: createArgs({
          openImage,
          rows: [userRow(1)],
          threadStatus: "active",
        }),
      },
    );

    // Turn finishes before timeline rows arrive.
    rerender(
      createArgs({
        openImage,
        rows: [userRow(1)],
        threadStatus: "idle",
      }),
    );
    expect(openImage).not.toHaveBeenCalled();

    // Final assistant row arrives.
    rerender(
      createArgs({
        openImage,
        rows: [userRow(1), assistantRow(5, "[img](/w/new.png)")],
        threadStatus: "idle",
      }),
    );
    expect(openImage).toHaveBeenCalledTimes(1);
    expect(openImage).toHaveBeenCalledWith({
      lineRange: null,
      path: "/w/new.png",
    });

    // Later idle refetch bringing an unrelated turn must NOT open.
    rerender(
      createArgs({
        openImage,
        rows: [
          userRow(1),
          assistantRow(5, "[img](/w/new.png)"),
          userRow(6),
          assistantRow(10, "[other](/w/other.png)", "turn-2"),
        ],
        threadStatus: "idle",
      }),
    );
    expect(openImage).toHaveBeenCalledTimes(1);

    // Re-linking the same image on a later live turn must NOT reopen it.
    rerender(
      createArgs({
        openImage,
        rows: [
          userRow(1),
          assistantRow(5, "[img](/w/new.png)"),
          userRow(11),
        ],
        threadStatus: "active",
      }),
    );
    rerender(
      createArgs({
        openImage,
        rows: [
          userRow(1),
          assistantRow(5, "[img](/w/new.png)"),
          userRow(11),
          assistantRow(15, "[img again](/w/new.png)", "turn-3"),
        ],
        threadStatus: "idle",
      }),
    );
    expect(openImage).toHaveBeenCalledTimes(1);
  });

  it("does not mark unfocused-pane or over-limit images as opened", () => {
    const openImage = createOpenImageMock();
    const sixLinks = [1, 2, 3, 4, 5, 6]
      .map((n) => `[img${n}](/w/img${n}.png)`)
      .join(" ");

    // Unfocused pane finishes with img0: must not persist.
    const { rerender } = renderHook(
      (props: UseAutoOpenGeneratedImagesArgs) =>
        useAutoOpenGeneratedImages(props),
      {
        initialProps: createArgs({
          enabled: false,
          openImage,
          rows: [userRow(1)],
          threadStatus: "active",
        }),
      },
    );
    rerender(
      createArgs({
        enabled: false,
        openImage,
        rows: [userRow(1), assistantRow(2, "[img0](/w/img0.png)")],
        threadStatus: "idle",
      }),
    );
    expect(openImage).not.toHaveBeenCalled();

    // Focused live turn links 6 images: opens 5 (+ re-focuses first) and does not persist 6th.
    rerender(
      createArgs({
        enabled: true,
        openImage,
        rows: [userRow(1), assistantRow(2, "[img0](/w/img0.png)"), userRow(3)],
        threadStatus: "active",
      }),
    );
    rerender(
      createArgs({
        enabled: true,
        openImage,
        rows: [
          userRow(1),
          assistantRow(2, "[img0](/w/img0.png)"),
          userRow(3),
          assistantRow(4, sixLinks, "turn-2"),
        ],
        threadStatus: "idle",
      }),
    );
    expect(openImage.mock.calls.map(([link]) => link.path)).toEqual([
      "/w/img1.png",
      "/w/img2.png",
      "/w/img3.png",
      "/w/img4.png",
      "/w/img5.png",
      "/w/img1.png",
    ]);

    // Later live turn linking img6 and img0 (with prior turn rows still present) opens both.
    openImage.mockClear();
    const priorRows = [
      userRow(1),
      assistantRow(2, "[img0](/w/img0.png)"),
      userRow(3),
      assistantRow(4, sixLinks, "turn-2"),
    ];
    rerender(
      createArgs({
        enabled: true,
        openImage,
        rows: [...priorRows, userRow(5)],
        threadStatus: "active",
      }),
    );
    rerender(
      createArgs({
        enabled: true,
        openImage,
        rows: [
          ...priorRows,
          userRow(5),
          assistantRow(6, "[img6](/w/img6.png) [img0](/w/img0.png)", "turn-3"),
        ],
        threadStatus: "idle",
      }),
    );
    expect(openImage.mock.calls.map(([link]) => link.path)).toEqual([
      "/w/img6.png",
      "/w/img0.png",
      "/w/img6.png",
    ]);
  });

  it("waits for Cloud workspaceRootPath when relative image links arrive before checkout path", () => {
    const openImage = vi.fn(() => true);
    const { rerender } = renderHook(
      (props: UseAutoOpenGeneratedImagesArgs) =>
        useAutoOpenGeneratedImages(props),
      {
        initialProps: createArgs({
          openImage,
          rows: [userRow(1)],
          threadStatus: "active",
          workspaceRootPath: null,
        }),
      },
    );

    rerender(
      createArgs({
        openImage,
        rows: [
          userRow(1),
          assistantRow(
            2,
            "![inline](out/inline.png) [inline](/repo/out/inline.png) [card](out/card.png)",
          ),
        ],
        threadStatus: "idle",
        workspaceRootPath: null,
      }),
    );
    expect(openImage).not.toHaveBeenCalled();

    // Cloud workspace path arrives: relative embed suppresses absolute link, relative link opens.
    rerender(
      createArgs({
        openImage,
        rows: [
          userRow(1),
          assistantRow(
            2,
            "![inline](out/inline.png) [inline](/repo/out/inline.png) [card](out/card.png)",
          ),
        ],
        threadStatus: "idle",
        workspaceRootPath: "/repo",
      }),
    );
    expect(openImage).toHaveBeenCalledTimes(1);
    expect(openImage).toHaveBeenCalledWith({
      lineRange: null,
      path: "/repo/out/card.png",
    });
  });

  it("shares persisted opened paths across two mounted views on the same thread", () => {
    const openA = vi.fn(() => true);
    const openB = vi.fn(() => true);
    const hookA = renderHook(
      (props: UseAutoOpenGeneratedImagesArgs) =>
        useAutoOpenGeneratedImages(props),
      {
        initialProps: createArgs({
          openImage: openA,
          rows: [userRow(1)],
          threadStatus: "active",
        }),
      },
    );
    const hookB = renderHook(
      (props: UseAutoOpenGeneratedImagesArgs) =>
        useAutoOpenGeneratedImages(props),
      {
        initialProps: createArgs({
          openImage: openB,
          rows: [userRow(1)],
          threadStatus: "active",
        }),
      },
    );

    const doneRows = [userRow(1), assistantRow(2, "[shot](/w/shot.png)")];
    hookA.rerender(
      createArgs({ openImage: openA, rows: doneRows, threadStatus: "idle" }),
    );
    hookB.rerender(
      createArgs({ openImage: openB, rows: doneRows, threadStatus: "idle" }),
    );

    expect(openA).toHaveBeenCalledTimes(1);
    expect(openB).not.toHaveBeenCalled();
  });
});
