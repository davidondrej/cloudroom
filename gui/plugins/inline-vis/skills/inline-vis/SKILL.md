---
name: inline-vis
description: "Show a visual inside your Cloudroom reply: an HTML page (fix report, timeline, before/after flow, pipeline, chart, table, status cards, mockup) or a Markdown document, rendered inline with the ::inline-vis directive. Use it when a visual explains a result better than prose."
---

# Inline visuals

Write a self-contained HTML (or Markdown) file. Then put the directive on its
own line where the visual belongs in your reply:

```text
::inline-vis{source="thread-storage" file="reports/fix-report.html"}
```

## When

- Use it when a visual says more than prose: several fixes, a timeline,
  before and after, a pipeline, a comparison, a chart, a status board.
- Skip it for short answers. One visual per reply is usually enough.
- The reader sees the visual. Don't announce it or restate it. Write only what
  it doesn't say.

## Files and directive

- Prefer `source="thread-storage"`: write to `$BB_THREAD_STORAGE/<path>` and
  pass the storage-relative path. It keeps the repo clean. Omit `source` (or
  use `workspace`) for files that belong in the repo.
- Use a new file name for each visual. A message shows its file as it is now,
  so overwriting a file changes older messages.
- `file` is relative, never absolute: `.html`, `.htm`, `.md`, or `.markdown`,
  UTF-8, under 5 MiB. Write it before you emit the directive.
- HTML frames grow to fit the page, up to 2000px. `height="480"` caps a frame
  (a whole number from 120 to 2000); the rest scrolls inside. Markdown previews
  are 224px tall unless you set `height`.
- Never put the directive in backticks or a code fence. Emit it in one piece.

## Make HTML look native

Cloudroom shows the page in a borderless, sandboxed frame on the chat's own
background. It is as wide as the reply column (about 720px on desktop, 360px on
phones) and lines up with your text.

- No background on `html`, `body`, or the outer element. No outer card, border,
  page title, or banner. The page is part of your reply.
- Fluid width with no horizontal padding on the outer element. Check 360px.
- Use `minmax(0, 1fr)` for grid columns. The frame hides overflow, so wide
  content silently gets cut off.
- Let content set the height. Never use `100vh` or `height: 100%`. Give charts
  fixed pixel heights.
- Take every color from the theme variables below. Never hardcode a page color.
- Inherit the font and size. Use 12px muted text for labels and mono for IDs,
  hashes, paths, and numbers.
- A box with its own background gets 12–16px padding and `var(--radius)`.
- Use inline `<style>` and `<script>`. CDN scripts and files next to the page
  load too. The page cannot reach the app, its cookies, or its storage. No
  forms, popups, or alerts. Links open in the user's browser.

## Theme variables

Cloudroom sets these on `:root`. They follow light and dark mode live.

- Text: `--foreground`, `--muted-foreground`, `--subtle-foreground`
- Surfaces: `--background`, `--card`, `--muted`, `--accent`,
  `--surface-raised`, `--surface-recessed`, `--border`
- Brand: `--primary` (electric lime), `--primary-foreground`, `--ring`
- Status: `--success`, `--success-foreground`, `--warning`, `--warning-text`,
  `--destructive`, `--destructive-text`, `--attention`
- Tints: `--surface-selected`, `--surface-destructive`, `--surface-attention`
- Charts: `--chart-1` (lime) to `--chart-6`; `--chart-2` is blue
- Type and shape: `--font-sans`, `--font-mono`, `--font-size`,
  `--line-height`, `--radius`

## Patterns

[example.html](example.html) is a complete fix report. Copy what fits: step
tabs, a bar timeline with an axis, before and after chip flows, a pipeline with
mono IDs, a commit list, and "Still open" and "Needs you" cards.

## Check it

If a headless browser is available, screenshot the page at 720px and 360px
wide before you show it. Fix overflow, clipping, and wrapping. The theme
variables exist only inside Cloudroom, so judge layout there, not colors.
