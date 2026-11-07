import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { fontFileProblem, scriptFontStackEntry } from "@/lib/reading-preferences";
import { rehypeAutoDirection } from "./markdown-auto-direction";

function render(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeAutoDirection]}>
      {markdown}
    </ReactMarkdown>,
  );
}

describe("rehypeAutoDirection", () => {
  it("marks text blocks dir=auto so Persian paragraphs run right-to-left", () => {
    const html = render("سلام دنیا\n\n- یک\n- two\n\n> نقل\n\n| ستون |\n| --- |\n| مقدار |");
    expect(html).toContain('<p dir="auto">سلام دنیا</p>');
    expect(html).toContain('<ul dir="auto">');
    expect(html).toContain("<li>یک</li>");
    expect(html).toMatch(/<blockquote dir="auto">\s*<p>نقل<\/p>/u);
    expect(html).toContain('<table dir="auto">');
    expect(html).toContain("<th>ستون</th>");
    expect(html).toContain("<td>مقدار</td>");
  });

  it("leaves code blocks left-to-right", () => {
    const html = render("```\nconst x = 1;\n```\n\nمتن `inline` فارسی");
    expect(html).toContain("<pre><code>");
    expect(html).not.toMatch(/<(pre|code)[^>]*dir=/u);
  });
});

describe("scriptFontStackEntry", () => {
  it("quotes a family name and strips characters that could break the stack", () => {
    expect(scriptFontStackEntry(" Pofak ")).toBe('"Pofak"');
    expect(scriptFontStackEntry('Bad"; color: red')).toBe('"Bad color: red"');
    expect(scriptFontStackEntry("")).toBe("sans-serif");
  });
});

describe("fontFileProblem", () => {
  it("accepts font files and rejects other types or oversized files", () => {
    expect(fontFileProblem({ name: "Vazir.WOFF2", size: 120_000 })).toBeNull();
    expect(fontFileProblem({ name: "font.otf", size: 20 * 1024 * 1024 })).toBeNull();
    expect(fontFileProblem({ name: "notes.pdf", size: 10 })).toMatch(/\.ttf/u);
    expect(fontFileProblem({ name: "huge.ttf", size: 20 * 1024 * 1024 + 1 })).toMatch(/20 MB/u);
  });
});

describe("rehypeAutoDirection with Hebrew", () => {
  it("marks a Hebrew paragraph dir=auto too", () => {
    expect(render("שלום עולם")).toContain('<p dir="auto">שלום עולם</p>');
  });
});
