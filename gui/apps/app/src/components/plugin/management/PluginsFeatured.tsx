import { Icon } from "@cloudroom/shared-ui/icon";
import { ResourceInstallControl } from "@cloudroom/shared-ui/resource-list";
import { Switch } from "@cloudroom/shared-ui/switch";
import {
  addPluginInitialFromEntry,
  type AddPluginInitial,
} from "./AddPluginDialog";
import { usePluginEnabledToggle } from "./InstalledPluginsTab";
import {
  OFFICIAL_MARKETPLACE,
  type PluginListRow,
} from "./plugin-browse-discovery";

type OpenPlugin = (pluginId: string, trigger: HTMLButtonElement) => void;
type Actions = {
  onInstall: (initial: AddPluginInitial) => void;
  onOpenPlugin: OpenPlugin;
};
type Glyph = "cloud" | "snippets" | "merge" | "target";

/* The cards look like two-ink prints on cream paper (David's pick, 2026-11-26, docs/scopes/plugins.md). The paper
 * and inks are fixed colors on purpose: a print keeps its colors in every app theme. Text, toggles and the Install
 * button are black ink (#1b1a17) on every card. */
const PAPER = "#eee6d4";
const BLUE = "#2f4bff";
const PINK = "#ff4f9a";
const TEAL = "#00957f";
const YELLOW = "#ffc21a";
const RED = "#ef3b2d";

/** The optional plugins we build ourselves, shown as cards on top of the Plugins page. `inks` are the first and second
 *  ink of the card's picture. */
const OURS: {
  id: string;
  text: string;
  glyph: Glyph;
  inks: [string, string];
}[] = [
  {
    id: "provider-cloudroom-agent",
    text: "Keep going past plan limits.",
    glyph: "cloud",
    inks: [BLUE, PINK],
  },
  {
    id: "snippets",
    text: "Keyword in, full text out.",
    glyph: "snippets",
    inks: [TEAL, YELLOW],
  },
  {
    id: "repo-sync",
    text: "Cloud work lands on main.",
    glyph: "merge",
    inks: [PINK, TEAL],
  },
  {
    id: "director",
    text: "Unblocks stuck threads.",
    glyph: "target",
    inks: [RED, BLUE],
  },
];

/** One drawing per plugin on a 100 x 100 canvas, in a single ink. `knockout` is the color of the cloud's face.
 *  A new card needs one more case here, no image file. */
function Drawing({
  glyph,
  ink,
  knockout,
}: {
  glyph: Glyph;
  ink: string;
  knockout: string;
}) {
  const line = {
    fill: "none",
    stroke: ink,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  const shape = { ...line, fill: ink, strokeWidth: 7 };
  switch (glyph) {
    case "cloud":
      return (
        <>
          <path
            d="M26 78H76A18 18 0 0 0 80 43A26 26 0 0 0 32 36A21.5 21.5 0 0 0 26 78Z"
            {...shape}
          />
          <circle cx={44} cy={57} r={3.4} fill={knockout} />
          <circle cx={62} cy={57} r={3.4} fill={knockout} />
          <path
            d="M48 65Q53 70 58 65"
            {...line}
            stroke={knockout}
            strokeWidth={3}
          />
        </>
      );
    case "snippets":
      // Scissors, the plugin's icon.
      return (
        <>
          <circle cx={27} cy={76} r={12} {...line} strokeWidth={9} />
          <circle cx={73} cy={76} r={12} {...line} strokeWidth={9} />
          <path d="M33 66L64 10M67 66L36 10" {...line} strokeWidth={9} />
        </>
      );
    case "merge":
      return (
        <>
          <path
            d="M30 26V74M70 32C70 56 30 46 30 66"
            {...line}
            strokeWidth={10}
          />
          <circle cx={30} cy={18} r={8} {...shape} />
          <circle cx={30} cy={82} r={8} {...shape} />
          <circle cx={70} cy={24} r={8} {...shape} />
        </>
      );
    case "target":
      return (
        <>
          <circle cx={50} cy={50} r={40} {...line} strokeWidth={10} />
          <circle cx={50} cy={50} r={22} {...line} strokeWidth={10} />
          <circle cx={50} cy={50} r={6} {...shape} />
        </>
      );
  }
}

const HALFTONE_FADE =
  "radial-gradient(circle at 80% 62%, black 0%, black 18%, transparent 44%)";
const PAPER_GRAIN = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.95' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.2  0 0 0 0 0.15  0 0 0 0 0.1  0 0 0 0.5 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")`;

/** The print behind a card's text: halftone dots in the second ink, the drawing in both inks with the second pass a
 *  little off register (multiply makes the overlap the dark third tone), its number, and paper grain on top. */
function Print({
  glyph,
  inks: [first, second],
  number,
}: {
  glyph: Glyph;
  inks: [string, string];
  number: number;
}) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(${second} 1.15px, transparent 1.6px)`,
          backgroundSize: "5.5px 5.5px",
          maskImage: HALFTONE_FADE,
          WebkitMaskImage: HALFTONE_FADE,
        }}
      />
      <svg
        viewBox="0 0 100 100"
        className="absolute -bottom-3 -right-1 size-[6.4rem]"
      >
        <g transform="translate(6 5)" style={{ mixBlendMode: "multiply" }}>
          <Drawing glyph={glyph} ink={second} knockout={second} />
        </g>
        <g style={{ mixBlendMode: "multiply" }}>
          <Drawing glyph={glyph} ink={first} knockout={PAPER} />
        </g>
      </svg>
      <span
        className="absolute right-3 top-3 font-mono text-[9px] font-bold tracking-[0.18em]"
        style={{ color: first }}
      >
        N°{String(number).padStart(2, "0")}
      </span>
      <div
        className="absolute inset-0 opacity-70 mix-blend-multiply"
        style={{ backgroundImage: PAPER_GRAIN }}
      />
    </div>
  );
}

function Toggle({
  row,
}: {
  row: PluginListRow & { plugin: NonNullable<PluginListRow["plugin"]> };
}) {
  const { toggle, enabled } = usePluginEnabledToggle(row.plugin);
  return (
    <Switch
      checked={enabled}
      disabled={toggle.isPending}
      onCheckedChange={(next) => toggle.mutate(next)}
      aria-label={`${enabled ? "Disable" : "Enable"} ${row.title}`}
      // Black ink with a paper thumb, the same on every card.
      className="shadow-none data-[state=checked]:border-transparent data-[state=checked]:bg-[#1b1a17] data-[state=unchecked]:bg-[#1b1a17]/25 [&>span]:bg-[#eee6d4]!"
    />
  );
}
/** An on/off switch when installed, Install when not, like a row of the list below. */
function Control({
  row,
  onInstall,
}: {
  row: PluginListRow;
  onInstall: Actions["onInstall"];
}) {
  if (row.plugin !== null)
    return <Toggle row={{ ...row, plugin: row.plugin }} />;
  const entry = row.entry;
  if (entry === null || row.installed) return null;
  return (
    <ResourceInstallControl
      accessibleLabel={`Install ${row.title}`}
      className="h-7 border-[#1b1a17]/50 bg-transparent px-2.5 text-xs text-[#1b1a17] hover:bg-[#1b1a17]/10 hover:text-[#1b1a17]"
      onAction={() => onInstall(addPluginInitialFromEntry(entry))}
    />
  );
}

/** "Made by Cloudroom": a card per plugin of ours that this app knows. A card opens the plugin's details; its control
 *  installs it or turns it on. Null when none is known (an unreachable catalog and none installed). */
export function PluginsFeatured({
  rows,
  onInstall,
  onOpenPlugin,
  onSeeAll,
}: { rows: readonly PluginListRow[]; onSeeAll: () => void } & Actions) {
  const ours = OURS.flatMap((spec, index) => {
    const row = rows.find((candidate) => candidate.pluginId === spec.id);
    return row ? [{ ...spec, row, number: index + 1 }] : [];
  });
  if (ours.length === 0) return null;
  const official = rows.filter(
    (row) => row.entry?.marketplace === OFFICIAL_MARKETPLACE,
  ).length;
  return (
    <section aria-label="Made by Cloudroom" className="@container">
      <div className="flex items-center justify-between px-1 pb-2">
        <h2 className="text-sm font-medium text-foreground">
          Made by Cloudroom
        </h2>
        {official > ours.length ? (
          <button
            type="button"
            onClick={onSeeAll}
            className="flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            See all {official}
            <Icon name="ChevronRight" className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4">
        {ours.map(({ row, text, glyph, inks, number }) => (
          <div
            key={row.key}
            data-testid={`plugin-card-${row.pluginId}`}
            className="group relative h-[7.25rem] overflow-hidden rounded-xl p-3.5 text-[#1b1a17] transition-[filter] hover:brightness-105"
            style={{ background: PAPER }}
          >
            <Print glyph={glyph} inks={inks} number={number} />
            <button
              type="button"
              aria-label={`Open ${row.title} details`}
              onClick={(event) =>
                onOpenPlugin(row.pluginId, event.currentTarget)
              }
              className="absolute inset-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="pointer-events-none relative flex h-full flex-col justify-between">
              <div>
                <p className="truncate text-sm font-bold">{row.title}</p>
                <p className="mt-0.5 line-clamp-2 max-w-[56%] text-xs leading-snug opacity-70">
                  {text}
                </p>
              </div>
              <div data-row-action className="pointer-events-auto w-fit">
                <Control row={row} onInstall={onInstall} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
