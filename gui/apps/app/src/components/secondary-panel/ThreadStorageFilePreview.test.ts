import { describe, expect, it } from "vitest";
import { exceedsHtmlPreviewLimit } from "./ThreadStorageFilePreview";

describe("exceedsHtmlPreviewLimit", () => {
  const limit = 5 * 1024 * 1024;
  it.each([
    ["small report", "<p>ok</p>", false],
    ["5 MiB minus a BOM's 3 bytes", "a".repeat(limit - 3), false],
    ["5 MiB body behind a stripped BOM", "a".repeat(limit), true],
    ["one byte over in ASCII", "a".repeat(limit + 1), true],
    [
      "under 5 Mi chars but over 5 MiB in UTF-8",
      "é".repeat(limit / 2 + 1),
      true,
    ],
  ])("%s", (_label, content, expected) => {
    expect(exceedsHtmlPreviewLimit(content)).toBe(expected);
  });
});
