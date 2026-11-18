import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { AttachmentFileIcon } from "@/components/promptbox/AttachmentPreview";

type SelectionChangeListener = (selectedPaths: readonly string[]) => void;

interface TreeNode {
  /** Null for files. */
  children: TreeNode[] | null;
  name: string;
  /** Files keep their input path; folders end in "/", like "docs/". */
  path: string;
  sortKey: (string | number)[];
}

interface TreeRow {
  depth: number;
  expanded: boolean;
  folder: boolean;
  name: string;
  path: string;
  posInSet: number;
  setSize: number;
}

interface TreeSnapshot {
  rows: readonly TreeRow[];
  selected: ReadonlySet<string>;
}

function createNode(name: string, path: string, folder: boolean): TreeNode {
  const sortKey = (name.toLowerCase().match(/\d+|\D+/g) ?? []).map((token) =>
    /^\d/.test(token) ? Number(token) : token,
  );
  return { children: folder ? [] : null, name, path, sortKey };
}

// Folders first, then natural order ignoring case: "v2" before "v10".
function compareNodes(left: TreeNode, right: TreeNode): number {
  if ((left.children === null) !== (right.children === null)) {
    return left.children === null ? 1 : -1;
  }
  const length = Math.min(left.sortKey.length, right.sortKey.length);
  for (let index = 0; index < length; index++) {
    const a = left.sortKey[index];
    const b = right.sortKey[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    if (String(a) !== String(b)) return String(a) < String(b) ? -1 : 1;
  }
  if (left.sortKey.length !== right.sortKey.length) {
    return left.sortKey.length < right.sortKey.length ? -1 : 1;
  }
  const a = left.name.toLowerCase();
  const b = right.name.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  return left.name === right.name ? 0 : left.name < right.name ? -1 : 1;
}

function buildTree(paths: readonly string[]) {
  const root = createNode("", "", true);
  const folders = new Map([["", root]]);
  const known = new Set<string>();
  for (const path of paths) {
    const names = path.split("/").filter((name) => name.length > 0);
    let parent = root;
    for (const [index, name] of names.entries()) {
      if (index === names.length - 1) {
        if (known.has(path)) break;
        known.add(path);
        parent.children?.push(createNode(name, path, false));
        break;
      }
      const folderPath = `${parent.path}${name}/`;
      let folder = folders.get(folderPath);
      if (folder === undefined) {
        folder = createNode(name, folderPath, true);
        folders.set(folderPath, folder);
        known.add(folderPath);
        parent.children?.push(folder);
      }
      parent = folder;
    }
  }
  for (const folder of folders.values()) folder.children?.sort(compareNodes);
  return { known, root };
}

function onlyChildFolder(node: TreeNode): TreeNode | undefined {
  const [only, next] = node.children ?? [];
  return only?.children && next === undefined ? only : undefined;
}

function collectRows(
  folder: TreeNode,
  expanded: ReadonlySet<string>,
  depth = 0,
  rows: TreeRow[] = [],
): TreeRow[] {
  const children = folder.children ?? [];
  for (const [index, child] of children.entries()) {
    // A folder chain with one folder per level is one row: "2026 / q3".
    let last = child;
    const names = [child.name];
    for (let next = onlyChildFolder(last); next; next = onlyChildFolder(last)) {
      last = next;
      names.push(next.name);
    }
    const open = last.children !== null && expanded.has(last.path);
    rows.push({
      depth,
      expanded: open,
      folder: last.children !== null,
      name: names.join(" / "),
      path: last.path,
      posInSet: index + 1,
      setSize: children.length,
    });
    if (open) collectRows(last, expanded, depth + 1, rows);
  }
  return rows;
}

export function createThreadStorageTreeModel(
  onSelectionChange: SelectionChangeListener,
) {
  const listeners = new Set<() => void>();
  let tree = buildTree([]);
  let expanded: ReadonlySet<string> = new Set();
  let snapshot: TreeSnapshot = { rows: [], selected: new Set() };

  const update = (selected: ReadonlySet<string>, rebuildRows: boolean) => {
    const previous = snapshot.selected;
    const selectionChanged =
      selected.size !== previous.size ||
      [...selected].some((path) => !previous.has(path));
    if (!selectionChanged && !rebuildRows) return;
    snapshot = {
      rows: rebuildRows ? collectRows(tree.root, expanded) : snapshot.rows,
      selected,
    };
    for (const listener of listeners) listener();
    if (selectionChanged) onSelectionChange([...selected]);
  };

  const getSelectedPaths = () => [...snapshot.selected];

  const toggleExpanded = (path: string) => {
    const next = new Set(expanded);
    if (!next.delete(path)) next.add(path);
    expanded = next;
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getSelectedPaths,
    /** Replaces every path. Folders close, except initialExpandedPaths and their parents. */
    resetPaths(
      paths: readonly string[],
      options: { initialExpandedPaths?: readonly string[] } = {},
    ) {
      tree = buildTree(paths);
      const nextExpanded = new Set<string>();
      for (const path of options.initialExpandedPaths ?? []) {
        const names = path.split("/").filter((name) => name.length > 0);
        if (!tree.known.has(`${names.join("/")}/`)) continue;
        for (const index of names.keys()) {
          nextExpanded.add(`${names.slice(0, index + 1).join("/")}/`);
        }
      }
      expanded = nextExpanded;
      update(
        new Set(getSelectedPaths().filter((path) => tree.known.has(path))),
        true,
      );
    },
    getItem(path: string) {
      if (!tree.known.has(path)) return null;
      return {
        select: () => update(new Set([...getSelectedPaths(), path]), false),
        deselect: () =>
          update(
            new Set(getSelectedPaths().filter((other) => other !== path)),
            false,
          ),
      };
    },
    toggle(path: string) {
      toggleExpanded(path);
      update(snapshot.selected, true);
    },
    /** A click, Enter or Space: select only this row, and open or close a folder. */
    activate(path: string) {
      const folder = path.endsWith("/");
      if (folder) toggleExpanded(path);
      update(new Set([path]), folder);
    },
    cleanUp() {
      listeners.clear();
    },
  };
}

export type ThreadStorageTreeModel = ReturnType<
  typeof createThreadStorageTreeModel
>;

const ROW_HEIGHT = 24;
const INDENT = 18;
const OVERSCAN = 8;

export function ThreadStorageFileTree({
  model,
}: {
  model: ThreadStorageTreeModel;
}) {
  const { rows, selected } = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
  );
  const [activePath, setActivePath] = useState<string | null>(null);
  const [viewport, setViewport] = useState(() => ({
    height: window.innerHeight,
    top: 0,
  }));
  const treeRef = useRef<HTMLDivElement>(null);
  const rowId = useId();

  useEffect(() => {
    const tree = treeRef.current;
    if (tree === null) return;
    const observer = new ResizeObserver(() =>
      setViewport({ height: tree.clientHeight, top: tree.scrollTop }),
    );
    observer.observe(tree);
    return () => observer.disconnect();
  }, []);

  let activeIndex = rows.findIndex((row) => row.path === activePath);
  if (activeIndex < 0) {
    activeIndex = Math.max(
      0,
      rows.findIndex((row) => selected.has(row.path)),
    );
  }
  // Render only the rows in view. The browser clamps scrollTop when rows go away.
  const top = Math.min(
    viewport.top,
    Math.max(0, rows.length * ROW_HEIGHT - viewport.height),
  );
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    rows.length,
    Math.ceil((top + viewport.height) / ROW_HEIGHT) + OVERSCAN,
  );
  const indices = Array.from({ length: last - first }, (_, i) => first + i);
  if (rows.length > 0 && (activeIndex < first || activeIndex >= last)) {
    indices.push(activeIndex);
  }

  const moveTo = (index: number) => {
    const row = rows[index];
    const tree = treeRef.current;
    if (row === undefined || tree === null) return;
    setActivePath(row.path);
    const rowTop = index * ROW_HEIGHT;
    tree.scrollTop = Math.min(
      Math.max(tree.scrollTop, rowTop + ROW_HEIGHT - tree.clientHeight),
      rowTop,
    );
    setViewport({ height: tree.clientHeight, top: tree.scrollTop });
  };

  const activate = (path: string) => {
    setActivePath(path);
    model.activate(path);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[activeIndex];
    if (row === undefined) return;
    switch (event.key) {
      case "ArrowDown":
        moveTo(activeIndex + 1);
        break;
      case "ArrowUp":
        moveTo(activeIndex - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.folder && !row.expanded) model.toggle(row.path);
        else moveTo(activeIndex + 1);
        break;
      case "ArrowLeft": {
        if (row.expanded) {
          model.toggle(row.path);
          break;
        }
        let parent = activeIndex - 1;
        while (parent >= 0 && rows[parent].depth >= row.depth) parent--;
        moveTo(parent);
        break;
      }
      case "Enter":
      case " ":
        activate(row.path);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={treeRef}
      role="tree"
      tabIndex={0}
      aria-label="Thread storage file tree"
      aria-activedescendant={
        rows.length > 0 ? `${rowId}-${activeIndex}` : undefined
      }
      className="group/tree h-full min-h-0 overflow-y-auto outline-none"
      onKeyDown={handleKeyDown}
      onScroll={(event) =>
        setViewport({
          height: event.currentTarget.clientHeight,
          top: event.currentTarget.scrollTop,
        })
      }
    >
      <div className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
        {indices.map((index) => {
          const row = rows[index];
          if (row === undefined) return null;
          const isSelected = selected.has(row.path);
          const dot = row.folder ? -1 : row.name.lastIndexOf(".");
          return (
            <div
              key={row.path}
              id={`${rowId}-${index}`}
              role="treeitem"
              aria-label={row.name}
              aria-level={row.depth + 1}
              aria-posinset={row.posInSet}
              aria-setsize={row.setSize}
              aria-expanded={row.folder ? row.expanded : undefined}
              aria-selected={isSelected}
              className={cn(
                "absolute inset-x-0 flex cursor-pointer items-center gap-1 rounded-sm pr-1.5 font-sans text-xs text-foreground select-none hover:bg-muted/45",
                isSelected && "bg-accent/65 hover:bg-accent/65",
                index === activeIndex &&
                  "group-focus-visible/tree:ring-1 group-focus-visible/tree:ring-ring group-focus-visible/tree:ring-inset",
              )}
              style={{
                height: ROW_HEIGHT,
                paddingLeft: 6 + row.depth * INDENT,
                top: index * ROW_HEIGHT,
              }}
              onClick={() => activate(row.path)}
            >
              {Array.from({ length: row.depth }, (_, level) => (
                <span
                  key={level}
                  aria-hidden
                  className="absolute inset-y-0 border-l border-muted-foreground/25 opacity-0 transition-opacity group-hover/tree:opacity-75"
                  style={{ left: 13.5 + level * INDENT }}
                />
              ))}
              <span className="flex w-4 shrink-0 justify-center text-muted-foreground">
                {row.folder ? (
                  <Icon
                    name={row.expanded ? "ChevronDown" : "ChevronRight"}
                    className="size-3.5"
                  />
                ) : (
                  <AttachmentFileIcon name={row.name} />
                )}
              </span>
              {/* A long file name keeps its extension in view. */}
              <span className="flex min-w-0">
                <span className="truncate">
                  {dot > 0 ? row.name.slice(0, dot) : row.name}
                </span>
                {dot > 0 ? (
                  <span className="shrink-0">{row.name.slice(dot)}</span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
