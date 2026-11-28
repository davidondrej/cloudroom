const HTML_ESCAPE_REPLACEMENTS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtmlText(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) => HTML_ESCAPE_REPLACEMENTS[character] ?? character,
  );
}

/**
 * A provider's HTML error page (a Cloudflare 403) filled failed-child notices
 * and `thread wait --children` lines with markup and cut off the status line's
 * URL and request ID. Its title is kept; the full page stays in the child's
 * thread (#2601). Codex cuts the page at ~1,000 bytes and adds "...", so a
 * page without `</html>` ends before the error's `, url:`, `, cf-ray:` or
 * `, request id:`, else at the end of the text.
 */
const HTML_PAGE_PATTERN =
  /<(?:!doctype\s+html|html)\b[\s\S]*?(?:<\/html\s*>|(?:\.\.\.)?(?=,\s*(?:url|cf-ray|request id):)|$)/giu;

export function withoutHtmlPages(text: string): string {
  return text.replace(HTML_PAGE_PATTERN, (page) => {
    // Prose that only names a tag ("expected <html>") is no page.
    if (!/<(?:head|body)\b/iu.test(page)) return page;
    const title = /<title[^<>]*>([^<]*)/iu
      .exec(page)?.[1]
      ?.replace(/\s+/gu, " ")
      .trim();
    return title ? `[HTML page "${title}" omitted]` : "[HTML page omitted]";
  });
}
