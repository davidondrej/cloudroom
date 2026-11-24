// Monthly Wrapped (docs/scopes/wrapped.md): the three-panel card, drawn on a canvas so the picture on screen is
// the exact picture that is saved, copied and shared. Fixed brand colors, like the onboarding screens.

export interface Wrapped {
  month: string;
  agents: number;
  cloud: number;
  subagents: number;
  prompts: number;
  days: number[];
  hours: number;
  topModel: string | null;
  topHarness: string | null;
  topSkill: string | null;
  peakHour: number | null;
  top: number | null;
}

/** 16:9, so X shows the whole card. Drawn at twice this size. */
export const WRAPPED_CARD = { width: 1120, height: 630, scale: 2 };
const LIME = "#BFFF00", CREAM = "#F7F1E1", INK = "#0a0a0a", GRAY = "#8f8f8f";
const SANS = '"Inter Variable", Inter, sans-serif', MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const PAD = 24, GAP = 26, PANEL_W = (WRAPPED_CARD.width - 2 * PAD - 2 * GAP) / 3, PANEL_H = WRAPPED_CARD.height - 2 * PAD;
const INNER = PANEL_W - 2 * PAD;
const COLUMNS = 6, CELL_GAP = 6;

const count = (value: number) => value.toLocaleString("en-US");
/** A day in the middle of `2026-10`, in local time. */
export const wrappedMidMonth = (month: string) => new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 15);
export const wrappedMonthName = (month: string) => wrappedMidMonth(month).toLocaleDateString("en-US", { month: "long" });
const hourName = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;

/** Days in a row with any activity, the longest run of the month. */
export function wrappedStreak(days: readonly number[]): number {
  let best = 0, run = 0;
  for (const day of days) { run = day > 0 ? run + 1 : 0; best = Math.max(best, run); }
  return best;
}

interface TextStyle { size: number; weight?: number; color: string; mono?: boolean; spacing?: number; right?: boolean; fit?: number }

/** Draws one line on its baseline. `spacing` is in em. `fit` shrinks the text until it is at most that wide. */
function line(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, style: TextStyle): void {
  let size = style.size;
  const set = () => {
    ctx.font = `${style.weight ?? 700} ${size}px ${style.mono ? MONO : SANS}`;
    ctx.letterSpacing = `${(style.spacing ?? 0) * size}px`;
  };
  set();
  const width = ctx.measureText(value).width;
  if (style.fit && width > style.fit) { size *= style.fit / width; set(); }
  ctx.fillStyle = style.color;
  ctx.textAlign = style.right ? "right" : "left";
  // Letter spacing also trails the last letter, which would pull right-aligned text off its edge.
  ctx.fillText(value, style.right ? x + (style.spacing ?? 0) * size : x, y);
}

function wrap(ctx: CanvasRenderingContext2D, value: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of value.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && ctx.measureText(`${last} ${word}`).width <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

function panel(ctx: CanvasRenderingContext2D, index: number, fill: string, ink: string, label: string, labelColor: string, draw: () => void): void {
  ctx.save();
  ctx.translate(PAD + index * (PANEL_W + GAP), PAD);
  ctx.beginPath();
  ctx.rect(0, 0, PANEL_W, PANEL_H);
  ctx.clip();
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, PANEL_W, PANEL_H);
  // Story progress: one bar per panel, filled up to this one.
  const bar = (INNER - 2 * 4) / 3;
  for (let step = 0; step < 3; step += 1) {
    ctx.globalAlpha = step <= index ? 1 : 0.25;
    ctx.fillStyle = ink;
    ctx.fillRect(PAD + step * (bar + 4), 20, bar, 3);
  }
  ctx.globalAlpha = 1;
  line(ctx, label, PAD, 52, { size: 11, weight: 500, color: labelColor, mono: true, spacing: 0.2 });
  draw();
  ctx.restore();
}

/** Draws the card for one month. Load the fonts and the cloud image first. */
export function drawWrappedCard(canvas: HTMLCanvasElement, wrapped: Wrapped, cloud: CanvasImageSource): void {
  const { width, height, scale } = WRAPPED_CARD;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(scale, scale);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#111111";
  ctx.fillRect(0, 0, width, height);
  const month = wrappedMonthName(wrapped.month), MONTH = month.toUpperCase();

  panel(ctx, 0, LIME, INK, `YOUR ${MONTH} · WRAPPED`, INK, () => {
    line(ctx, "You started", PAD, 135, { size: 25, color: INK, spacing: -0.03 });
    line(ctx, count(wrapped.agents), PAD - 5, 244, { size: 118, weight: 800, color: INK, spacing: -0.07, fit: INNER + 8 });
    line(ctx, `agents in ${month}.`, PAD, 288, { size: 25, color: INK, spacing: -0.03, fit: INNER });
    const note = wrapped.subagents === 1 ? "1 of them was started by another agent."
      : wrapped.subagents > 1 ? `${count(wrapped.subagents)} of them were started by other agents.`
      : wrapped.cloud > 0 ? `${count(wrapped.cloud)} of them ran in the cloud.`
      : `You sent them ${count(wrapped.prompts)} prompts.`;
    ctx.font = `500 14.5px ${SANS}`;
    ctx.letterSpacing = "0px";
    const lines = wrap(ctx, note, 205 - 28), boxHeight = 24 + lines.length * 19.5;
    ctx.fillStyle = INK;
    ctx.fillRect(PAD, PANEL_H - PAD - boxHeight, 205, boxHeight);
    lines.forEach((text, row) => line(ctx, text, PAD + 14, PANEL_H - PAD - boxHeight + 27 + row * 19.5, { size: 14.5, weight: 500, color: LIME }));
    // The mascot peeks in from the bottom right corner.
    ctx.translate(PANEL_W + 64 - 105, PANEL_H + 34 - 105);
    ctx.rotate((-14 * Math.PI) / 180);
    ctx.drawImage(cloud, -105, -105, 210, 210);
  });

  panel(ctx, 1, INK, CREAM, "TIME IN CLOUDROOM", GRAY, () => {
    ctx.strokeStyle = "#2b2b2b";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, PANEL_W, PANEL_H);
    const active = wrapped.days.filter((day) => day > 0).length, all = active === wrapped.days.length;
    line(ctx, all ? "You never" : "You showed up", PAD, 107, { size: 25, color: CREAM, spacing: -0.03 });
    line(ctx, all ? "missed a day." : `${active} of ${wrapped.days.length} days.`, PAD, 135, { size: 25, color: CREAM, spacing: -0.03 });
    const cell = (INNER - (COLUMNS - 1) * CELL_GAP) / COLUMNS, most = Math.max(...wrapped.days, 1);
    wrapped.days.forEach((value, day) => {
      const share = value / most;
      ctx.globalAlpha = value <= 0 ? 1 : share < 0.25 ? 0.25 : share < 0.5 ? 0.45 : share < 0.75 ? 0.72 : 1;
      ctx.fillStyle = value <= 0 ? "#1d1d1d" : LIME;
      ctx.fillRect(PAD + (day % COLUMNS) * (cell + CELL_GAP), 162 + Math.floor(day / COLUMNS) * (cell + CELL_GAP), cell, cell);
    });
    ctx.globalAlpha = 1;
    line(ctx, String(wrappedStreak(wrapped.days)), PAD - 2, PANEL_H - 54, { size: 54, weight: 800, color: LIME, spacing: -0.06 });
    line(ctx, "day streak", PAD, PANEL_H - 29, { size: 13, weight: 400, color: CREAM });
    const timed = wrapped.hours > 0;
    line(ctx, count(timed ? wrapped.hours : wrapped.prompts), PANEL_W - PAD, PANEL_H - 54, { size: 54, weight: 800, color: CREAM, spacing: -0.06, right: true, fit: 170 });
    line(ctx, timed ? (wrapped.hours === 1 ? "hour" : "hours") : "prompts", PANEL_W - PAD, PANEL_H - 29, { size: 13, weight: 400, color: CREAM, right: true });
  });

  panel(ctx, 2, CREAM, INK, `MY ${MONTH}`, INK, () => {
    const rows: [string, string | null][] = [
      ["AGENTS", count(wrapped.agents)],
      ["TOP MODEL", wrapped.topModel],
      ["TOP HARNESS", wrapped.topHarness],
      ["TOP SKILL", wrapped.topSkill && `/${wrapped.topSkill}`],
      ["PEAK HOUR", wrapped.peakHour === null ? null : hourName(wrapped.peakHour)],
    ];
    rows.filter((row): row is [string, string] => row[1] !== null).forEach(([name, value], row) => {
      const y = 103 + row * 51.3;
      line(ctx, name, PAD, y, { size: 12, weight: 500, color: INK, mono: true, spacing: 0.1 });
      line(ctx, value, PANEL_W - PAD, y, { size: 19, color: INK, spacing: -0.02, right: true, fit: INNER - 118 });
      ctx.fillStyle = INK;
      ctx.fillRect(PAD, y + 25, INNER, 1.5);
    });
    // The brag box: the rank when the website knows it, else the cloud share.
    const cloudShare = wrapped.agents > 0 ? Math.round((wrapped.cloud / wrapped.agents) * 100) : 0;
    const [big, small] = wrapped.top !== null ? [`Top ${wrapped.top}%`, "of Cloudroom users"]
      : cloudShare > 0 ? [`${cloudShare}%`, "ran in the cloud"]
      : [count(wrapped.prompts), "prompts sent"];
    const top = PANEL_H - 160;
    ctx.fillStyle = INK;
    ctx.fillRect(PAD, top, INNER, 102);
    line(ctx, big, PAD + 14, top + 53, { size: 50, weight: 800, color: LIME, spacing: -0.06, fit: INNER - 28 });
    line(ctx, small, PAD + 16, top + 78, { size: 13, weight: 400, color: CREAM });
    // The wordmark and where to get your own.
    ctx.fillStyle = LIME;
    ctx.fillRect(PAD, PANEL_H - 49, 20, 20);
    ctx.drawImage(cloud, PAD + 1, PANEL_H - 48, 18, 18);
    line(ctx, "cloudroom", PAD + 27, PANEL_H - 33, { size: 16, weight: 650, color: INK, spacing: -0.03 });
    ctx.fillStyle = LIME;
    ctx.fillRect(PAD + 27 + ctx.measureText("cloudroom").width, PANEL_H - 36.5, 3.5, 3.5);
    line(ctx, "cloudroom.dev/wrapped", PANEL_W - PAD, PANEL_H - 34, { size: 10.5, weight: 400, color: INK, mono: true, right: true });
  });
}
