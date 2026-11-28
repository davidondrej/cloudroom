// Is the Director's model strong enough to direct other agents?
// Only the frontier families are fixed here (David, 2026-11-27). The newest version of each comes from the
// harnesses' own model lists, so a new Opus or Fable needs no release, and the one before it gets flagged.
import { reasoningLevelSchema, type ReasoningLevel } from "@cloudroom/domain";
import { z } from "zod";

/** "5", "5.5", "5-5" or "5_5" after the family word, any spacing; a date like "-20260101" is not a minor version. */
const VERSION = String.raw`[\s._-]*(\d+)(?:[._-](\d)(?!\d))?`;

/** Each family with the version that was newest when this shipped, and the harness that gets new versions first.
 *  Sonnet and Gemini Carbon are allowed (David, 2026-11-27); `pick: false` keeps them off the buttons (Claude's call). */
const FAMILIES = [
  { pattern: new RegExp(`opus${VERSION}`, "i"), floor: 5.5, home: "claude-code", pick: true },
  { pattern: new RegExp(`gpt${VERSION}[\\s._-]*astra`, "i"), floor: 6.2, home: "codex", pick: true },
  { pattern: new RegExp(`fable${VERSION}`, "i"), floor: 5.2, home: "claude-code", pick: true },
  { pattern: new RegExp(`gemini${VERSION}[\\s._-]*neon`, "i"), floor: 4, home: "acp-antigravity", pick: true },
  { pattern: new RegExp(`gpt${VERSION}[\\s._-]*sol(?![a-z])`, "i"), floor: 6.2, home: "codex", pick: true },
  { pattern: new RegExp(`sonnet${VERSION}`, "i"), floor: 5.5, home: "claude-code", pick: false },
  { pattern: new RegExp(`gemini${VERSION}[\\s._-]*carbon`, "i"), floor: 4, home: "acp-antigravity", pick: false },
] as const;
type Family = (typeof FAMILIES)[number];

/** The harnesses whose model lists set the bar. */
export const HOMES = [...new Set(FAMILIES.map((family) => family.home))];

/** What a harness's model list says about one model. */
export type Listed = { id: string; model: string; displayName: string; defaultReasoningEffort: ReasoningLevel; supportedReasoningEfforts: ReadonlyArray<{ reasoningEffort: ReasoningLevel }> };

/** High effort, the Director's default, when the model has it; Codex defaults to Low. */
const effort = (model: Listed): ReasoningLevel => (model.supportedReasoningEfforts.some(({ reasoningEffort }) => reasoningEffort === "high") ? "high" : model.defaultReasoningEffort);

/** "anthropic/claude-opus-5.5-fast" reads as Opus 5.5; a model outside every family reads as null. */
function read(model: string): { family: Family; version: number } | null {
  for (const family of FAMILIES) {
    const match = family.pattern.exec(model);
    if (match) return { family, version: Number(match[1]) + Number(match[2] ?? 0) / 10 };
  }
  return null;
}

const agentSchema = z.object({ providerId: z.string(), model: z.string(), reasoningLevel: reasoningLevelSchema });
export const modelCheckSchema = z.object({
  /** null: strong enough. "old": an older version of a frontier family. "weak": not a frontier model. */
  problem: z.enum(["old", "weak"]).nullable(),
  /** The model's name as its harness shows it. */
  name: z.string(),
  /** The newest model of each frontier family, on a harness this computer has. */
  picks: z.array(z.object({ name: z.string(), agent: agentSchema })),
});
export type ModelCheck = z.infer<typeof modelCheckSchema>;

export function checkModel(agent: { providerId: string; model: string }, lists: ReadonlyMap<string, readonly Listed[]>): ModelCheck {
  // The bar: the newest version any list shows, never below what was newest when this shipped.
  const newest = new Map<Family, number>(FAMILIES.map((family) => [family, family.floor]));
  for (const models of lists.values()) {
    for (const { id } of models) {
      const known = read(id);
      if (known && known.version > (newest.get(known.family) ?? 0)) newest.set(known.family, known.version);
    }
  }
  const isNewest = (model: string, family: Family) => {
    const known = read(model);
    return known?.family === family && known.version >= (newest.get(family) ?? 0);
  };
  const current = read(agent.model);
  const problem = current === null ? "weak" : isNewest(agent.model, current.family) ? null : "old";
  const listed = lists.get(agent.providerId)?.find(({ id, model }) => id === agent.model || model === agent.model);
  // Each family's newest model, from its own harness first, then from the Director's harness. The shortest id skips "[1m]", "-fast" and "-batch".
  const picks = FAMILIES.filter(({ pick }) => pick).flatMap((family) => {
    for (const providerId of [family.home, agent.providerId]) {
      const [best] = (lists.get(providerId) ?? []).filter(({ id }) => isNewest(id, family)).sort((a, b) => a.id.length - b.id.length);
      if (best) return [{ name: best.displayName, agent: { providerId, model: best.id, reasoningLevel: effort(best) } }];
    }
    return [];
  });
  return { problem, name: listed?.displayName ?? agent.model, picks };
}
