import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { visibleLibrary, type Snippet } from "./library.ts";
import {
  argumentFields,
  matchKeyword,
  renderSnippet,
  requiresClipboard,
} from "./template.ts";
import type { rpcContract } from "./server.ts";
import type { View } from "./service.ts";
import { useClipboardHistory } from "./clipboard.ts";
import { phoneSnippets } from "./phone.ts";

import {
  LibraryPanel,
  SnippetForm,
  Arguments,
  Transfer,
  button,
  type Screen,
  type Entry,
  type Scope,
} from "./panels.tsx";
interface Range {
  before: string;
  selected: boolean;
  selectedText: string;
  replace(remove: number, text: string, cursor?: number): boolean;
}
interface Use {
  row: Snippet;
  library: Snippet[];
  range?: Range;
  remove: number;
  suffix: string;
  copy?: boolean;
}
const openEvent = "cloudroom:snippets-open";
function open(
  screen: Screen,
  composer?: PluginComposerApi,
  threadId?: string | null,
) {
  window.dispatchEvent(
    new CustomEvent(openEvent, { detail: { screen, composer, threadId } }),
  );
}
function rangeOf(element: Element | null) {
  let range: Range | undefined;
  if (element?.isConnected)
    element.dispatchEvent(
      new CustomEvent("cloudroom:composer-text-range", {
        detail: (next: Range) => {
          range = next;
        },
      }),
    );
  return range;
}
function download(value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "snippets.json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Snippets() {
  const desktop = useRpc<typeof rpcContract>();
  const rpc = useMemo(
    () =>
      document.documentElement.dataset.cloudroomPhone === "true"
        ? phoneSnippets()
        : desktop,
    [desktop],
  );
  const [view, setView] = useState<View | null>(null),
    [screen, setScreen] = useState<Screen | null>(null);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [problem, setProblem] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<Use | null>(null);
  const lastEditor = useRef<Element | null>(null);
  const [target, setTarget] = useState<Range>();
  const [choices, setChoices] = useState<Use[]>([]);
  const openOwner = useRef<string | null>(null);
  const [origin] = useState(() => crypto.randomUUID());
  const [typingError, setTypingError] = useState("");
  useEffect(() => {
    if (!typingError) return;
    const timer = window.setTimeout(() => setTypingError(""), 5000);
    return () => window.clearTimeout(timer);
  }, [typingError]);
  const latest = useRef(0),
    lastRefresh = useRef(0);
  const acceptOwner = useCallback((owner: string | null) => {
    if (openOwner.current && openOwner.current !== owner) {
      setChoices([]);
      setEditing(null);
      setPrompt(null);
      setScreen(null);
      setTarget(undefined);
      setTypingError("");
    }
    openOwner.current = owner;
  }, []);
  const readView = useCallback(
    async (cloud: boolean) => {
      const version = ++latest.current;
      if (cloud) lastRefresh.current = Date.now();
      try {
        const local = await rpc.call("view", "local");
        if (version !== latest.current) return;
        acceptOwner(local.owner);
        setView((previous) =>
          previous?.owner === local.owner
            ? {
                ...previous,
                ...local,
                organization: previous.organization,
                team: previous.team,
              }
            : local,
        );
        if (cloud && local.owner !== "device") {
          const next = await rpc.call("view", "refresh");
          if (version === latest.current) {
            acceptOwner(next.owner);
            setView(next);
          }
        }
      } catch (error) {
        if (version === latest.current) {
          acceptOwner(null);
          setView(null);
          setProblem(String(error));
        }
      }
    },
    [rpc, acceptOwner],
  );
  const flight = useRef<Promise<void> | null>(null);
  const queued = useRef<boolean | null>(null);
  const refresh = useCallback(
    (cloud = true, changed = false) => {
      if (flight.current) {
        if (changed) queued.current = cloud || queued.current === true;
        return flight.current;
      }
      flight.current = (async () => {
        await readView(cloud);
        while (queued.current !== null) {
          const next = queued.current;
          queued.current = null;
          await readView(next);
        }
      })().finally(() => {
        flight.current = null;
      });
      return flight.current;
    },
    [readView],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useRealtime("changed", (payload) => {
    if (rpc !== desktop) return;
    const change = payload as { team?: boolean; origin?: string } | null;
    if (change?.origin !== origin) void refresh(change?.team ?? true, true);
  });
  const close = () => {
    setChoices([]);
    setScreen(null);
    setPrompt(null);
    setProblem("");
    setNotice("");
    setTypingError("");
  };
  const items = useCallback(() => {
    const entries: Entry[] = [
      ...(view?.team ?? []).map((row) => ({
        row,
        scope: "organization" as const,
      })),
      ...(view?.personal ?? []).map((row) => ({
        row,
        scope: "personal" as const,
      })),
    ];
    return entries;
  }, [view]);
  const library = useCallback(
    () => visibleLibrary(view?.personal ?? [], view?.team ?? []),
    [view],
  );
  const history = useClipboardHistory(
    view?.owner ?? null,
    view?.clipboardHistory ?? false,
  );
  async function perform(use: Use, args: Record<string, string>) {
    const needsClipboard = requiresClipboard(use.row.text, use.library);
    const clipboard = needsClipboard
      ? await navigator.clipboard.readText()
      : "";
    if (!view || view.owner !== openOwner.current)
      throw new Error("The account changed. Reopen Snippets.");
    const rendered = renderSnippet(use.row.text, use.library, {
      values: args,
      clipboard,
      clipboardHistory: history.read(clipboard),
    });
    if (needsClipboard) history.remember(clipboard);
    if (use.copy) {
      await navigator.clipboard.writeText(rendered.text);
      history.remember(rendered.text);
    } else if (use.range) {
      if (
        !use.range.replace(
          use.remove,
          rendered.text + use.suffix,
          rendered.cursor,
        )
      )
        throw new Error("The draft changed. Select the snippet again.");
    } else throw new Error("Open a chat to insert a snippet, or choose Copy.");
    close();
  }
  const begin = async (use: Use, fromTyping = false) => {
    try {
      const fields = argumentFields(use.row.text, use.library);
      if (fields.length) {
        setPrompt(use);
        setProblem("");
      } else await perform(use, {});
    } catch (error) {
      (fromTyping ? setTypingError : setProblem)(
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const beginRef = useRef(begin);
  useEffect(() => {
    beginRef.current = begin;
  });

  useEffect(() => {
    function show(event: Event) {
      const { screen, composer, threadId } = (
        event as CustomEvent<{
          screen: Screen;
          composer?: PluginComposerApi;
          threadId?: string | null;
        }>
      ).detail;
      const editors = [
        ...document.querySelectorAll("[data-cloudroom-composer]"),
      ].filter((el) => {
        const host = el.closest<HTMLElement>("[data-promptbox]");
        if (composer) return host?.dataset.composerKey === composer.key;
        return (
          el.getClientRects().length &&
          (threadId === undefined ||
            host?.dataset.composerThread === (threadId ?? ""))
        );
      });
      const focused = editors.find((el) => el === document.activeElement);
      const previous = editors.find((el) => el === lastEditor.current);
      setTarget(
        rangeOf(
          focused ?? previous ?? (editors.length === 1 ? editors[0] : null),
        ),
      );
      setChoices([]);
      setEditing(null);
      setProblem("");
      setNotice("");
      setPrompt(null);
      setScreen(screen);
      if (Date.now() - lastRefresh.current >= 60000) void refresh();
    }
    function focus(event: Event) {
      const el = event.target;
      if (!(el instanceof Element)) return;
      const editor =
        el.closest("[data-cloudroom-composer]") ??
        el
          .closest("[data-promptbox]")
          ?.querySelector("[data-cloudroom-composer]");
      if (editor) {
        lastEditor.current = editor;
        if (Date.now() - lastRefresh.current > 60000) void refresh();
      }
    }
    function visible() {
      if (!document.hidden && Date.now() - lastRefresh.current >= 60000)
        void refresh();
    }
    const signedOut = () => {
      localStorage.removeItem("cloudroom:snippets:session");
      latest.current++;
      acceptOwner(null);
      setView(null);
      if (rpc === desktop) void refresh(true, true);
    };
    const sessionChanged = (event: StorageEvent) => {
      if (rpc !== desktop && event.key === "cloudroom:snippets:session") {
        latest.current++;
        acceptOwner(null);
        setView(null);
        void refresh(true, true);
      }
    };
    window.addEventListener("storage", sessionChanged);
    const online = () => void refresh(true, true);
    window.addEventListener("cloudroom:signed-out", signedOut);
    window.addEventListener(openEvent, show);
    document.addEventListener("focusin", focus);
    document.addEventListener("pointerdown", focus);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("storage", sessionChanged);
      window.removeEventListener("cloudroom:signed-out", signedOut);
      window.removeEventListener(openEvent, show);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("pointerdown", focus);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, rpc, desktop, acceptOwner]);
  const followsCloud = !!(view?.sync || view?.organization);
  useEffect(() => {
    if (!followsCloud) return;
    const timer = window.setInterval(() => {
      if (!document.hidden && Date.now() - lastRefresh.current >= 60000)
        void refresh();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [followsCloud, refresh]);
  useEffect(() => {
    if (!view || view.mode === "off") return;
    const rows = library();
    let active = true;
    const scheduled = new Set<Element>();
    function typed(event: Event) {
      const el = event.target;
      if (!(el instanceof Element) || !el.matches("[data-cloudroom-composer]"))
        return;
      if (
        event instanceof InputEvent &&
        (event.isComposing ||
          ![
            "insertText",
            "insertReplacementText",
            "insertCompositionText",
            "insertParagraph",
            "insertLineBreak",
          ].includes(event.inputType))
      )
        return;
      if (scheduled.has(el)) return;
      scheduled.add(el);
      queueMicrotask(() => {
        scheduled.delete(el);
        if (!active || document.activeElement !== el) return;
        const range = rangeOf(el);
        if (!range || range.selected) return;
        const hit = matchKeyword(
          range.before,
          rows,
          view!.mode,
          view!.withinWords,
        );
        if (!hit) return;
        const use = {
          library: rows,
          range,
          remove: hit.remove,
          suffix: hit.suffix,
        };
        if (hit.choices.length) {
          setProblem("");
          setChoices(hit.choices.map((row) => ({ ...use, row })));
        } else void beginRef.current({ ...use, row: hit.snippet }, true);
      });
    }
    document.addEventListener("cloudroom:composer-break", typed);
    document.addEventListener("input", typed, false);
    document.addEventListener("compositionend", typed, false);
    return () => {
      active = false;
      document.removeEventListener("cloudroom:composer-break", typed);
      document.removeEventListener("input", typed, false);
      document.removeEventListener("compositionend", typed, false);
    };
  }, [view, library]);
  const run = (argv: string[], selected: Scope = "personal") => {
    if (!view) throw new Error("Wait for your library to load.");
    const result = rpc.call("run", {
      argv: [...argv, "--scope", selected],
      origin,
      owner: view.owner,
      organization: view.organization,
    });
    return result.then(async (value) => {
      if (argv[0] !== "export")
        await refresh(selected === "organization" || argv[0] === "share", true);
      return value;
    });
  };
  const busyRef = useRef(false);
  async function action(job: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setProblem("");
    setNotice("");
    try {
      await job();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const navigate = (next: Screen) => {
    setEditing(null);
    setChoices([]);
    setPrompt(null);
    setScreen(next);
    setProblem("");
    setNotice("");
  };
  const command = (argv: string[], scope: Scope = "personal") =>
    action(async () => {
      const result = await run(argv, scope);
      if (argv[0] === "export") {
        download(result);
        return;
      }
      if (screen === "create") navigate("search");
      if (argv[0] === "share") setNotice("Published to Organization.");
      if (argv[0] === "import") {
        const { added, skipped, conflicts } = result as {
          added: number;
          skipped: number;
          conflicts: string[];
        };
        navigate("search");
        setNotice(
          added +
            " added, " +
            skipped +
            " skipped." +
            (conflicts.length
              ? " Conflicting keywords: " + conflicts.join(", ")
              : ""),
        );
      }
    });
  if (!screen && !prompt && !choices.length)
    return typingError ? (
      <div
        role="status"
        className="pointer-events-none fixed bottom-4 right-4 z-50 rounded bg-background p-2 text-sm"
      >
        {typingError}
      </div>
    ) : null;
  const labels = {
    search: "Snippets",
    create: editing ? "Edit snippet" : "Create snippet",
    import: "Import snippets",
    export: "Export snippets",
  };
  return (
    <aside
      role="dialog"
      aria-label="Snippets"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
      className="pointer-events-auto fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col gap-3 overflow-y-auto border-l bg-background p-4 text-foreground shadow-lg"
    >
      <header className="flex items-center justify-between">
        <h2 className="font-semibold">
          {choices.length
            ? "Choose a snippet"
            : (prompt?.row.name ?? labels[screen ?? "search"])}
        </h2>
        <div className="flex gap-2">
          {screen !== "search" && (
            <button className={button} onClick={() => navigate("search")}>
              Back
            </button>
          )}
          <button className={button} onClick={close}>
            Close
          </button>
        </div>
      </header>
      {problem && <p role="alert">{problem}</p>}
      {notice && <p role="status">{notice}</p>}
      {view?.problem && <p role="status">{view.problem}</p>}
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        {choices.length ? (
          choices.map((use, i) => (
            <button
              key={i}
              className={button}
              onClick={() => {
                setChoices([]);
                void begin(use, true);
              }}
            >
              {use.row.name} ·{" "}
              {view?.team.includes(use.row) ? "Organization" : "Personal"}
              <span className="block line-clamp-2">{use.row.text}</span>
            </button>
          ))
        ) : prompt ? (
          <Arguments
            {...prompt}
            submit={(values) => void action(() => perform(prompt, values))}
          />
        ) : !view ? (
          <p>Loading…</p>
        ) : screen === "search" ? (
          <LibraryPanel
            view={view}
            entries={items()}
            navigate={navigate}
            run={command}
            edit={(e) => {
              setEditing(e);
              setScreen("create");
            }}
            choose={(row, copy) =>
              void begin({
                row,
                library: library(),
                range: target,
                remove: 0,
                suffix: "",
                copy,
              })
            }
          />
        ) : screen === "create" ? (
          <SnippetForm
            key={editing?.row.id ?? "new"}
            entry={editing}
            initialText={target?.selectedText ?? ""}
            run={command}
          />
        ) : (
          screen && (
            <Transfer
              screen={screen}
              team={!!view.organization}
              run={command}
            />
          )
        )}
      </fieldset>
    </aside>
  );
}
export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "library", component: Snippets });
  for (const [screen, title] of [
    ["search", "Search Snippets"],
    ["create", "Create Snippet"],
    ["import", "Import Snippets"],
    ["export", "Export Snippets"],
  ] as const) {
    app.commands.register({
      id: screen,
      title,
      run: ({ threadId }) => open(screen, undefined, threadId),
    });
  }
  app.composer.customize({
    id: "snippets",
    scopes: ["new-thread", "thread", "side-chat", "queued-message"],
    plusMenu: [
      {
        id: "insert",
        label: "Insert snippet",
        icon: "FileText",
        run: ({ composer }) => open("search", composer),
      },
    ],
  });
});
