import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { ResourceInstallControl } from "@cloudroom/shared-ui/resource-list";
import { Switch } from "@cloudroom/shared-ui/switch";
import { addPluginInitialFromEntry, type AddPluginInitial } from "./AddPluginDialog";
import { usePluginEnabledToggle } from "./InstalledPluginsTab";
import type { PluginListGroup, PluginListRow } from "./plugin-browse-discovery";
import { CatalogEntryIconChip, PluginLogoChip } from "./plugin-ui";

type OpenPlugin = (pluginId: string, trigger: HTMLButtonElement) => void;
type Actions = { onInstall: (initial: AddPluginInitial) => void; onOpenPlugin: OpenPlugin };
type InstalledRow = PluginListRow & { plugin: NonNullable<PluginListRow["plugin"]> };

/** The plugins the top of the Plugins page features (docs/scopes/plugins.md). An art tile shows the plugin's own catalog
 *  screenshot (`shot` names the file), cropped to its artwork with `size` and `position`. */
const HERO = { id: "aura", shot: "alpine", size: "285%", position: "62% 2%", text: "Wallpapers, animated GIFs, and pixel textures behind your whole workspace." };
const WIDE = { id: "ambient", shot: "poppy-hill", size: "210%", position: "100% 85%", text: "A live scene behind your chats that shows what your agents are doing." };
const FRESH = { id: "repo-sync", text: "Cloud threads push their work to main on their own." };
const SMALL = "automations";

const CATEGORY_ICONS: Record<string, IconName> = {
  "themes-and-appearance": "Palette", "thread-management": "PanelLeft", "thread-content": "MessageSquare", "memory-and-context": "Brain",
  security: "Lock", "agents-and-providers": "Layers", environments: "FolderGit", "token-usage-and-limits": "ChartColumn",
  notifications: "Bell", "code-and-reviews": "GitPullRequest", "file-viewers-and-editors": "FileText", "cloud-and-remote": "Cloud",
  "command-line": "Terminal", utilities: "Toolbox", "plugin-development": "Puzzle", "tasks-and-workflows": "ListTodo",
};
const ON_ART = "border-white/40 bg-black/40 text-white backdrop-blur hover:bg-black/60 hover:text-white";
const TILE = "group relative overflow-hidden rounded-xl";

const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(n));
const art = (row: PluginListRow, spec: { shot: string; size: string; position: string }): CSSProperties | undefined => {
  const shots = row.entry?.screenshots ?? [];
  const url = shots.find((shot) => shot.includes(spec.shot)) ?? shots[0];
  return url ? { backgroundImage: `url(${JSON.stringify(url)})`, backgroundSize: spec.size, backgroundPosition: spec.position } : undefined;
};

/** The whole tile opens the plugin's details; its own controls sit above this. */
function Open({ row, onOpenPlugin }: { row: PluginListRow; onOpenPlugin: OpenPlugin }) {
  return (
    <button
      type="button"
      aria-label={`Open ${row.title} details`}
      onClick={(event) => onOpenPlugin(row.pluginId, event.currentTarget)}
      className="absolute inset-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}
function Toggle({ row }: { row: InstalledRow }) {
  const { toggle, enabled } = usePluginEnabledToggle(row.plugin);
  return <Switch checked={enabled} disabled={toggle.isPending} onCheckedChange={(next) => toggle.mutate(next)} aria-label={`${enabled ? "Disable" : "Enable"} ${row.title}`} />;
}
/** An on/off switch when installed, Install when not, like a row of the list below. */
function Control({ row, onInstall, className }: { row: PluginListRow; onInstall: Actions["onInstall"]; className?: string }) {
  if (row.plugin !== null) return <Toggle row={{ ...row, plugin: row.plugin }} />;
  const entry = row.entry;
  if (entry === null || row.installed) return null;
  return <ResourceInstallControl accessibleLabel={`Install ${row.title}`} className={cn("h-7 px-2.5 text-xs", className)} onAction={() => onInstall(addPluginInitialFromEntry(entry))} />;
}

function ArtTile({ row, spec, eyebrow, big = false, className, ...actions }: { row: PluginListRow; spec: typeof HERO; eyebrow: ReactNode; big?: boolean; className?: string } & Actions) {
  return (
    <div className={cn(TILE, "flex flex-col justify-end border border-border bg-card bg-cover", big ? "p-6" : "p-5", className)} style={art(row, spec)}>
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
      <Open row={row} onOpenPlugin={actions.onOpenPlugin} />
      <div className="pointer-events-none relative">
        <p className="text-2xs font-semibold uppercase tracking-wider text-white/75">{eyebrow}</p>
        <p className={cn("font-semibold tracking-tight text-white", big ? "mt-1 text-5xl" : "mt-1 text-xl")}>{row.title}</p>
        <p className={cn("leading-snug text-white/80", big ? "mt-3 max-w-sm text-sm" : "mt-1 max-w-md text-xs")}>{spec.text}</p>
      </div>
      <div data-row-action className={cn("absolute", big ? "right-6 top-6" : "right-4 top-4")}>
        <Control row={row} onInstall={actions.onInstall} className={ON_ART} />
      </div>
    </div>
  );
}

/** The lime tile's own button: a switch would vanish on lime. */
function FreshAction({ row, onInstall }: { row: PluginListRow; onInstall: Actions["onInstall"] }) {
  const button = "inline-flex h-7 items-center gap-1.5 rounded-md bg-primary-foreground px-2.5 text-xs font-medium text-primary disabled:opacity-60";
  if (row.plugin !== null) return <FreshToggle row={{ ...row, plugin: row.plugin }} className={button} />;
  const entry = row.entry;
  if (entry === null) return null;
  return (
    <button type="button" className={button} onClick={() => onInstall(addPluginInitialFromEntry(entry))}>
      <Icon name="Download" className="size-3.5" aria-hidden />
      Install
    </button>
  );
}
function FreshToggle({ row, className }: { row: InstalledRow; className: string }) {
  const { toggle, enabled } = usePluginEnabledToggle(row.plugin);
  return (
    <button type="button" aria-pressed={enabled} disabled={toggle.isPending} className={className} onClick={() => toggle.mutate(!enabled)}>
      {enabled && <Icon name="Check" className="size-3.5" aria-hidden />}
      {enabled ? "On" : "Turn on"}
    </button>
  );
}
function FreshTile({ row, ...actions }: { row: PluginListRow } & Actions) {
  const icon = (row.entry?.icon ?? row.plugin?.icon ?? "Puzzle") as IconName;
  return (
    <div className={cn(TILE, "flex flex-col justify-between bg-primary p-4 text-primary-foreground")}>
      <Open row={row} onOpenPlugin={actions.onOpenPlugin} />
      <div className="pointer-events-none relative flex items-center justify-between">
        <span className="rounded-full bg-primary-foreground/10 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider">New</span>
        <Icon name={icon} className="size-6" aria-hidden />
      </div>
      <div className="pointer-events-none relative">
        <p className="text-xl font-semibold tracking-tight">{row.title}</p>
        <p className="mt-0.5 text-xs leading-snug opacity-80">{FRESH.text}</p>
        <div data-row-action className="pointer-events-auto mt-3 w-fit">
          <FreshAction row={row} onInstall={actions.onInstall} />
        </div>
      </div>
    </div>
  );
}

function SmallTile({ row, ...actions }: { row: PluginListRow } & Actions) {
  return (
    <div className={cn(TILE, "flex flex-col justify-between border border-border bg-card p-4 transition-colors hover:border-foreground/30")}>
      <Open row={row} onOpenPlugin={actions.onOpenPlugin} />
      <div className="pointer-events-none relative flex items-start justify-between">
        <span>
          {row.entry !== null ? (
            <CatalogEntryIconChip entry={row.entry} className="size-9" iconClassName="size-4.5" />
          ) : row.plugin !== null ? (
            <PluginLogoChip plugin={row.plugin} className="size-9" iconClassName="size-4.5" />
          ) : null}
        </span>
        <div data-row-action className="pointer-events-auto">
          <Control row={row} onInstall={actions.onInstall} />
        </div>
      </div>
      <div className="pointer-events-none relative">
        <p className="text-sm font-semibold text-foreground">{row.title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">{row.description}</p>
      </div>
    </div>
  );
}

/** Jumps to that category in the list below. */
function showCategory(label: string) {
  const sections = document.querySelectorAll<HTMLElement>('[data-testid="plugin-list"] section');
  [...sections].find((section) => section.getAttribute("aria-label") === label)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** The featured bento and the categories, above the full list. Null until every featured plugin is known, so the page
 *  never shows a bento with holes (an unreachable catalog, an app older than a featured plugin). */
export function PluginsFeatured({ rows, groups, onInstall, onOpenPlugin }: { rows: readonly PluginListRow[]; groups: readonly PluginListGroup[] } & Actions) {
  const find = (id: string) => rows.find((row) => row.pluginId === id);
  const [hero, wide, fresh, small] = [find(HERO.id), find(WIDE.id), find(FRESH.id), find(SMALL)];
  if (!hero || !wide || !fresh || !small) return null;
  const actions = { onInstall, onOpenPlugin };
  const installs = hero.entry?.installs ?? 0;
  return (
    <div className="@container space-y-6 pb-3">
      <section aria-label="Featured plugins" className="grid auto-rows-[12rem] grid-cols-2 gap-2.5 @3xl:grid-cols-4">
        <ArtTile row={hero} spec={HERO} big className="col-span-2 row-span-2" eyebrow={installs ? `Featured · ${count(installs)} installs` : "Featured"} {...actions} />
        <ArtTile row={wide} spec={WIDE} className="col-span-2" eyebrow="Make it yours" {...actions} />
        <FreshTile row={fresh} {...actions} />
        <SmallTile row={small} {...actions} />
      </section>
      <section aria-label="Browse by category">
        <h2 className="px-1 pb-2 text-sm font-medium text-foreground">Browse by category</h2>
        <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4">
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              onClick={() => showCategory(group.label)}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-3 text-left transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground">
                <Icon name={CATEGORY_ICONS[group.key] ?? "Puzzle"} className="size-4" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">{group.label}</span>
                <span className="block text-xs text-subtle-foreground">{group.rows.length} {group.rows.length === 1 ? "plugin" : "plugins"}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
