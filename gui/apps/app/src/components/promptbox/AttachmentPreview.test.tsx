// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalAttachmentPreviews,
  getLocalAttachmentAspectRatio,
  registerLocalAttachmentPreview,
} from "@/lib/attachment-local-previews";
import { AttachmentPreview } from "./AttachmentPreview";

describe("AttachmentPreview", () => {
  const revoked: string[] = [];
  let created = 0;

  beforeEach(() => {
    created = 0;
    revoked.length = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => `blob:local-${++created}`,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => {
        revoked.push(url);
      },
    });
  });

  afterEach(() => {
    cleanup();
    clearLocalAttachmentPreviews();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("renders a just-picked image from its local object URL and revokes it on remove", () => {
    registerLocalAttachmentPreview(
      "photo-1-abc.png",
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    );
    registerLocalAttachmentPreview(
      "notes-1-abc.txt",
      new Blob(["hi"], { type: "text/plain" }),
    );
    const onRemoveAttachment = vi.fn();
    const { getAllByRole, getByLabelText } = render(
      <AttachmentPreview
        attachmentProjectId="proj_1"
        attachments={[
          {
            type: "localImage",
            path: "photo-1-abc.png",
            name: "photo.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
          {
            type: "localImage",
            path: "restored-2-def.png",
            name: "restored.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ]}
        expandedImageIndex={null}
        onExpandedImageIndexChange={() => {}}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );
    const images = getAllByRole("img");
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "blob:local-1",
      "/api/v1/projects/proj_1/attachments/content?path=restored-2-def.png",
    ]);
    expect(
      images.every((image) => image.getAttribute("decoding") === "async"),
    ).toBe(true);

    fireEvent.click(getByLabelText("Remove photo.png"));
    expect(onRemoveAttachment).toHaveBeenCalledWith("photo-1-abc.png");
    expect(revoked).toEqual(["blob:local-1"]);
  });

  it("separates compact touch targets from attachment remove visuals", () => {
    const { getByRole } = render(
      <AttachmentPreview
        attachments={[
          {
            type: "localImage",
            path: "screenshot.png",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
          {
            type: "localFile",
            path: "diff.patch",
            name: "diff.patch",
            mimeType: "text/plain",
            sizeBytes: 3,
          },
        ]}
        expandedImageIndex={null}
        onExpandedImageIndexChange={() => {}}
        onRemoveAttachment={() => {}}
      />,
    );

    const imageRemoveButton = getByRole("button", {
      name: "Remove screenshot.png",
    });
    expect(
      imageRemoveButton.classList.contains("max-md:pointer-coarse:size-7"),
    ).toBe(true);
    expect(imageRemoveButton.classList.contains("bg-black/55")).toBe(false);
    expect(
      imageRemoveButton.firstElementChild?.classList.contains("size-4"),
    ).toBe(true);
    expect(
      imageRemoveButton.firstElementChild?.classList.contains("bg-black/55"),
    ).toBe(true);

    const fileRemoveButton = getByRole("button", {
      name: "Remove diff.patch",
    });
    expect(
      fileRemoveButton.classList.contains("max-md:pointer-coarse:size-7"),
    ).toBe(true);
    expect(fileRemoveButton.parentElement?.classList.contains("size-4")).toBe(
      true,
    );
    expect(
      fileRemoveButton.firstElementChild?.classList.contains("size-4"),
    ).toBe(true);
  });

  it("shows a small copy of a large photo, not the full image", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 5712, height: 4284, close })),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob([new Uint8Array([1])]))),
    );
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      function (callback) {
        callback(new Blob([new Uint8Array([2])], { type: "image/webp" }));
      },
    );
    registerLocalAttachmentPreview(
      "big-1-abc.jpg",
      new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
    );
    try {
      const { container } = render(
        <AttachmentPreview
          attachments={[
            {
              type: "localImage",
              path: "big-1-abc.jpg",
              name: "big.jpg",
              mimeType: "image/jpeg",
              sizeBytes: 1,
            },
          ]}
          expandedImageIndex={null}
          onExpandedImageIndexChange={() => {}}
        />,
      );
      // Nothing heavy renders while the copy is being made.
      expect(container.querySelector("img")).toBeNull();
      await waitFor(() =>
        expect(container.querySelector("img")?.getAttribute("src")).toBe(
          "blob:local-2",
        ),
      );
      expect(fetch).toHaveBeenCalledWith("blob:local-1", expect.anything());
      // Center square of the photo, scaled to the tile.
      expect(drawImage.mock.calls[0]?.slice(1)).toEqual([
        714, 0, 4284, 4284, 0, 0, 168, 168,
      ]);
      expect(close).toHaveBeenCalled();
      expect(getLocalAttachmentAspectRatio("big-1-abc.jpg")).toBe(5712 / 4284);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
