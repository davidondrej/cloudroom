import { useState } from "react";
import { search, type Snippet } from "./library.ts";
import { argumentFields } from "./template.ts";
import type { View } from "./service.ts";
export type Screen = "search" | "create" | "import" | "export";
export type Scope = "personal" | "organization";
export type Entry = { row: Snippet; scope: Scope };
type Run = (argv: string[], scope?: Scope) => Promise<unknown>;
export const button =
  "rounded border px-2 py-1 text-sm hover:bg-muted disabled:opacity-50";
const field = "w-full rounded border bg-background px-2 py-1.5 text-sm";

export function LibraryPanel({
  view,
  entries,
  navigate,
  choose,
  edit,
  run,
}: {
  view: View;
  entries: Entry[];
  navigate: (s: Screen) => void;
  choose: (row: Snippet, copy?: boolean) => void;
  edit: (e: Entry) => void;
  run: Run;
}) {
  const [query, setQuery] = useState(""),
    [tag, setTag] = useState(""),
    [index, setIndex] = useState(0);
  const owners = new Map(entries.map((e) => [e.row, e]));
  const ranked = search(
    entries.map((e) => e.row),
    query,
  ).filter((s) => !tag || s.tags.includes(tag));
  const selected = Math.min(index, ranked.length - 1);
  return (
    <>
      <input
        autoFocus
        className={field}
        aria-label="Search snippets"
        placeholder="Search snippets…"
        value={query}
        onChange={(e) => {
          setIndex(0);
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && ranked[selected]) {
            e.preventDefault();
            choose(ranked[selected]);
          }
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && ranked.length) {
            e.preventDefault();
            const i =
              (selected + (e.key === "ArrowDown" ? 1 : -1) + ranked.length) %
              ranked.length;
            setIndex(i);
            document
              .getElementById("snippet-result-" + i)
              ?.scrollIntoView({ block: "nearest" });
          }
        }}
      />
      <div className="flex flex-wrap gap-2">
        {(["create", "import", "export"] as const).map((s) => (
          <button
            className={button + " capitalize"}
            key={s}
            onClick={() => navigate(s)}
          >
            {s}
          </button>
        ))}
        <select
          aria-label="Filter by tag"
          value={tag}
          onChange={(e) => {
            setIndex(0);
            setTag(e.target.value);
          }}
        >
          <option value="">All tags</option>
          {[...new Set(entries.flatMap((e) => e.row.tags))].sort().map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      {!ranked.length && (
        <p className="text-sm text-muted-foreground">No snippets found.</p>
      )}
      {ranked.map((row, i) => {
        const entry = owners.get(row)!;
        const command = (name: string) =>
          void run([name, row.id, "--revision", row.revision], entry.scope);
        return (
          <div
            id={"snippet-result-" + i}
            key={entry.scope + row.id}
            className={
              "space-y-1 rounded border-b p-2 " +
              (i === selected ? "bg-muted" : "")
            }
          >
            <button
              className="block w-full text-left font-medium"
              onClick={() => choose(row)}
            >
              {row.pinned ? "★ " : ""}
              {row.name}
            </button>
            <p className="text-xs text-muted-foreground">
              {[row.keyword, entry.scope, ...row.tags]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="line-clamp-2 whitespace-pre-wrap text-sm">
              {row.text}
            </p>
            <div className="flex flex-wrap gap-3 text-xs">
              <button onClick={() => choose(row, true)}>Copy</button>
              <button onClick={() => edit(entry)}>Edit</button>
              <button onClick={() => command(row.pinned ? "unpin" : "pin")}>
                {row.pinned ? "Unpin" : "Pin"}
              </button>
              <button onClick={() => command("duplicate")}>Duplicate</button>
              {entry.scope === "personal" &&
                view.organization &&
                !view.team.some((s) => s.id === row.id) && (
                  <button onClick={() => command("share")}>
                    Share with Organization
                  </button>
                )}
            </div>
          </div>
        );
      })}
      <details>
        <summary>Settings</summary>
        <div className="space-y-2 py-2 text-sm">
          <label className="block">
            Expand keywords{" "}
            <select
              value={view.mode}
              onChange={(e) => void run(["settings", "--mode", e.target.value])}
            >
              <option value="immediate">Immediately</option>
              <option value="keep">After delimiter, keep it</option>
              <option value="discard">After delimiter, discard it</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="block">
            <input
              type="checkbox"
              checked={view.withinWords}
              onChange={(e) =>
                void run([
                  "settings",
                  "--within-words",
                  String(e.target.checked),
                ])
              }
            />{" "}
            Expand within words
          </label>
          <label className="block">
            <input
              type="checkbox"
              checked={view.clipboardHistory}
              onChange={(e) =>
                void run([
                  "settings",
                  "--remember-clipboard",
                  String(e.target.checked),
                ])
              }
            />{" "}
            Remember the last 20 chat clipboard items in this session
          </label>
          <label className="block">
            <input
              type="checkbox"
              checked={view.sync}
              onChange={(e) =>
                void run(["sync", e.target.checked ? "on" : "off"])
              }
            />{" "}
            Sync personal snippets across devices
          </label>
        </div>
      </details>
    </>
  );
}
export function SnippetForm({
  entry,
  initialText,
  run,
}: {
  entry: Entry | null;
  initialText: string;
  run: Run;
}) {
  const row = entry?.row;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void run(
          [
            ...(row
              ? ["update", row.id, "--revision", row.revision]
              : ["create"]),
            "--name",
            String(f.get("name")),
            "--text",
            String(f.get("text")),
            "--keyword",
            String(f.get("keyword")),
            "--tags",
            JSON.stringify(
              String(f.get("tags"))
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            ),
          ],
          entry?.scope,
        );
      }}
    >
      <label className="block">
        Name
        <input
          autoFocus
          required
          maxLength={256}
          name="name"
          className={field}
          defaultValue={row?.name}
        />
      </label>
      <label className="block">
        Keyword
        <input name="keyword" className={field} defaultValue={row?.keyword} />
      </label>
      <label className="block">
        Tags
        <input
          name="tags"
          className={field}
          defaultValue={row?.tags.join(", ")}
        />
      </label>
      <label className="block">
        Snippet text
        <textarea
          required
          name="text"
          className={field}
          rows={8}
          defaultValue={row?.text ?? initialText}
        />
      </label>
      <button className={button}>Save snippet</button>
      {row && (
        <button
          type="button"
          className={button}
          onClick={() => {
            if (window.confirm("Delete this snippet?"))
              void run(
                ["delete", row.id, "--revision", row.revision],
                entry.scope,
              );
          }}
        >
          Delete
        </button>
      )}
    </form>
  );
}
export function Arguments({
  row,
  library,
  copy,
  submit,
}: {
  row: Snippet;
  library: Snippet[];
  copy?: boolean;
  submit: (values: Record<string, string>) => void;
}) {
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit(
          Object.fromEntries(new FormData(e.currentTarget)) as Record<
            string,
            string
          >,
        );
      }}
    >
      {argumentFields(row.text, library).map((f, i) => (
        <label className="block" key={f.name}>
          {f.name}
          {f.choices.length ? (
            <select
              className={field}
              required
              autoFocus={i === 0}
              name={f.name}
              defaultValue={f.initial}
            >
              <option value="">Choose…</option>
              {f.choices.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          ) : (
            <input
              className={field}
              required
              autoFocus={i === 0}
              name={f.name}
              defaultValue={f.initial}
            />
          )}
        </label>
      ))}
      <button className={button}>{copy ? "Copy" : "Insert"}</button>
    </form>
  );
}
export function Transfer({
  screen,
  team,
  run,
}: {
  screen: "import" | "export";
  team: boolean;
  run: Run;
}) {
  const [scope, setScope] = useState<Scope>("personal");
  return (
    <>
      <label>
        Library{" "}
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
        >
          <option value="personal">Personal</option>
          {team && <option value="organization">Organization</option>}
        </select>
      </label>
      {screen === "export" ? (
        <button className={button} onClick={() => void run(["export"], scope)}>
          Download Raycast JSON
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const file = new FormData(e.currentTarget).get("file");
            if (file instanceof File)
              void file
                .text()
                .then((data) => run(["import", "--data", data], scope));
          }}
        >
          <label>
            Raycast JSON file
            <input
              name="file"
              type="file"
              required
              accept=".json,application/json"
              className={field}
            />
          </label>
          <button className={button}>Import snippets</button>
        </form>
      )}
    </>
  );
}
