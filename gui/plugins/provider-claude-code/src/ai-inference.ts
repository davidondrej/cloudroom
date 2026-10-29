import { spawn } from "node:child_process";
import os from "node:os";
import type {
  ExperimentalAiInferenceCompleteInput,
  ExperimentalAiInferenceCompleteOutput,
  ExperimentalAiServiceErrorCode,
} from "@get-bb/plugin-sdk/ai-services";
import { claudeExecutable } from "./bridge/provider-maintenance.js";
import { withoutBridgeRuntimeEnv } from "@get-bb/plugin-sdk/provider-bridge";

type InferenceValue = Extract<
  ExperimentalAiInferenceCompleteOutput,
  { ok: true }
>["value"];

interface ClaudePrintResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

function failure(
  code: ExperimentalAiServiceErrorCode,
  message: string,
): ExperimentalAiInferenceCompleteOutput {
  return { ok: false, code, message };
}

function parseResult(
  stdout: string,
  model: string,
): ExperimentalAiInferenceCompleteOutput {
  let result: ClaudePrintResult | undefined;
  for (const line of stdout.split("\n")) {
    try {
      const parsed: ClaudePrintResult = JSON.parse(line);
      if (parsed?.type === "result") result = parsed;
    } catch {}
  }
  if (!result) {
    return failure("invalid_response", "Claude Code returned no JSON result.");
  }
  let value = result.structured_output;
  if (!value && result.result && !result.is_error) {
    try {
      value = JSON.parse(result.result);
    } catch {}
  }
  if (
    result.is_error ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return failure(
      result.is_error ? "request_failed" : "invalid_response",
      result.result?.trim() || "Claude Code returned no structured result.",
    );
  }
  return { ok: true, model, value: value as InferenceValue };
}

/** One-shot structured inference through the signed-in `claude` CLI. */
export function completeClaudeInference(
  input: ExperimentalAiInferenceCompleteInput,
): Promise<ExperimentalAiInferenceCompleteOutput> {
  return new Promise((resolve) => {
    const env = withoutBridgeRuntimeEnv(process.env);
    delete env.CLAUDECODE;
    delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
    const child = spawn(
      claudeExecutable(),
      [
        "-p",
        "--model",
        input.model,
        ...(input.reasoningEffort === "none"
          ? []
          : ["--effort", input.reasoningEffort]),
        "--no-session-persistence",
        "--tools",
        "",
        "--no-chrome",
        "--setting-sources",
        "user",
        "--settings",
        '{"disableAllHooks":true}',
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        JSON.stringify(input.outputSchema),
      ],
      { cwd: os.homedir(), env, stdio: "pipe" },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(
        failure(
          "timeout",
          `Claude Code did not answer within ${input.timeoutMs}ms.`,
        ),
      );
    }, input.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve(
        failure(
          "request_failed",
          `Could not run Claude Code: ${error.message}`,
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const result = parseResult(stdout, input.model);
      const outcome =
        code !== 0 && !result.ok
          ? failure(
              "request_failed",
              stderr.trim() ||
                // Errors like a failed sign-in arrive in the JSON result, not on stderr.
                (result.code === "request_failed"
                  ? result.message
                  : `Claude Code exited with code ${code}.`),
            )
          : result;
      resolve(
        outcome.ok
          ? outcome
          : {
              ...outcome,
              message: outcome.message.replace(
                /sk-[a-zA-Z0-9_-]+/gu,
                "[redacted]",
              ),
            },
      );
    });
    // Spawn failures already surface through the child's error event.
    child.stdin.once("error", () => {});
    child.stdin.end(input.prompt);
  });
}
