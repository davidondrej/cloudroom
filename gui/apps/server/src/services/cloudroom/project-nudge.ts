import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import {
  getProjectSummaries,
  listProjectSourcesByProjectIds,
  listPublicProjects,
  setProjectSummaries,
} from "@cloudroom/db";
import type { CommandResultSideEffectsDeps } from "../../internal/command-result-side-effects.js";
import type { AppDeps } from "../../types.js";
import {
  INFERENCE_POLICY,
  inferenceCompleteWithFallback,
} from "../ai/inference.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { readUiPreferences } from "../system/ui-preferences.js";
import { purposeModels } from "../threads/thread-purpose.js";
import { cloudroom } from "./commands.js";

// The wrong-project nudge (docs/scopes/jev-project-selection.md). Each project gets a one-paragraph summary, written in the
// background by the smallest model on the user's own Claude Code or Codex and rewritten every 7 days. While the user
// types a new thread's prompt, the website asks Jev which project's summary fits it.
const run = promisify(execFile);
const REWRITE_MS = 7 * 24 * 60 * 60_000;
const RETRY_MS = 60 * 60_000;
const FILES = ["README.md", "AGENTS.md", "CLAUDE.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
const SKIP = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "venv", "__pycache__"]);
const summarySchema = Type.Object({ summary: Type.String() });

const STARTUP_DELAY_MS = 30_000;

type Deps = CommandResultSideEffectsDeps;
let writing: { again: boolean } | null = null;
const failedAt = new Map<string, number>();

/** On for paid plans unless the user turned it off; off for Free unless they turned it on. */
function enabled(deps: Deps): boolean {
  return readUiPreferences(deps)["projectNudge.enabled"].value ?? cloudroom(deps).sandboxes.currentPlan() !== "free";
}

/** Writes summaries 30 s after the app starts and whenever a project is added, so the first prompts get a hint too. */
export function installProjectSummaries(deps: Deps): () => void {
  const timer = setTimeout(() => void writeSummaries(deps), STARTUP_DELAY_MS);
  const unsubscribe = deps.hub.onChangedMessage((message) => {
    if (message.entity === "project" && message.changes.some((change) => change === "project-created" || change === "project-sources-changed")) {
      void writeSummaries(deps);
    }
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}

/** Another project the prompt is for, when Jev is at least as sure as the user's confidence setting; null otherwise. */
export async function projectSuggestion(deps: AppDeps, prompt: string, projectId: string): Promise<string | null> {
  if (!enabled(deps)) return null;
  const projects = listPublicProjects(deps.db);
  void writeSummaries(deps);
  const summaries = getProjectSummaries(deps.db);
  const known = projects.flatMap((project) => {
    const summary = summaries[project.id];
    return summary ? [{ id: project.id, name: project.name, summary: summary.text }] : [];
  });
  // Without the current project's summary, Jev would push its prompts toward the others.
  if (known.length < 2 || !summaries[projectId]) return null;
  const pick = await cloudroom(deps).sandboxes.projectSuggestion({
    prompt,
    projects: known,
    confidence: readUiPreferences(deps)["projectNudge.confidence"].value,
  });
  return pick && pick !== projectId ? pick : null;
}

/** Writes missing and week-old summaries one at a time. Projects with no folder on this Mac are skipped.
 *  A call during a run makes the run go once more, so a project added meanwhile isn't missed. */
async function writeSummaries(deps: Deps): Promise<void> {
  if (writing) {
    writing.again = true;
    return;
  }
  if (!enabled(deps)) return;
  const state = { again: false };
  writing = state;
  try {
    const projects = listPublicProjects(deps.db);
    const sources = listProjectSourcesByProjectIds(deps.db, projects.map((project) => project.id));
    for (const project of projects) {
      const summary = getProjectSummaries(deps.db)[project.id];
      if (summary && Date.now() - summary.updatedAt < REWRITE_MS) continue;
      if (Date.now() - (failedAt.get(project.id) ?? 0) < RETRY_MS) continue;
      const folder = sources
        .filter((source) => source.projectId === project.id && existsSync(source.path))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))[0]?.path;
      if (!folder) continue;
      const text = await writeSummary(deps, project.name, folder).catch((error: unknown) => {
        deps.logger.debug({ projectId: project.id, ...runtimeErrorLogFields(deps.config, error) }, "Project summary failed");
        return null;
      });
      if (!text) {
        failedAt.set(project.id, Date.now());
        continue;
      }
      setProjectSummaries(deps.db, { ...getProjectSummaries(deps.db), [project.id]: { text, updatedAt: Date.now() } });
    }
  } finally {
    writing = null;
    if (state.again) void writeSummaries(deps);
  }
}

async function writeSummary(deps: Deps, name: string, folder: string): Promise<string | null> {
  const models = await purposeModels(null);
  if (!models) return null;
  const result = await inferenceCompleteWithFallback(deps, {
    fallbackOnAnyError: true,
    label: "Project summary inference",
    logContext: { folder },
    maxAttempts: INFERENCE_POLICY.threadPurpose.maxAttempts,
    primaryModel: models.primary,
    fallbackModel: models.fallback,
    prompt: [
      "Describe this software project in one short paragraph: 3 to 5 sentences, at most 600 characters.",
      "Another model reads it to tell which project a coding task belongs to. Say what the product is and its main parts.",
      "Then name the specific things a task would mention: features, endpoints, vendors, services, and integrations.",
      "Plain English, no marketing words.",
      "",
      `Project name: ${name}`,
      "",
      await repoContext(folder),
    ].join("\n"),
    reasoningEffort: "medium",
    retryDelayMs: INFERENCE_POLICY.threadPurpose.retryDelayMs,
    schema: summarySchema,
    timeoutMs: INFERENCE_POLICY.threadPurpose.timeoutMs,
  });
  return result?.summary.trim().slice(0, 800) || null;
}

/** The README, agent rules, package files, top two folder levels, and last 20 commit subjects. */
async function repoContext(folder: string): Promise<string> {
  const parts: string[] = [];
  for (const file of FILES) {
    const text = await readFile(join(folder, file), "utf8").catch(() => "");
    if (text.trim()) parts.push(`## ${file}\n${text.slice(0, 3_000)}`);
  }
  const lines: string[] = [];
  const list = async (path: string, indent: string, depth: number): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((e) => !e.name.startsWith(".") && !SKIP.has(e.name)).slice(0, 40)) {
      lines.push(`${indent}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory() && depth < 2) await list(join(path, entry.name), `${indent}  `, depth + 1);
    }
  };
  await list(folder, "", 1);
  parts.push(`## Folders\n${lines.slice(0, 300).join("\n")}`);
  const commits = await run("git", ["-C", folder, "log", "-20", "--format=%s"], { timeout: 10_000 })
    .then((result) => result.stdout.trim(), () => "");
  if (commits) parts.push(`## Recent commits\n${commits}`);
  return parts.join("\n\n");
}
