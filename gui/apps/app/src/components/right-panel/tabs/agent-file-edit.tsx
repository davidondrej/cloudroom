// Shows where the agent is writing while a turn edits the open file:
// a cursor with the agent's name after the last line it wrote, and grey
// lines below it until the turn ends. It moves once per saved edit.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  ThreadTimelineResponse,
  TimelineFileChange,
  TimelineRow,
} from "@cloudroom/server-contract";
import { useThread, useThreadTimeline } from "@/hooks/queries/thread-queries";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { Icon } from "@cloudroom/shared-ui/icon";
import { RightPanelFileTabIcon } from "./file-tab-visuals";

export interface AgentFileEdit {
  agentName: string;
  /** Text of the last line the agent wrote, or null if it only deleted. */
  lastLine: string | null;
}

const NEEDLE_CHARS = 40;

export const AgentFileEditContext = createContext<AgentFileEdit | null>(null);

/**
 * Last non-empty line the agent wrote: the last "+" line of a diff, or the
 * last line of a new file that came as plain text (how Codex reports adds).
 */
export function lastWrittenLine(change: TimelineFileChange): string | null {
  const lines = (change.diff ?? "").split("\n");
  const added = (line: string) =>
    line.startsWith("+") && !line.startsWith("+++");
  const isDiff = lines.some(added);
  if (!isDiff && change.kind !== "add") return null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (isDiff && !added(line)) continue;
    const text = isDiff ? line.slice(1) : line;
    if (text.trim() !== "") return text;
  }
  return null;
}

/** The rendered text of a Markdown source line, so it can be found on screen. */
export function visibleLineText(line: string): string {
  const cells = line.split("|").filter((cell) => cell.trim() !== "");
  return (line.trim().startsWith("|") ? (cells.at(-1) ?? "") : line)
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/u, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`~]/gu, "")
    .trim();
}

function findLastRow<T>(rows: readonly T[], match: (row: T) => boolean) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row !== undefined && match(row)) return row;
  }
  return undefined;
}

/**
 * The open file's latest edit in the turn that is still running, if any.
 * A turn gets its "turn" row only once it ends, so the running turn is the
 * newest turn id without one. `path` is workspace-relative, like the rows.
 */
export function findActiveFileEdit(
  rows: readonly TimelineRow[],
  path: string,
): { lastLine: string | null } | null {
  const turnId = findLastRow(rows, (row) => row.turnId !== null)?.turnId;
  if (
    !turnId ||
    rows.some((row) => row.kind === "turn" && row.turnId === turnId)
  )
    return null;
  const edit = findLastRow(
    rows,
    (row) =>
      row.kind === "work" &&
      row.workKind === "file-change" &&
      row.turnId === turnId &&
      row.change.path === path,
  );
  if (edit?.kind !== "work" || edit.workKind !== "file-change") return null;
  return { lastLine: lastWrittenLine(edit.change) };
}

export function useAgentFileEdit(
  threadId: string | null | undefined,
  path: string,
): AgentFileEdit | null {
  const id = threadId ?? "";
  const select = useCallback(
    (timeline: ThreadTimelineResponse) =>
      findActiveFileEdit(timeline.rows, path),
    [path],
  );
  // Read only what the open thread already loaded; never fetch from here.
  const timelineEdit = useThreadTimeline(id, { enabled: false, select }).data;
  const thread = useThread(id, { enabled: false }).data;
  const edit =
    thread?.runtime.displayStatus === "active" ? timelineEdit : undefined;
  const providers = useSystemProviders({ enabled: Boolean(edit) }).data;
  const providerId = thread?.providerId;
  const agentName =
    providers?.find((provider) => provider.id === providerId)?.displayName ||
    "Agent";
  const lastLine = edit?.lastLine;
  return useMemo(
    () => (lastLine === undefined ? null : { agentName, lastLine }),
    [agentName, lastLine],
  );
}

/** End of the last on-screen match of `needle`, as a collapsed range. */
function findTextEnd(root: HTMLElement, needle: string): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    text += node.nodeValue ?? "";
  }
  const index = text.lastIndexOf(needle);
  if (index < 0) return null;
  let remaining = index + needle.length;
  for (const node of nodes) {
    const length = node.nodeValue?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      return range;
    }
    remaining -= length;
  }
  return null;
}

interface CaretPosition {
  left: number;
  top: number;
  height: number;
}

export function AgentEditCursor({
  contentRef,
  contents,
}: {
  contentRef: RefObject<HTMLElement | null>;
  contents: string;
}) {
  const edit = useContext(AgentFileEditContext);
  const [caret, setCaret] = useState<CaretPosition | null>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const needle = visibleLineText(edit?.lastLine ?? "").slice(-NEEDLE_CHARS);

  useLayoutEffect(() => {
    const root = contentRef.current;
    const box = root?.parentElement;
    if (!root || !box || needle === "") {
      setCaret(null);
      return;
    }
    const place = () => {
      const rect = findTextEnd(root, needle)?.getClientRects()[0];
      const origin = box.getBoundingClientRect();
      setCaret(
        rect
          ? {
              left: rect.left - origin.left,
              top: rect.top - origin.top,
              height: rect.height,
            }
          : null,
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    return () => observer.disconnect();
  }, [contentRef, contents, needle]);

  // Follow the agent: bring the cursor into view whenever it moves. Reading
  // elsewhere doesn't move it, so scrolling away is left alone.
  const caretTop = caret?.top;
  useEffect(() => {
    if (caretTop === undefined) return;
    const frame = requestAnimationFrame(() =>
      caretRef.current?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [caretTop, needle]);

  if (!edit) return null;
  return (
    <>
      {caret ? (
        <span
          ref={caretRef}
          aria-hidden
          className="pointer-events-none absolute w-0.5 rounded-full bg-primary motion-safe:animate-pulse"
          style={{ left: caret.left + 2, top: caret.top, height: caret.height }}
        >
          <span className="absolute bottom-full left-0 mb-px whitespace-nowrap rounded-[5px] rounded-bl-none bg-primary px-1.5 py-0.5 text-[10.5px] font-semibold leading-none text-primary-foreground">
            {edit.agentName}
          </span>
        </span>
      ) : null}
      <div
        role="status"
        aria-label={`${edit.agentName} is writing`}
        className="mx-auto mt-4 grid max-w-[46rem] gap-3"
      >
        {["94%", "81%", "58%"].map((width) => (
          <div
            key={width}
            className="h-2 rounded-full bg-foreground/[0.08] motion-safe:animate-pulse"
            style={{ width }}
          />
        ))}
      </div>
    </>
  );
}

/** File tab icon that spins while the running turn edits this file. */
export function WorkspaceFileTabIcon({
  path,
  threadId,
}: {
  path: string;
  threadId: string;
}) {
  const edit = useAgentFileEdit(threadId, path);
  if (!edit) return <RightPanelFileTabIcon path={path} />;
  return (
    <Icon
      name="Spinner"
      className="size-3.5 animate-spin text-primary"
      aria-label={`${edit.agentName} is editing`}
    />
  );
}
