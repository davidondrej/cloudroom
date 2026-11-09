import { readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  reasoningLevelSchema,
  reasoningLevelValues,
  type ReasoningLevel,
} from "@cloudroom/domain";
import type { ResolvedId } from "../context-env.js";

export {
  type ResolvedId,
  requireThreadId,
  requireThreadIdOrSelf,
} from "../context-env.js";

const REASONING_LEVELS: readonly ReasoningLevel[] = reasoningLevelValues;

export interface JsonOutputOptions {
  json?: boolean;
}

export function outputJson(opts: JsonOutputOptions, data: unknown): boolean {
  if (!opts.json) return false;
  console.log(JSON.stringify(data, null, 2));
  return true;
}

const PROMPT_FILE_MAX_BYTES = 1024 * 1024;

function readPromptFile(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size > PROMPT_FILE_MAX_BYTES) throw new Error("larger than 1 MB");
  try {
    // Strict UTF-8; the decoder also drops a byte order mark (Windows PowerShell 5.1 writes one).
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    throw new Error("not UTF-8 text; save it as UTF-8");
  }
}

// Multiline prompts survive Windows' room-cli.cmd only through a file (#974).
export function addPromptFileOption(command: Command): Command {
  const both = "error: choose only one of --prompt and --prompt-file";
  return command
    .option("--prompt-file <path>", "Read --prompt from a UTF-8 file (use it for multiline prompts on Windows)")
    .on("option:prompt", () => {
      if (command.getOptionValue("promptFile") !== undefined) command.error(both);
    })
    .on("option:prompt-file", (path: string) => {
      if (command.getOptionValue("prompt") !== undefined) command.error(both);
      let prompt: string;
      try {
        prompt = readPromptFile(path);
      } catch (error) {
        command.error(`error: --prompt-file ${path}: ${getErrorMessage(error)}`);
      }
      command.setOptionValueWithSource("prompt", prompt, "cli");
    });
}

export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function printThreadContextLabel(resolved: ResolvedId): void {
  if (resolved.source === "env") {
    console.error(`Thread ${resolved.id} (from ROOM_THREAD_ID)`);
  }
}

export async function confirmDestructiveAction(
  message: string,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Refusing destructive action without an interactive terminal. Re-run with --yes to confirm.",
    );
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await readline.question(`${message} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    readline.close();
  }
}

export function getErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const seen = new Set<Error>();
  const messages: string[] = [];
  const pending: Error[] = [err];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    if (current.message.length > 0) {
      messages.push(current.message);
    }

    const children: Error[] = [];
    if (current.cause instanceof Error) {
      children.push(current.cause);
    }
    if (current instanceof AggregateError) {
      children.push(
        ...current.errors.filter(
          (nested): nested is Error => nested instanceof Error,
        ),
      );
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }
  return messages.join(": ");
}

export function parseReasoningLevel(
  value: string | undefined,
): ReasoningLevel | undefined {
  if (value === undefined) return undefined;
  const parsed = reasoningLevelSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(
    `Invalid reasoning level '${value}'. Expected ${joinValues(REASONING_LEVELS)}.`,
  );
}

export function prependErrorContext(context: string, err: unknown): Error {
  return new Error(`${context}: ${getErrorMessage(err)}`);
}

export function joinValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(" or ");
}
