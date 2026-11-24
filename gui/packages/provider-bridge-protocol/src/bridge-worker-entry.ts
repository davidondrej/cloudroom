import { rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPluginProcessTempDir } from "@cloudroom/process-utils";
import { readBoundedLines } from "./bridge-kit/bounded-line-reader.js";
import {
  createRecordingLineSplitter,
  getBridgeRecorder,
} from "./bridge-kit/bridge-recorder.js";
import {
  PROVIDER_BRIDGE_EXPORT_NAME,
  parseProviderBridgeEntry,
  type ProviderBridgeEntry,
} from "./bridge-kit/provider-bridge-entry.js";

const [bridgeModulePath, pluginId, dataDir, runtimeTempDir] =
  process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (
  bridgeModulePath === undefined ||
  !isAbsolute(bridgeModulePath) ||
  pluginId === undefined ||
  pluginId === "" ||
  dataDir === undefined ||
  !isAbsolute(dataDir)
) {
  fail(
    "provider bridge bootstrap usage: <bridgeModulePath> <pluginId> <pluginDataDir> [<tempDir>] (absolute paths)",
  );
}

// The runtime makes the folder. On Windows it removes it once this process and
// its children are gone: a Windows stop (TerminateProcess) skips all the
// cleanup below (#1578). The cleanup removes it too, so only a bridge folder in this
// plugin's own `.cloudroom-tmp` is taken; otherwise the bridge makes its own.
const givenTempDir =
  runtimeTempDir !== undefined && isAbsolute(runtimeTempDir)
    ? resolve(runtimeTempDir)
    : undefined;
const tempDir =
  givenTempDir !== undefined &&
  basename(givenTempDir).startsWith("bb-provider-bridge-") &&
  dirname(givenTempDir) === join(await realpath(dataDir), ".cloudroom-tmp")
    ? givenTempDir
    : await createPluginProcessTempDir({
        prefix: "bb-provider-bridge",
        dataDir,
      });

// Runs on stdin close and again at exit: async shutdown may still write here.
function removeTempDir(): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}
process.once("exit", removeTempDir);

const recorder = getBridgeRecorder();
if (recorder !== null) {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const outbound = createRecordingLineSplitter((line) =>
    recorder.recordRuntimeLine("bridge→runtime", line),
  );
  process.stdout.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    outbound.push(chunk);
    return (originalStdoutWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest,
    );
  }) as typeof process.stdout.write;
  process.once("exit", () => recorder.close());
}

let entry: ProviderBridgeEntry;
try {
  const imported: unknown = await import(pathToFileURL(bridgeModulePath).href);
  const parsed = parseProviderBridgeEntry(
    typeof imported === "object" && imported !== null
      ? Reflect.get(imported, PROVIDER_BRIDGE_EXPORT_NAME)
      : undefined,
  );
  if (parsed.entry === null) {
    fail(
      `plugin "${pluginId}" cannot run as a provider bridge: its host artifact ${parsed.problem} (${bridgeModulePath})`,
    );
  }
  entry = parsed.entry;
} catch (error) {
  removeTempDir();
  fail(
    `plugin "${pluginId}" failed to load its provider bridge: ${error instanceof Error ? error.message : String(error)}`,
  );
}

entry.start?.({ pluginId, dataDir, tempDir });

if (entry.onSigterm) {
  process.once("SIGTERM", entry.onSigterm);
} else {
  // The runtime stops bridges with SIGTERM, and dying by it skips the "exit"
  // cleanup. The temp folder is in the data folder, where no OS cleaner
  // removes it, so remove it and then die by the same signal.
  process.once("SIGTERM", () => {
    removeTempDir();
    process.kill(process.pid, "SIGTERM");
  });
}
if (entry.onSigint) {
  process.once("SIGINT", entry.onSigint);
}

readBoundedLines({
  input: process.stdin,
  onLine:
    recorder === null
      ? entry.handleLine
      : (line) => {
          recorder.recordRuntimeLine("runtime→bridge", line);
          entry.handleLine(line);
        },
  onOverflow: (bytes) => {
    process.stderr.write(
      `Discarded an oversized JSON-RPC line from the runtime (${bytes} bytes).\n`,
    );
  },
  onClose: () => {
    removeTempDir();
    entry.onClose?.();
  },
});
