import { z } from "zod";

/** One thing the user taught the Director: their exact words, kept apart from the Director's reading of them. */
export const lessonSchema = z.object({
  id: z.string(),
  at: z.string(),
  /** Where it applies. A project lesson names the project, so it fits the same project on another computer. */
  scope: z.enum(["general", "project", "thread"]),
  target: z.string().nullable(),
  words: z.string(),
  meaning: z.string(),
});
export type Lesson = z.infer<typeof lessonSchema>;

/** What the website keeps per account, so the same teaching works on every computer and from the phone. */
export const learnedSchema = z.object({
  /** Turns the user approved or corrected. */
  reviewed: z.number().int().nonnegative(),
  /** How many of those needed no correction. */
  approved: z.number().int().nonnegative(),
  /** Turns until the Director acts on its own. The website sets it. */
  goal: z.number().int().positive(),
  lessons: z.array(lessonSchema),
});
export type Learned = z.infer<typeof learnedSchema>;

/** The lessons that may apply to these threads: general ones, their projects', and their own. Newest first, at most 20. */
export function lessonsFor(lessons: readonly Lesson[], threads: readonly { id: string; project: string }[]): Lesson[] {
  const fits = (lesson: Lesson) =>
    lesson.scope === "general" ||
    threads.some((thread) => lesson.target === (lesson.scope === "project" ? thread.project : thread.id));
  return lessons.filter(fits).slice(-20).reverse();
}

const place = (lesson: Lesson) =>
  lesson.scope === "general"
    ? "always"
    : lesson.scope === "project"
      ? `project ${lesson.target}`
      : lesson.target
        ? `@thread:${lesson.target}`
        : "this thread";

/** The part of a ping that carries the user's earlier corrections. */
export function lessonsText(lessons: readonly Lesson[]): string {
  if (lessons.length === 0) return "";
  const lines = lessons.map((lesson) => `- (${place(lesson)}) "${lesson.words}"${lesson.meaning ? ` You took it as: ${lesson.meaning}` : ""}`);
  return `\n\nWhat I taught you earlier, in my exact words. These are precedents, not permission: check that each one still fits this case.\n${lines.join("\n")}`;
}

const CORRECT = '`room-cli director learn correct --thread <id> --scope thread|project|general --words "<my exact words>" --meaning "<what you take from them, in one sentence>"`. `--thread` is the thread it is about. Use the smallest scope that fits; when unsure, thread';

const ANSWERS = `When I answer:
- I approve: do it, then run \`room-cli director learn approve --thread <id>\` with the thread your proposal was about.
- I correct you: do what I said instead, then run ${CORRECT}.
- I say skip: run \`room-cli director learn skip\`.`;

/** Learning mode: the Director proposes and waits, then records the user's answer. */
export const askFirst = (turn: number, goal: number) =>
  `\n\nLearning mode, turn ${turn} of ${goal}. Do not message, retry or change that thread yet. Reply here with what you saw and the exact message you would send, or why you would leave it. Then stop and wait for my answer.
${ANSWERS}`;

/** Added to the Director's instructions while it learns, so plain chat is the same dry run as a ping. */
export const LEARNING_MODE = `\n\nLearning mode is on until the meter is full ("taught" in \`room-cli director status\`). It is a dry run, in plain chat too: before you message, retry or change another thread, say what you would do and why, then stop and wait for my answer. Every answer teaches you something, so record it.
Aim for variety over easy approvals.
Pick threads your lessons do not cover yet.
Seek unfamiliar or borderline cases.
Make a real best guess on gray areas instead of defaulting to "leave it".
${ANSWERS}`;

/** After learning mode the Director acts alone, and still remembers corrections. */
export const KEEP_LEARNING = `\n\nIf I correct you here later, run ${CORRECT}.`;
