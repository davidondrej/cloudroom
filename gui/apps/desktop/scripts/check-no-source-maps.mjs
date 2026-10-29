import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

async function findAsars(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === "app.asar") {
      found.push(path);
    } else if (entry.isDirectory() && !entry.name.endsWith(".unpacked")) {
      found.push(...(await findAsars(path)));
    }
  }
  return found;
}

async function readAsarPaths(asarPath) {
  const file = await open(asarPath, "r");
  try {
    const prefix = Buffer.alloc(16);
    await file.read(prefix, 0, 16, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12));
    await file.read(header, 0, header.length, 16);
    const paths = [];
    const walk = (node, parent) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        paths.push(`${parent}/${name}`);
        walk(child, `${parent}/${name}`);
      }
    };
    walk(JSON.parse(header.toString("utf8")), "");
    return paths;
  } finally {
    await file.close();
  }
}

const releaseDirectory = process.argv[2] ?? "release.noindex";
const asars = await findAsars(releaseDirectory);
if (asars.length === 0) {
  console.error(`No app.asar found under ${releaseDirectory}.`);
  process.exit(1);
}

const maps = [];
for (const asar of asars) {
  for (const path of await readAsarPaths(asar)) {
    if (path.endsWith(".map")) maps.push(`${asar}:${path}`);
  }
}
if (maps.length > 0) {
  console.error(
    `${maps.length} source maps were packaged. Keep "!**/*.map" before every file set in electron-builder.config.json.`,
  );
  console.error(maps.slice(0, 20).join("\n"));
  process.exit(1);
}
console.log(`No source maps in ${asars.length} packaged app(s).`);
