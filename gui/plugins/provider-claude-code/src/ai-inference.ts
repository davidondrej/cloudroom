import { spawn } from "node:child_process";
import os from "node:os";
import type {
  ExperimentalAiInferenceCompleteInput,
  ExperimentalAiInferenceCompleteOutput,
  ExperimentalAiServiceErrorCode,
} from "@get-bb/plugin-sdk/ai-services";
import { withoutBlankAccountEnv } from "./bridge/bridge.js";
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
      // A plain-text answer may wrap the JSON in a code fence or a few words.
      const text = result.result;
      value = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
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

// Files Claude may never open while exploring a project folder, so no key can reach a summary.
const SECRET_FILES = ["**/.env*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa*", "**/id_ed25519*",
  "**/.npmrc", "**/.netrc", "**/.pypirc", "**/.git/**", "**/*credentials*"];

/** One-shot structured inference through the signed-in `claude` CLI. */
export function completeClaudeInference(
  input: ExperimentalAiInferenceCompleteInput,
): Promise<ExperimentalAiInferenceCompleteOutput> {
  return new Promise((resolve) => {
    // `input.env` is the login the user's Claude threads run on; without it, this is the machine's own login.
    const env = withoutBlankAccountEnv({
      ...withoutBridgeRuntimeEnv(process.env),
      ...input.env,
    });
    delete env.CLAUDECODE;
    delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
    const schema = JSON.stringify(input.outputSchema);
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
        // With a folder, it explores it read-only: --restricted keeps file tools inside it and ignores settings files
        // that could widen access, and the deny list keeps secret files shut. Otherwise it answers from the prompt alone.
        "--tools",
        input.folder ? "Read,Grep,Glob" : "",
        ...(input.folder ? ["--restricted"] : []),
        "--no-chrome",
        "--setting-sources",
        "user",
        "--settings",
        JSON.stringify({
          disableAllHooks: true,
          ...(input.folder ? { permissions: { deny: SECRET_FILES.map((path) => `Read(${path})`) } } : {}),
        }),
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--output-format",
        "stream-json",
        "--verbose",
        // Claude Code's schema tool costs a second model round. Without a folder there are no tool calls to keep in shape,
        // so a short system prompt asks for the JSON as plain text: about 0.3 s faster and half the tokens.
        ...(input.folder
          ? ["--json-schema", schema]
          : [
              "--system-prompt",
              `Answer with only a JSON object that matches this JSON schema. No other text, no code fence.\n${schema}`,
            ]),
      ],
      { cwd: input.folder ?? os.homedir(), env, stdio: "pipe" },
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
      // The result line is the answer. Claude Code takes about 0.75 s more to exit, so answer now.
      // Later resolve calls do nothing, and the timer still kills a process that never exits.
      if (stdout.includes('"type":"result"')) {
        const result = parseResult(stdout, input.model);
        if (result.ok) resolve(result);
      }
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
