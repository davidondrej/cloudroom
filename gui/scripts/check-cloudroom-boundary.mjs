// Enforces modularity and direct-import boundaries in the rewritten Cloudroom command stack.
// 1. Only host-bridge.ts in the command stack may directly import ../threads/, ../plugins/, ../system/, or ../lib/.
// 2. Every file in the command stack must exist and stay <= MAX_CODE_LINES non-comment, non-blank code lines.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../apps/server/src/services/cloudroom", import.meta.url));
const MAX_CODE_LINES = 650;
const HOST_BRIDGE = "host-bridge.ts";
const MODULAR_FILES = [
  "commands.ts",
  "protocol.ts",
  "runtime.ts",
  "account-auth.ts",
  "status-previews.ts",
  "transfers.ts",
  "children.ts",
  "lifecycle.ts",
  "queue.ts",
  "messaging.ts",
  "stream.ts",
  "delivery.ts",
];

const FORBIDDEN_IMPORT = /(?:from|import)\s*\(?\s*["']\.\.\/(?:threads|plugins|system|lib)\//g;

/** Count non-blank, non-comment code lines so preserving "why" comments never trips the file cap. */
function countCodeLines(source) {
  let codeLines = 0;
  let inBlockComment = false;
  for (const raw of source.split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      inBlockComment = false;
      line = line.slice(end + 2).trim();
      if (!line) continue;
    }
    while (line.startsWith("/*")) {
      const end = line.indexOf("*/", 2);
      if (end === -1) {
        inBlockComment = true;
        line = "";
        break;
      }
      line = line.slice(end + 2).trim();
    }
    if (!line || line.startsWith("//")) continue;
    codeLines++;
  }
  return codeLines;
}

const errors = [];
const allFiles = [HOST_BRIDGE, ...MODULAR_FILES];

for (const name of allFiles) {
  const file = join(DIR, name);
  if (!existsSync(file)) {
    errors.push(`${file}: expected Cloudroom command-stack file is missing`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  const codeLines = countCodeLines(text);
  if (codeLines > MAX_CODE_LINES) {
    errors.push(`${file}: ${codeLines} code lines exceeds max ${MAX_CODE_LINES} (split into smaller modules instead of growing a god file)`);
  }
  if (name === HOST_BRIDGE) continue;
  for (const match of text.matchAll(FORBIDDEN_IMPORT)) {
    const line = text.slice(0, match.index).split("\n").length;
    errors.push(`${file}:${line}: forbidden host-internal import (${match[0].trim()}). Route host access through host-bridge.ts.`);
  }
}

if (errors.length > 0) {
  for (const err of errors) console.error(err);
  process.exit(1);
}
console.log(`cloudroom boundary: ${allFiles.length} command-stack files verified (${MODULAR_FILES.length} guarded against host-internal imports, 0 leaks, all <= ${MAX_CODE_LINES} code lines)`);
