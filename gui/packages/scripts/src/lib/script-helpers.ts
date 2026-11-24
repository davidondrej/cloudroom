import readline from "node:readline/promises";
import { styleText } from "node:util";

type Formatter = (value: string) => string;

interface ConfirmTypedWordArgs {
  renderIntro: () => void;
  word: string;
}

// NO_COLOR or --no-color wins; otherwise color when forced, on Windows, on a terminal that isn't "dumb", or in CI.
const { argv, env, platform, stdout } = process;
const colorEnabled =
  !(env.NO_COLOR || argv.includes("--no-color")) &&
  Boolean(
    env.FORCE_COLOR ||
    argv.includes("--color") ||
    platform === "win32" ||
    (stdout.isTTY && env.TERM !== "dumb") ||
    env.CI,
  );

const color =
  (format: Parameters<typeof styleText>[0]): Formatter =>
  (value) =>
    colorEnabled ? styleText(format, value, { validateStream: false }) : value;

export const dim = color("dim");
export const bold = color("bold");
export const green = color("green");
export const cyan = color("cyan");
export const yellow = color("yellow");

export function log(icon: string, msg: string): void {
  process.stdout.write(`  ${icon}  ${msg}\n`);
}

export function endStep(icon: string, msg: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2K");
  }
  log(icon, msg);
}

export async function confirmTypedWord(
  args: ConfirmTypedWordArgs,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Interactive confirmation requires a TTY. Re-run with --yes to confirm.",
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    args.renderIntro();
    const answer = await rl.question(
      `  ${dim("?")}  Type ${bold(`"${args.word}"`)} to continue: `,
    );
    return answer.trim() === args.word;
  } finally {
    rl.close();
  }
}
