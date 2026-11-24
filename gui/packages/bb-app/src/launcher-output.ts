import { styleText } from "node:util";

// NO_COLOR or --no-color wins, FORCE_COLOR or --color forces color, and otherwise only a terminal gets it.
const { argv, env, platform, stdout } = process;
const colorEnabled =
  !(env.NO_COLOR || argv.includes("--no-color")) &&
  Boolean(
    env.FORCE_COLOR ||
    argv.includes("--color") ||
    (stdout.isTTY && (platform === "win32" || env.TERM !== "dumb" || env.CI)),
  );

const color = (format: Parameters<typeof styleText>[0]) => (text: string) =>
  colorEnabled ? styleText(format, text, { validateStream: false }) : text;

export const bold = color("bold");
export const cyan = color("cyan");
export const dim = color("dim");
export const green = color("green");
export const red = color("red");
export const yellow = color("yellow");

export function log(icon: string, message: string): void {
  process.stdout.write(`  ${icon}  ${message}\n`);
}

export function beginStep(message: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`\x1b[2K  ${dim("○")}  ${message}\r`);
  } else {
    log(dim("○"), message);
  }
}

export function endStep(icon: string, message: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2K");
  }
  log(icon, message);
}
