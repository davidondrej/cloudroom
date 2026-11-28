import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { createBridgeRecorder } from "../src/bridge-kit/bridge-recorder.js";

const REDACT_SCRIPT = new URL(
  "../../../scripts/provider-recordings/redact.mjs",
  import.meta.url,
);

it("masks the ACP tool token in new recordings and exports of older recordings", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-recording-redact-"));
  const raw = join(root, "raw");
  const output = join(root, "output");
  const recorder = createBridgeRecorder({ dir: raw });
  const marker = "fixture-marker";
  const env = [
    { name: "BB_ACP_DYNAMIC_TOOL_TOKEN", value: marker },
    { name: "LANG", value: "en_US" },
    { name: "EMPTY_TOKEN", value: "" },
  ];
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: { mcpServers: [{ name: "bb-bridge", env }] },
  });
  try {
    const stdin = new PassThrough();
    recorder.recordChildIo({ stdin }, { threadId: "thr_acp" });
    stdin.write(line + "\n");
    expect(stdin.read().toString()).toBe(line + "\n");

    // Older recordings reach the export command without the recorder's current masking.
    writeFileSync(join(raw, "legacy.ndjson"), JSON.stringify({ line }) + "\n");
    execFileSync(process.execPath, [
      fileURLToPath(REDACT_SCRIPT), raw, output, "--home", "/home/tester",
    ]);

    const masked = line.replace(marker, "REDACTED");
    for (const file of [
      join(raw, "thr_acp", "bridge→provider.ndjson"),
      join(output, "legacy.ndjson"),
    ]) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { line: string };
      expect.soft(saved.line, file).toBe(masked);
    }
  } finally {
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("redacts every documented GitHub token prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-recording-redact-"));
  const inputDir = join(root, "input");
  const outputDir = join(root, "output");
  const tokens = [
    `ghp_${"a".repeat(36)}`,
    `gho_${"b".repeat(36)}`,
    `ghu_${"c".repeat(36)}`,
    `ghs_${"d".repeat(36)}`,
    `ghs_12345_${"e".repeat(12)}.${"f".repeat(12)}.${"g".repeat(12)}`,
    `ghr_${"h".repeat(36)}`,
    `github_pat_${"i".repeat(82)}`,
  ];

  try {
    mkdirSync(inputDir);
    writeFileSync(
      join(inputDir, "github.ndjson"),
      `${JSON.stringify({ line: JSON.stringify({ tokens }) })}\n`,
    );

    const stdout = execFileSync(
      process.execPath,
      [
        fileURLToPath(REDACT_SCRIPT),
        inputDir,
        outputDir,
        "--home",
        "/home/tester",
      ],
      { encoding: "utf8" },
    );
    const output = readFileSync(join(outputDir, "github.ndjson"), "utf8");

    expect(stdout).toContain("0 survivors");
    for (const token of tokens) expect(output).not.toContain(token);
    expect(output.match(/REDACTED/g)).toHaveLength(tokens.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
