import { describe, expect, it } from "vitest";
import { lookupMimeType } from "../src/mime-types.js";

describe("lookupMimeType", () => {
  it.each([
    ["photo.PNG", "image/png"],
    [".png", "image/png"],
    ["png", "image/png"],
    ["C:\\Users\\me\\photo.JPG", "image/jpeg"],
    ["/repo/docs/README.md", "text/markdown"],
    ["site/index.html", "text/html"],
    [
      "report.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    // Extensions several types claim get the type mime-types 3.0.2 picks.
    ["feed.xml", "application/xml"],
    ["notes.rtf", "application/rtf"],
    ["clip.mp4", "video/mp4"],
    ["sound.wav", "audio/wav"],
    ["main.ts", "video/mp2t"],
  ])("gives %s the type %s", (path, type) => {
    expect(lookupMimeType(path)).toBe(type);
  });

  it.each([
    "",
    "Makefile",
    "photo.png.",
    "x/.png",
    "x.unknownext",
    "x.constructor",
    "x.__proto__",
    "x.toString",
  ])("knows no type for %j", (path) => {
    expect(lookupMimeType(path)).toBe(false);
  });
});
