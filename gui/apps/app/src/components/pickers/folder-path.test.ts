import { describe, expect, it } from "vitest";
import { cleanPathQuery, resolveFolder, splitPathQuery } from "./folder-path";

describe("folder path queries", () => {
  it("keeps a pasted Windows path whole and splits it at its last separator (#2127)", () => {
    const pasted = cleanPathQuery('"C:\\Users\\me\\My Repo"', true);
    expect(pasted).toBe("C:\\Users\\me\\My Repo");
    expect(splitPathQuery(pasted)).toEqual({ folder: "C:\\Users\\me\\", leaf: "My Repo" });
    expect(resolveFolder("C:\\Users\\me\\", "C:\\Users\\me")).toBe("C:\\Users\\me\\");
    expect(splitPathQuery("D:/code/app")).toEqual({ folder: "D:/code/", leaf: "app" });
    // Shell escapes elsewhere, and off Windows, still unescape.
    expect(cleanPathQuery("~/My\\ Folder", true)).toBe("~/My Folder");
    expect(cleanPathQuery("C:\\ Repo")).toBe("C: Repo");
  });
});
