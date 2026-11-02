// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertDocument } from "./index";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, "fixtures", name)));

describe("convertDocument", () => {
  it("turns each Excel sheet into CSV with values, dates, and percentages", async () => {
    const preview = await convertDocument("xlsx", fixture("workbook.xlsx"));

    expect(preview.parts).toEqual([
      {
        name: "Revenue",
        text: [
          "Month,Revenue,Growth,Closed",
          "Jul,151320,6.6%,2026-07-31",
          "Aug,158940.5,5.0%,2026-08-31",
          '"Sep, ""soft""",149210,-6.1%,2026-09-30',
          "",
          "Total,=SUM(B2:B4)",
        ].join("\n"),
      },
      { name: "Costs", text: "Item,Amount\nInference,41900" },
    ]);
  });

  it("turns a Word document into Markdown without letting its text become markup", async () => {
    const preview = await convertDocument("docx", fixture("memo.docx"));

    expect(preview.detail).toBe("35 words");
    expect(preview.parts[0]?.text).toBe(
      [
        "# Q3 board memo",
        "",
        "Revenue reached **$1.00M** against a plan of $949K.",
        "",
        "## Highlights",
        "",
        "- Cloud threads grew 3.1x",
        "- Churn fell to 2.4%",
        "1. First step",
        "",
        "\\# not a heading \\<b\\>and not html\\</b\\>",
        "",
        "| Metric | Q3 |",
        "| --- | --- |",
        "| Revenue \\| net | $1.00M |",
      ].join("\n"),
    );
  });

  it("turns slides into Markdown with bullets, notes, and tables", async () => {
    const preview = await convertDocument("pptx", fixture("deck.pptx"));

    expect(preview.detail).toBe("3 slides");
    expect(preview.parts[0]?.text).toBe(
      [
        "### Slide 1 · Q3 2026 review",
        "",
        "$1.84M ARR",
        "",
        "> Notes: Open with ARR.",
        "",
        "### Slide 2 · Growth",
        "",
        "- October was the best month",
        "  - Up 15.9%",
        "",
        "### Slide 3 · Numbers",
        "",
        "| Plan | Churn |",
        "| --- | --- |",
        "| Pro | 2.4% |",
      ].join("\n"),
    );
  });

  it("lists ZIP and tar.gz contents with folder totals", async () => {
    const zip = await convertDocument("zip", fixture("assets.zip"));
    const tgz = await convertDocument("tgz", fixture("assets.tar.gz"));

    expect(zip.detail).toBe("3 files · 6 KB");
    expect(zip.parts[0]?.text).toBe(
      [
        "empty-folder/        0 files       0 B",
        "icons/               2 files      6 KB",
        "  icon-512.png                    2 KB",
        "  icon-1024.png                   4 KB",
        "README.md                        450 B",
      ].join("\n"),
    );
    expect(tgz.detail).toBe("3 files · 2 KB");
    expect(tgz.parts[0]?.text).toContain(`    ${"x".repeat(120)}.ts`);
  });

  it("caps how much text a small workbook can expand into", async () => {
    const preview = await convertDocument(
      "xlsx",
      fixture("repeated-strings.xlsx"),
    );
    const text = preview.parts[0]?.text ?? "";

    expect(text.length).toBeLessThan(10_000_000);
    expect(text.split("\n")).toHaveLength(2);
  });

  it("stops at a tar header with a negative size", async () => {
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode("evil.txt"), 0);
    header.set(new TextEncoder().encode("-1000"), 124);

    const preview = await convertDocument("tar", header);

    expect(preview.detail).toBe("0 files · 0 B");
  });

  it("rejects files that are not what their name says", async () => {
    const notOffice = new TextEncoder().encode("plain text, not a spreadsheet");

    await expect(convertDocument("xlsx", notOffice)).rejects.toThrow();
    await expect(convertDocument("zip", notOffice)).rejects.toThrow();
  });
});
