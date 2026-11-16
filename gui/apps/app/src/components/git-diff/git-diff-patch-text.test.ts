import { describe, expect, it } from "vitest";
import { parseGitDiffFiles } from "./git-diff-parsing";
import {
  buildDiffLineCopyText,
  buildDiffLineSelectionText,
} from "./git-diff-patch-text";

const DIFF = [
  "diff --git a/src/value.ts b/src/value.ts",
  "index 1111111..2222222 100644",
  "--- a/src/value.ts",
  "+++ b/src/value.ts",
  "@@ -1,3 +1,3 @@",
  " function value() {",
  "-  return 3;",
  "+  return 4;",
  " }",
  "",
].join("\n");

describe("diff line selection text", () => {
  it("copies the selected lines as shown, while Reply keeps the patch context", () => {
    const [fileDiff] = parseGitDiffFiles(DIFF);
    const args = {
      displayStyle: "unified" as const,
      fileDiff: fileDiff!,
      range: {
        start: 2,
        side: "deletions" as const,
        end: 2,
        endSide: "additions" as const,
      },
    };

    expect(buildDiffLineCopyText(args)).toBe("  return 3;\n  return 4;");
    expect(buildDiffLineSelectionText(args)).toContain("+++ b/src/value.ts");
  });
});
