import { useState } from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";

// Claude Code answers `/context` with a fixed markdown report (Local and Cloud alike).
// We parse that report and draw it like the CLI: a square grid, a legend, and item lists.

interface ReportRow {
  label: string;
  detail: string | null;
  tokens: number;
  tokensLabel: string;
}

interface ReportCategory {
  name: string;
  tokens: number;
  tokensLabel: string;
  percentLabel: string;
}

export interface ClaudeContextReport {
  model: string;
  usedLabel: string;
  windowLabel: string;
  percentLabel: string;
  windowTokens: number;
  categories: ReportCategory[];
  sections: { title: string; rows: ReportRow[] }[];
}

const CATEGORY_TABLE = "estimated usage by category";

function parseTokens(value: string): number {
  const match = /^~?([\d.]+)\s*([km]?)/iu.exec(value.trim());
  if (!match) return 0;
  const scale = { k: 1_000, m: 1_000_000 }[match[2]!.toLowerCase()] ?? 1;
  return Math.round(Number(match[1]) * scale);
}

function tableRows(block: string): string[][] {
  return block
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/gu, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/u.test(cell)))
    .slice(1);
}

export function parseClaudeContextReport(
  text: string,
): ClaudeContextReport | null {
  if (!text.startsWith("## Context Usage")) return null;
  const model = /^\*\*Model:\*\*\s*(.+?)\s*$/mu.exec(text)?.[1];
  const tokens =
    /^\*\*Tokens:\*\*\s*(\S+)\s*\/\s*(\S+)\s*\((\d+(?:\.\d+)?%)\)/mu.exec(text);
  if (!model || !tokens) return null;
  let categories: ReportCategory[] = [];
  const sections: ClaudeContextReport["sections"] = [];
  for (const block of text.split(/^### /mu).slice(1)) {
    const title = block.slice(0, block.indexOf("\n")).trim();
    const rows = tableRows(block);
    if (title.toLowerCase() === CATEGORY_TABLE) {
      categories = rows
        .filter((cells) => cells.length >= 3)
        .map(([name, tokensLabel, percentLabel]) => ({
          name: name!,
          tokens: parseTokens(tokensLabel!),
          tokensLabel: tokensLabel!,
          percentLabel: percentLabel!,
        }));
      continue;
    }
    // Memory files list "Type | Path | Tokens"; every other table leads with the item name.
    const pathFirst = /^type$/iu.test(
      block
        .split("\n")
        .find((line) => line.trim().startsWith("|"))
        ?.split("|")[1]
        ?.trim() ?? "",
    );
    const parsed = rows
      .filter((cells) => cells.length >= 2)
      .map((cells) => {
        const tokensLabel = cells[cells.length - 1]!;
        const middle = cells.length > 2 ? cells[1]! : null;
        return {
          label: pathFirst && middle ? middle : cells[0]!,
          detail: pathFirst ? cells[0]! : middle,
          tokens: parseTokens(tokensLabel),
          tokensLabel,
        };
      });
    if (parsed.length > 0) sections.push({ title, rows: parsed });
  }
  if (categories.length === 0) return null;
  return {
    model,
    usedLabel: tokens[1]!,
    windowLabel: tokens[2]!,
    percentLabel: tokens[3]!,
    windowTokens: parseTokens(tokens[2]!),
    categories,
    sections,
  };
}

type CategoryKind = "used" | "free" | "buffer" | "deferred";

function categoryKind(name: string): CategoryKind {
  const lower = name.toLowerCase();
  if (lower.includes("(deferred)")) return "deferred";
  if (lower === "free space") return "free";
  if (lower.includes("compact buffer")) return "buffer";
  return "used";
}

function categoryColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith("system prompt")) return "var(--ansi-8)";
  if (lower.startsWith("system tools")) return "var(--ansi-4)";
  if (lower.startsWith("mcp")) return "var(--ansi-2)";
  if (lower.includes("agent")) return "var(--ansi-6)";
  if (lower.startsWith("memory")) return "var(--ansi-1)";
  if (lower.startsWith("skills")) return "var(--ansi-3)";
  if (lower.startsWith("messages")) return "var(--ansi-5)";
  return "var(--ansi-7)";
}

interface GridCell {
  kind: "used" | "partial" | "free" | "buffer";
  color?: string;
}

function gridCells(report: ClaudeContextReport): {
  columns: number;
  cells: GridCell[];
} {
  // Same shape as the CLI: 20x10 for 1M-token windows, 10x10 for smaller ones.
  const columns = report.windowTokens >= 500_000 ? 20 : 10;
  const total = columns * 10;
  const perCell = Math.max(report.windowTokens, 1) / total;
  const cells: GridCell[] = [];
  let buffer = 0;
  for (const category of report.categories) {
    const kind = categoryKind(category.name);
    if (kind === "buffer") buffer += Math.round(category.tokens / perCell);
    if (kind !== "used" || category.tokens <= 0) continue;
    const exact = category.tokens / perCell;
    const color = categoryColor(category.name);
    const full = Math.floor(exact);
    const rest = exact - full;
    for (let i = 0; i < full; i += 1) cells.push({ kind: "used", color });
    if (rest >= 0.7) cells.push({ kind: "used", color });
    else if (rest > 0) cells.push({ kind: "partial", color });
  }
  const used = cells.slice(0, total - buffer);
  while (used.length < total - buffer) used.push({ kind: "free" });
  for (let i = 0; i < buffer && used.length < total; i += 1)
    used.push({ kind: "buffer" });
  return { columns, cells: used };
}

const HATCH =
  "repeating-linear-gradient(135deg, var(--muted-foreground) 0 1px, transparent 1px 4px)";

function Swatch({ name }: { name: string }) {
  const kind = categoryKind(name);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-[2px]",
        (kind === "free" || kind === "deferred") &&
          "border border-dashed border-muted-foreground/60",
      )}
      style={
        kind === "used"
          ? { backgroundColor: categoryColor(name) }
          : kind === "buffer"
            ? { backgroundImage: HATCH, opacity: 0.6 }
            : undefined
      }
    />
  );
}

const PREVIEW_ROWS = 3;

// Paths keep their file name visible: "/Users/me/code/app/AGENTS.md" -> "app/AGENTS.md".
function shortLabel(label: string): string {
  if (!label.startsWith("/")) return label;
  return label.split("/").filter(Boolean).slice(-2).join("/");
}

export function ClaudeContextReportCard({
  report,
}: {
  report: ClaudeContextReport;
}) {
  const [expanded, setExpanded] = useState(false);
  const grid = gridCells(report);
  const hidden = report.sections.some(
    (section) => section.rows.length > PREVIEW_ROWS,
  );
  return (
    <div className="w-full overflow-hidden rounded-md border bg-card/40 p-4 font-mono text-xs leading-relaxed">
      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <div
          aria-hidden="true"
          className="grid shrink-0 content-start gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${grid.columns}, 0.7rem)` }}
        >
          {grid.cells.map((cell, index) => (
            <span
              key={index}
              className={cn(
                "size-[0.7rem] rounded-[2px]",
                cell.kind === "free" &&
                  "border border-dashed border-muted-foreground/30",
                cell.kind === "partial" && "opacity-50",
              )}
              style={
                cell.kind === "buffer"
                  ? { backgroundImage: HATCH, opacity: 0.5 }
                  : cell.color
                    ? { backgroundColor: cell.color }
                    : undefined
              }
            />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-foreground">Context usage</div>
          <div className="truncate text-muted-foreground">{report.model}</div>
          <div className="mb-3 mt-1 tabular-nums">
            <span className="font-semibold text-foreground">
              {report.usedLabel}
            </span>
            <span className="text-muted-foreground">
              {" "}
              / {report.windowLabel} tokens ({report.percentLabel})
            </span>
          </div>
          <div className="mb-1 italic text-muted-foreground">
            Estimated usage by category
          </div>
          {report.categories.map((category) => {
            const kind = categoryKind(category.name);
            return (
              <div
                key={category.name}
                className="flex items-center gap-2 py-px"
              >
                <Swatch name={category.name} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    kind === "used"
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {category.name}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {category.tokensLabel} · {category.percentLabel}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {report.sections.length > 0 ? (
        <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-x-6 gap-y-4 border-t pt-3">
          {report.sections.map((section) => {
            const rows = [...section.rows].sort((a, b) => b.tokens - a.tokens);
            const total = rows.reduce((sum, row) => sum + row.tokens, 0);
            return (
              <div key={section.title} className="min-w-0">
                <div className="font-semibold text-foreground">
                  {section.title}
                </div>
                <div className="mb-1 tabular-nums text-muted-foreground">
                  {rows.length} {rows.length === 1 ? "item" : "items"} · ~
                  {total >= 1_000 ? `${(total / 1_000).toFixed(1)}k` : total}{" "}
                  tokens
                </div>
                <div
                  className={cn(
                    expanded && rows.length > 12 && "max-h-64 overflow-y-auto",
                  )}
                >
                  {(expanded ? rows : rows.slice(0, PREVIEW_ROWS)).map(
                    (row, index) => (
                      <div
                        key={`${row.label}:${index}`}
                        className="flex gap-2 text-muted-foreground"
                        title={
                          row.detail
                            ? `${row.label} (${row.detail})`
                            : row.label
                        }
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {shortLabel(row.label)}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {row.tokensLabel}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {hidden ? (
        <button
          type="button"
          className="mt-3 cursor-pointer text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show fewer items ▴" : "Show all items ▾"}
        </button>
      ) : null}
    </div>
  );
}
