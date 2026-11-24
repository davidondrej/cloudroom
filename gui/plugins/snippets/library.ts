// Shared by the desktop plugin and the account API. The caller owns storage and permissions.
import { renderSnippet } from "./template.ts";

export interface Snippet {
  id: string;
  revision: string;
  name: string;
  text: string;
  keyword: string;
  tags: string[];
  pinned: boolean;
}
export type Library = Snippet[];
export const MAX_BYTES = 1024 * 1024 - 1;
export const commands = {
  list: "[query]",
  search: "<query>",
  get: "<id>",
  create: "--name NAME --text TEXT [--keyword KEYWORD]",
  update: "<id> [--name NAME] [--text TEXT] [--keyword KEYWORD] [--tags JSON]",
  delete: "<id>",
  duplicate: "<id>",
  pin: "<id>",
  unpin: "<id>",
  tag: "<id> --tags JSON",
  render: "<id> [--args JSON] [--clipboard TEXT | --clipboard-history JSON]",
  import: "--data JSON | --file PATH | --data-stdin",
  settings:
    "[--mode immediate|keep|discard|off] [--within-words true|false] [--remember-clipboard true|false]",
  export: "",
  share: "<id>",
  sync: "on | off | status",
} as const;

export function parseCommand(argv: string[]) {
  const rest = argv;
  const options: Record<string, string> = Object.create(null);
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === "--json") {
      options.json = "true";
      continue;
    }
    if (!key.startsWith("--")) {
      positionals.push(key);
      continue;
    }
    if (
      ![
        "--name",
        "--text",
        "--keyword",
        "--tags",
        "--args",
        "--clipboard",
        "--clipboard-history",
        "--remember-clipboard",
        "--data",
        "--scope",
        "--revision",
        "--mode",
        "--within-words",
      ].includes(key) ||
      rest[i + 1] === undefined
    ) {
      throw new Error("Unknown or incomplete option: " + key);
    }
    options[key.slice(2)] = rest[++i];
  }
  const scope = options.scope ?? "personal";
  if (scope !== "personal" && scope !== "organization")
    throw new Error("Choose personal or organization scope.");
  const action = positionals.shift() ?? "list";
  if (!Object.hasOwn(commands, action))
    throw new Error("Unknown snippet command: " + action);
  if (positionals.length > 1)
    throw new Error("Quote the name or search terms as one argument.");
  return {
    action: action as keyof typeof commands,
    options,
    target: positionals[0] ?? "",
    scope,
  };
}
export type Command = ReturnType<typeof parseCommand>;

function fields(value: unknown) {
  if (!value || typeof value !== "object")
    throw new Error("Expected a snippet object.");
  const {
    name,
    text,
    keyword = "",
    tags = [],
  } = value as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim() || name.length > 256)
    throw new Error("Enter a snippet name of up to 256 characters.");
  if (typeof text !== "string" || !text || text.length > 65536)
    throw new Error("Enter snippet text of up to 65,536 characters.");
  if (
    typeof keyword !== "string" ||
    keyword.length > 128 ||
    /[\s`'"‘’“”]/u.test(keyword)
  )
    throw new Error("Use a keyword without spaces or quotes.");
  if (
    !Array.isArray(tags) ||
    tags.length > 64 ||
    tags.some((tag) => typeof tag !== "string" || tag.length > 128)
  )
    throw new Error("Tags must be a list of short names.");
  return {
    name: name.trim(),
    text,
    keyword,
    tags: [
      ...new Set((tags as string[]).map((tag) => tag.trim()).filter(Boolean)),
    ],
  };
}

export function search(items: Library, query: string) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/);
  return items
    .filter((item) =>
      words.every((word) =>
        [item.name, item.keyword, item.text, ...item.tags].some((s) =>
          s.toLocaleLowerCase().includes(word),
        ),
      ),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name),
    );
}
export function findSnippet(items: Library, id: string) {
  const exact = items.find((s) => s.id === id);
  if (exact) return exact;
  const matches = items.filter((s) => s.name === id || s.keyword === id);
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Multiple snippets match. Use an ID."
        : "Snippet not found.",
    );
  return matches[0];
}
function portable({ name, text, keyword, tags }: Snippet) {
  return {
    name,
    text,
    ...(keyword && { keyword }),
    ...(tags.length && { tags }),
  };
}
function importSignature(row: ReturnType<typeof fields>) {
  return JSON.stringify([
    row.name,
    row.text,
    row.keyword,
    [...row.tags].sort(),
  ]);
}
export function visibleLibrary(personal: Library, team: Library) {
  return [...personal, ...team];
}
export async function applyCommand(
  items: Library,
  cmd: Command,
  references: Library = items,
): Promise<{ items: Library; result: unknown }> {
  const { action, options, target } = cmd;
  let next = items;
  let result: unknown;
  function fresh(
    data: ReturnType<typeof fields>,
    id = crypto.randomUUID() as string,
  ): Snippet {
    return { ...data, id, revision: crypto.randomUUID(), pinned: false };
  }
  switch (action) {
    case "list":
    case "search":
      result = search(items, target);
      break;
    case "export":
      result = items.map(portable);
      break;
    case "create": {
      const row = fresh(
        fields({ ...options, tags: JSON.parse(options.tags ?? "[]") }),
      );
      next = [...items, row];
      result = row;
      break;
    }
    case "import": {
      const data: unknown = JSON.parse(options.data ?? "null");
      if (!Array.isArray(data))
        throw new Error("Expected a Raycast JSON array.");
      const existing = new Set(items.map(importSignature));
      const ids = new Set(items.map((row) => row.id));
      const keywords = new Set(items.map((row) => row.keyword).filter(Boolean));
      const added: Snippet[] = [];
      const conflicts = new Set<string>();
      for (const raw of data) {
        const entry = fields(raw),
          signature = importSignature(entry);
        if (existing.has(signature)) continue;
        const hash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(signature),
        );
        const id = Array.from(new Uint8Array(hash), (n) =>
          n.toString(16).padStart(2, "0"),
        ).join("");
        if (ids.has(id)) continue;
        if (entry.keyword && keywords.has(entry.keyword))
          conflicts.add(entry.keyword);
        existing.add(signature);
        ids.add(id);
        keywords.add(entry.keyword);
        added.push(fresh(entry, id));
      }
      if (added.length) next = [...items, ...added];
      result = {
        added: added.length,
        skipped: data.length - added.length,
        conflicts: [...conflicts],
      };
      break;
    }
    default: {
      const row = findSnippet(items, target);
      if (options.revision && row.revision !== options.revision)
        throw new Error("Snippet changed. Reopen it before saving.");
      if (action === "get") {
        result = row;
        break;
      }
      if (action === "render") {
        const history =
          options["clipboard-history"] === undefined
            ? undefined
            : JSON.parse(options["clipboard-history"]);
        if (
          history !== undefined &&
          (!Array.isArray(history) ||
            history.some((item) => typeof item !== "string"))
        )
          throw new Error(
            "Clipboard history must be a JSON array of strings, newest first.",
          );
        result = renderSnippet(row.text, references, {
          clipboardHistory: history,
          values: JSON.parse(options.args ?? "{}"),
          clipboard: options.clipboard ?? "",
        }).text;
        break;
      }
      if (action === "delete") {
        next = items.filter((s) => s.id !== row.id);
        result = { deleted: row.id };
        break;
      }
      if (action === "duplicate") {
        const copy = fresh({ ...row, name: row.name + " copy", keyword: "" });
        next = [...items, copy];
        result = copy;
        break;
      }
      if (!["update", "pin", "unpin", "tag"].includes(action))
        throw new Error("Unavailable command: " + action);
      const updated = {
        ...row,
        ...fields({
          ...row,
          ...options,
          tags:
            options.tags === undefined ? row.tags : JSON.parse(options.tags),
        }),
        pinned: action === "pin" || (action !== "unpin" && row.pinned),
        revision: crypto.randomUUID(),
      };
      next = items.map((s) => (s.id === row.id ? updated : s));
      result = updated;
    }
  }
  if (
    next !== items &&
    new TextEncoder().encode(JSON.stringify(next)).length > MAX_BYTES
  )
    throw new Error("Snippet library exceeds 1 MiB.");
  return { items: next, result };
}

export function readLibrary(value: unknown): Library {
  if (!Array.isArray(value)) throw new Error("Expected a snippet library.");
  const ids = new Set<string>();
  return value.map((entry) => {
    const data = fields(entry);
    if (
      typeof entry.id !== "string" ||
      !/^[a-f0-9-]{36,64}$/i.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.revision !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(entry.revision) ||
      typeof entry.pinned !== "boolean"
    )
      throw new Error("Invalid snippet record.");
    ids.add(entry.id);
    return {
      ...data,
      id: entry.id,
      revision: entry.revision,
      pinned: entry.pinned,
    };
  });
}
// Apply only edits made since this device last synchronized. Keep both edits when the same record changed.
export function mergeLibraries(base: Library, local: Library, remote: Library) {
  const previous = new Map(base.map((s) => [s.id, s])),
    current = new Map(local.map((s) => [s.id, s]));
  const merged = new Map(remote.map((s) => [s.id, s]));
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const old = previous.get(id),
      mine = current.get(id),
      theirs = merged.get(id);
    if (
      old?.revision === mine?.revision ||
      mine?.revision === theirs?.revision ||
      (mine &&
        theirs &&
        mine.pinned === theirs.pinned &&
        importSignature(mine) === importSignature(theirs))
    )
      continue;
    if (old?.revision === theirs?.revision) {
      if (mine) merged.set(id, mine);
      else merged.delete(id);
    } else if (mine) {
      // The revision is stable across retries, including a successful write whose reply was lost.
      if (!merged.has(mine.revision))
        merged.set(mine.revision, {
          ...mine,
          id: mine.revision,
          name: mine.name.slice(0, 239) + " (conflict copy)",
          keyword: "",
        });
    }
  }
  return [...merged.values()];
}
