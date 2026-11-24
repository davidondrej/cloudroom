import { getErrorMessage } from "./commands/helpers.js";

export class CliExitError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "CliExitError";
    this.exitCode = exitCode;
  }
}

type CommandActionArgs = readonly unknown[];
type CommandAction<TArgs extends CommandActionArgs> = (
  ...args: TArgs
) => Promise<void>;

export function action<TArgs extends CommandActionArgs>(
  fn: CommandAction<TArgs>,
): CommandAction<TArgs> {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err: unknown) {
      if (isProcessExitError(err)) {
        throw err;
      }
      const exitError = err instanceof CliExitError ? err : undefined;
      console.error(`Error: ${exitError?.message ?? getErrorMessage(err)}`);
      // A forced exit after a request can abort Node on Windows (#1815, #828).
      const { exitWhenIdle } = await import("./plugin-cli-proxy.js");
      await exitWhenIdle(exitError?.exitCode ?? 1, true);
    }
  };
}

function isProcessExitError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("process.exit:");
}
