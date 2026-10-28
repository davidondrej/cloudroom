import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatCloudroomVersion } from "../version.js";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

export async function expectedCliVersion(): Promise<string> {
  const packageJson: unknown = JSON.parse(
    await readFile(
      join(repoRoot, "packages", "bb-app", "package.json"),
      "utf8",
    ),
  );
  if (
    typeof packageJson === "object" &&
    packageJson !== null &&
    "version" in packageJson &&
    typeof packageJson.version === "string"
  ) {
    return formatCloudroomVersion(packageJson.version);
  }
  throw new Error("packages/bb-app/package.json has no version");
}
