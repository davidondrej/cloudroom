// Finds threads that ask for the same job as another one (docs/scopes/skill-suggestions.md), by plain text: no model.
// It only picks candidates. About half are one project spread over threads, so a small model confirms a group before
// anything shows (skill-suggestion.ts).

/** A thread a person started: its title and the start of its first prompt. */
export interface StartedThread { id: string; title: string; prompt: string }

const PROMPT_CHARS = 400;
const STOP = new Set(("a an the and or but if then so to of in on at for with by from as is are was were be been it its this that these those i you we " +
  "they me my our your do does did done have has had not no yes can could should would will just also than too very what which who how why when " +
  "where there here all any some more most into out up down over about again only same each other because while until after before let lets " +
  "please make sure dont im thats okay ok like need want see look check get go use using new one").split(" "));

function words(thread: StartedThread): string[] {
  // The title counts double: it is a model's own summary of the job. Code, links, paths, IDs and numbers say nothing about the job.
  const text = `${thread.title} ${thread.title} ${thread.prompt.slice(0, PROMPT_CHARS)}`.toLowerCase()
    .replace(/```[\s\S]*?```/g, " ").replace(/https?:\/\/\S+|\S+\/\S+|thr_\w+|\b[0-9a-f]{7,}\b|\b\d[\w.]*/g, " ");
  return (text.match(/[a-z][a-z-]{2,}/g) ?? []).filter((word) => !STOP.has(word));
}

/**
 * The threads in `others` that read like `thread`, most alike first: cosine similarity of their words, where a word
 * counts less the more threads use it. `min` is from 0 (nothing in common) to 1 (the same words).
 */
export function similarThreads(thread: StartedThread, others: StartedThread[], min = 0.4, most = 6): StartedThread[] {
  const all = [thread, ...others].map(words), used = new Map<string, number>();
  for (const list of all) for (const word of new Set(list)) used.set(word, (used.get(word) ?? 0) + 1);
  const vectors = all.map((list) => {
    const counts = new Map<string, number>();
    for (const word of list) counts.set(word, (counts.get(word) ?? 0) + 1);
    const vector = new Map<string, number>();
    // A word only one thread uses matches nothing.
    for (const [word, count] of counts) if (used.get(word)! > 1) vector.set(word, (1 + Math.log(count)) * Math.log(all.length / used.get(word)!));
    const length = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0)) || 1;
    for (const [word, value] of vector) vector.set(word, value / length);
    return vector;
  });
  const [mine, ...rest] = vectors;
  return rest.map((vector, index) => ({ thread: others[index]!, score: [...mine!].reduce((sum, [word, value]) => sum + value * (vector.get(word) ?? 0), 0) }))
    .filter((item) => item.score >= min).sort((a, b) => b.score - a.score).slice(0, most).map((item) => item.thread);
}
