import fs from "node:fs/promises";
import { dirname, join } from "node:path";

export type LinuxDesktopEntryResult =
  | { kind: "created" | "updated" | "unchanged"; entryPath: string }
  | { kind: "skipped"; reason: "invalid-desktop-name" };

interface EnsureLinuxDesktopEntryArgs {
  appImagePath: string;
  applicationName: string;
  dataHome: string;
  desktopName: string;
  iconPath: string;
}

function quoteExecArgument(value: string): string {
  const quoted = value.replace(/["`$\\]/g, "\\$&");
  return `"${quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%")}"`;
}

async function writeIfChanged(
  path: string,
  content: string | Buffer,
): Promise<"created" | "updated" | "unchanged"> {
  const current = await fs.readFile(path).catch(() => null);
  if (current?.equals(Buffer.from(content))) return "unchanged";
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content);
  return current === null ? "created" : "updated";
}

export async function ensureLinuxDesktopEntry(
  args: EnsureLinuxDesktopEntryArgs,
): Promise<LinuxDesktopEntryResult> {
  if (!/^[A-Za-z0-9._-]+\.desktop$/.test(args.desktopName)) {
    return { kind: "skipped", reason: "invalid-desktop-name" };
  }
  const appId = args.desktopName.slice(0, -".desktop".length);
  const iconTarget = join(args.dataHome, "icons", `${appId}.png`);
  const entryPath = join(args.dataHome, "applications", args.desktopName);

  await writeIfChanged(iconTarget, await fs.readFile(args.iconPath));
  const entry = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${args.applicationName}`,
    `Exec=${quoteExecArgument(args.appImagePath)} %U`,
    `Icon=${iconTarget}`,
    "Terminal=false",
    "Categories=Development;",
    `StartupWMClass=${appId}`,
    "MimeType=x-scheme-handler/cloudroom;",
    "",
  ].join("\n");
  return { kind: await writeIfChanged(entryPath, entry), entryPath };
}
