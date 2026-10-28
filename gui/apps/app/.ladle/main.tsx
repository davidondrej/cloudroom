import { lazy, Suspense, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "./components";

type StoryComponent = ComponentType & {
  meta?: { width?: keyof typeof widths };
};
type Story = {
  id: string;
  file: string;
  exportName: string;
  levels: string[];
  name: string;
};

const widths = { xsmall: 414, small: 640, medium: 768, large: 1024 };

const files = import.meta.glob<{ title?: string; names: string[] }>(
  [
    "../src/**/*.stories.tsx",
    "../../../plugins/workflows/**/*.stories.tsx",
    "../../../plugins/ask-user-question/*.stories.tsx",
    "../../../plugins/provider-usage/*.stories.tsx",
  ],
  { query: "?names", import: "default", eager: true },
);
const modules = import.meta.glob<Record<string, StoryComponent>>([
  "../src/**/*.stories.tsx",
  "../../../plugins/workflows/**/*.stories.tsx",
  "../../../plugins/ask-user-question/*.stories.tsx",
  "../../../plugins/provider-usage/*.stories.tsx",
]);

const kebab = (text: string) =>
  text
    .replace(
      /[A-Z\u00C0-\u00D6\u00D9-\u00DD]+(?![a-z])|[A-Z\u00C0-\u00D6\u00D9-\u00DD]/g,
      (match, offset: number) => (offset ? "-" : "") + match.toLowerCase(),
    )
    .replace(/\s-/g, "-")
    .trim()
    .split(/[\s\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^_`{|}~]+/)
    .join("-");

const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

const stories: Story[] = Object.entries(files)
  .flatMap(([file, { title, names }]) => {
    const prefix = kebab(
      (title ?? file.split("/").pop()?.split(".")[0] ?? file)
        .toLocaleLowerCase()
        .replace(/\s*\/\s*/g, "--")
        .replace(/\s+/g, "-"),
    );
    return names.map((exportName) => {
      const id = `${prefix}--${kebab(exportName)}`;
      const levels = id
        .split("--")
        .map((level) => capitalize(level.replace(/-/g, " ")));
      return { id, file, exportName, name: levels.pop() ?? id, levels };
    });
  })
  .sort((a, b) => (a.id < b.id ? -1 : 1));

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const preview = params.get("mode") === "preview";
const current = stories.find((story) => story.id === params.get("story"));
const link = (changes: Record<string, string>) =>
  `?${new URLSearchParams({ ...Object.fromEntries(params), ...changes })}`;

const message = (text: string) => () => (
  <p className="p-6 text-muted-foreground">{text}</p>
);

const StoryView = lazy<ComponentType>(async () => {
  const Component =
    current && (await modules[current.file]?.())?.[current.exportName];
  if (!current || !Component) {
    return {
      default: message(current ? "Story not found." : "Pick a story."),
    };
  }
  const width = preview ? undefined : Component.meta?.width;
  if (!width) return { default: Component };
  return {
    default: () => (
      <iframe
        title={current.name}
        src={link({ story: current.id, theme, mode: "preview" })}
        className="mx-auto my-16 block h-[calc(100vh-8rem)] border border-border"
        style={{ width: widths[width] }}
      />
    ),
  };
});

function Tree({
  list,
  depth,
  open,
}: {
  list: Story[];
  depth: number;
  open: boolean;
}) {
  const groups = new Map<string, Story[]>();
  for (const story of list) {
    const level = story.levels[depth];
    if (level) groups.set(level, [...(groups.get(level) ?? []), story]);
  }
  return (
    <ul className="pl-3">
      {[...groups].map(([level, children]) => (
        <li key={level}>
          <details open={open || children.some((story) => story === current)}>
            <summary className="cursor-pointer py-0.5">{level}</summary>
            <Tree list={children} depth={depth + 1} open={open} />
          </details>
        </li>
      ))}
      {list
        .filter((story) => story.levels.length === depth)
        .map((story) => (
          <li key={story.id}>
            <a
              href={link({ story: story.id })}
              className={
                story === current
                  ? "block py-0.5 font-semibold"
                  : "block py-0.5 text-muted-foreground hover:text-foreground"
              }
            >
              {story.name}
            </a>
          </li>
        ))}
    </ul>
  );
}

function App() {
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase();
  const story = (
    <Suspense>
      <StoryView />
    </Suspense>
  );
  if (preview) return <Provider theme={theme}>{story}</Provider>;
  return (
    <Provider theme={theme}>
      <div className="flex h-screen bg-background">
        <main className="min-w-0 flex-1 overflow-auto">{story}</main>
        <nav className="w-72 shrink-0 overflow-auto border-l border-border bg-sidebar p-4 text-sm">
          <div className="mb-3 flex items-center gap-3 pl-3">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              className="min-w-0 flex-1 border-b border-border bg-transparent py-1 outline-none"
            />
            <a href={link({ theme: theme === "dark" ? "light" : "dark" })}>
              {theme === "dark" ? "Light" : "Dark"}
            </a>
          </div>
          <Tree
            list={stories.filter((item) =>
              [...item.levels, item.name]
                .join(" ")
                .toLowerCase()
                .includes(words),
            )}
            depth={0}
            open={words !== ""}
          />
        </nav>
      </div>
    </Provider>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
