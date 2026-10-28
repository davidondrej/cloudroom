import { type ChildProcess, spawn } from "node:child_process";
import {
  query,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type OnElicitation,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  experimental_isProviderBridgeRecording,
  experimental_killPortableProcess,
  experimental_recordProviderChildIo,
  experimental_spawnPortableProcess,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ClaudePermissionMode } from "../interactive-contract.js";
import {
  isMissingClaudeCliMessage,
  missingClaudeCliGuidance,
  translateMissingClaudeCliError,
} from "./missing-cli-error.js";

export interface SdkSessionOptions {
  cwd: string;
  systemPrompt: Exclude<Options["systemPrompt"], undefined>;
  model?: string;
  additionalDirectories?: readonly string[];
  effort?: Options["effort"];
  sessionId?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: Options["sandbox"];
  hooks?: Options["hooks"];
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
  onElicitation?: OnElicitation;
  env?: NodeJS.ProcessEnv;
  pathToClaudeCodeExecutable?: Options["pathToClaudeCodeExecutable"];
  plugins?: Options["plugins"];
  thinking?: Options["thinking"];
  settings?: Options["settings"];
  extraArgs?: Options["extraArgs"];
  recordThreadId?: () => string;
}

export type ClaudeSdkReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ClaudeMutableFlagSettings = {
  autoMemoryEnabled: boolean;
  enableWorkflows: boolean;
  effortLevel?: ClaudeSdkReasoningEffort;
  ultracode: boolean;
};

type SdkSessionMessageHandler = (message: SDKMessage) => void;
type SdkSessionDoneHandler = (error?: unknown) => void;

interface QueuedSdkInputMessage {
  message: SDKUserMessage;
  rejectConsumed: (error: Error) => void;
  resolveConsumed: () => void;
}

interface SdkPermissionOptions {
  allowDangerouslySkipPermissions?: true;
  permissionMode: ClaudePermissionMode;
}

interface BuildSdkPermissionOptionsArgs {
  permissionMode: ClaudePermissionMode | undefined;
}

interface AppendBoundedTextArgs {
  chunk: string;
  current: string;
}

interface BuildSdkDoneErrorMessageArgs {
  error: unknown;
  stderrTail: string;
}

const SDK_STDERR_TAIL_MAX_CHARS = 4_000;
const MCP_RECONNECT_MIN_COOLDOWN_MS = 60_000;
const MCP_RECONNECT_COOLDOWN_ATTEMPT_MULTIPLIER = 10;

function isCurrentProcessRoot(): boolean {
  return process.getuid?.() === 0;
}

function appendBoundedText(args: AppendBoundedTextArgs): string {
  const next = `${args.current}${args.chunk}`;
  if (next.length <= SDK_STDERR_TAIL_MAX_CHARS) {
    return next;
  }
  return next.slice(next.length - SDK_STDERR_TAIL_MAX_CHARS);
}

function getErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return isMissingClaudeCliMessage(message)
    ? missingClaudeCliGuidance()
    : message;
}

function buildSdkDoneErrorMessage(args: BuildSdkDoneErrorMessageArgs): string {
  const errorMessage = getErrorMessage(args.error);
  const stderrTail = args.stderrTail.trim();
  if (stderrTail.length === 0 || errorMessage.includes(stderrTail)) {
    return errorMessage;
  }
  return `${errorMessage}\n\nClaude Code stderr:\n${stderrTail}`;
}

function spawnClaudeProcess(args: {
  onSpawn?: (child: ChildProcess) => void;
  onStderr: (data: string) => void;
  record: boolean;
  spawnOptions: SpawnOptions;
  threadId: string | null;
}): SpawnedProcess {
  const { command, cwd, env, signal } = args.spawnOptions;
  // On Windows, Claude runs through the portable launcher (npm `.cmd` shims
  // work), and stopping it ends its whole process tree, so tool shells and
  // MCP servers don't outlive the thread. Ported from get-bb/bb#4661.
  const windows = process.platform === "win32";
  const child = windows
    ? experimental_spawnPortableProcess({
        command,
        args: args.spawnOptions.args,
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    : spawn(command, args.spawnOptions.args, {
        cwd,
        env,
        signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
  child.stderr?.setEncoding("utf8").on("data", (data: string) => {
    args.onStderr(data);
  });
  if (args.record) {
    experimental_recordProviderChildIo(child, { threadId: args.threadId });
  }
  if (!windows) return child as SpawnedProcess;
  args.onSpawn?.(child);
  signal.addEventListener("abort", () => void stopClaudeTree(child), {
    once: true,
  });
  return new Proxy(child, {
    get: (target, property) =>
      property === "kill"
        ? () => {
            void stopClaudeTree(target);
            return true;
          }
        : Reflect.get(target, property, target),
  }) as SpawnedProcess;
}

type ClaudeTreeStop = ReturnType<typeof experimental_killPortableProcess>;

const claudeTreeStops = new WeakMap<ChildProcess, ClaudeTreeStop>();

function stopClaudeTree(child: ChildProcess): ClaudeTreeStop {
  let stop = claudeTreeStops.get(child);
  if (!stop) {
    stop = experimental_killPortableProcess(child, "SIGTERM").then((result) => {
      if (result.treeTermination !== "confirmed") {
        claudeTreeStops.delete(child);
      }
      return result;
    });
    claudeTreeStops.set(child, stop);
  }
  return stop;
}

/**
 * The SDK spawn hook Claude needs: always on Windows (portable launch and
 * tree kill), and when recording provider I/O. Empty otherwise, so macOS and
 * Linux keep the SDK's own spawn.
 */
export function claudeSpawnOptions(args: {
  onSpawn?: (child: ChildProcess) => void;
  onStderr: (data: string) => void;
  record: boolean;
  threadId: () => string | null;
}): Pick<Options, "spawnClaudeCodeProcess"> {
  if (!args.record && process.platform !== "win32") return {};
  return {
    spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) =>
      spawnClaudeProcess({
        onSpawn: args.onSpawn,
        onStderr: args.onStderr,
        record: args.record,
        spawnOptions,
        threadId: args.threadId(),
      }),
  };
}

function buildSdkPermissionOptions(
  args: BuildSdkPermissionOptionsArgs,
): SdkPermissionOptions {
  const permissionMode = args.permissionMode ?? "default";
  if (permissionMode !== "bypassPermissions") {
    return { permissionMode };
  }

  if (isCurrentProcessRoot()) {
    return { permissionMode: "default" };
  }

  return {
    permissionMode,
    allowDangerouslySkipPermissions: true,
  };
}

export class SdkSession {
  private query: Query | undefined;
  private sessionId: string | undefined;
  private inputResolve:
    | ((value: IteratorResult<SDKUserMessage>) => void)
    | null = null;
  private readonly inputQueue: QueuedSdkInputMessage[] = [];
  private inputDone = false;
  private readonly abortController = new AbortController();
  private readonly completion: Promise<void>;
  private complete: (() => void) | null = null;
  private stderrTail = "";
  /** Windows only: Claude's launcher, whose tree a stop ends first. */
  private windowsChild: ChildProcess | null = null;
  private stopping = false;
  private mcpReconnecting = false;
  private readonly mcpRetryAt = new Map<string, number>();

  constructor(
    private readonly options: SdkSessionOptions,
    private readonly onMessage: SdkSessionMessageHandler,
    private readonly onDone: SdkSessionDoneHandler,
  ) {
    this.completion = new Promise((resolve) => {
      this.complete = resolve;
    });
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  canPushInput(): boolean {
    return !this.inputDone && !this.stopping;
  }

  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.options.permissionMode = mode;
    await this.query?.setPermissionMode(mode);
  }

  async getContextUsage(): Promise<unknown> {
    return this.query ? this.query.getContextUsage() : null;
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.query?.setModel(model);
    this.options.model = model;
  }

  async reconnectFailedMcpServers(): Promise<void> {
    const q = this.query;
    if (!q || this.mcpReconnecting) return;
    this.mcpReconnecting = true;
    let reconnects: Promise<void>[] = [];
    try {
      const now = Date.now();
      reconnects = (await q.mcpServerStatus())
        .filter(
          (server) =>
            server.status === "failed" &&
            now >= (this.mcpRetryAt.get(server.name) ?? 0),
        )
        .map((server) => this.reconnectMcpServer(q, server.name));
    } finally {
      void Promise.all(reconnects).then(() => {
        this.mcpReconnecting = false;
      });
    }
  }

  private async reconnectMcpServer(q: Query, name: string): Promise<void> {
    const startedAt = Date.now();
    try {
      await q.reconnectMcpServer(name);
      this.mcpRetryAt.delete(name);
    } catch {
      const failedAt = Date.now();
      this.mcpRetryAt.set(
        name,
        failedAt +
          Math.max(
            MCP_RECONNECT_MIN_COOLDOWN_MS,
            MCP_RECONNECT_COOLDOWN_ATTEMPT_MULTIPLIER * (failedAt - startedAt),
          ),
      );
    }
  }

  async applyMutableSettings(args: {
    effort: ClaudeSdkReasoningEffort | undefined;
    settings: ClaudeMutableFlagSettings;
  }): Promise<void> {
    await this.query?.applyFlagSettings(args.settings);
    this.options.effort = args.effort;
    const { effortLevel: _effortLevel, ...sessionSettings } = args.settings;
    const currentSettings =
      typeof this.options.settings === "object" ? this.options.settings : {};
    this.options.settings = {
      ...currentSettings,
      ...sessionSettings,
    };
  }

  start(resumeSessionId?: string): void {
    if (resumeSessionId) {
      this.sessionId = resumeSessionId;
    } else if (this.options.sessionId) {
      this.sessionId = this.options.sessionId;
    }

    this.stderrTail = "";
    const permissionOptions = buildSdkPermissionOptions({
      permissionMode: this.options.permissionMode,
    });
    const onStderr = (data: string): void => {
      this.stderrTail = appendBoundedText({
        current: this.stderrTail,
        chunk: data,
      });
    };
    const recordThreadId = this.options.recordThreadId;
    const sdkOptions: Options = {
      abortController: this.abortController,
      cwd: this.options.cwd,
      systemPrompt: this.options.systemPrompt,
      ...permissionOptions,
      ...claudeSpawnOptions({
        onSpawn: (child) => {
          this.windowsChild = child;
        },
        onStderr,
        record: experimental_isProviderBridgeRecording(),
        threadId: () => recordThreadId?.() ?? null,
      }),
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      persistSession: true,
      env: this.options.env ?? process.env,
      stderr: onStderr,
      ...(this.options.mcpServers
        ? { mcpServers: this.options.mcpServers }
        : {}),
      ...(this.options.allowedTools
        ? { allowedTools: this.options.allowedTools }
        : {}),
      ...(this.options.disallowedTools
        ? { disallowedTools: this.options.disallowedTools }
        : {}),
      ...(this.options.canUseTool
        ? { canUseTool: this.options.canUseTool }
        : {}),
      ...(this.options.onElicitation
        ? { onElicitation: this.options.onElicitation }
        : {}),
      ...(this.options.sandbox ? { sandbox: this.options.sandbox } : {}),
      ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(!resumeSessionId && this.options.sessionId
        ? { sessionId: this.options.sessionId }
        : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.additionalDirectories
        ? { additionalDirectories: [...this.options.additionalDirectories] }
        : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      ...(this.options.pathToClaudeCodeExecutable
        ? {
            pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable,
          }
        : {}),
      ...(this.options.plugins ? { plugins: this.options.plugins } : {}),
      ...(this.options.thinking ? { thinking: this.options.thinking } : {}),
      ...(this.options.settings ? { settings: this.options.settings } : {}),
      ...(this.options.extraArgs ? { extraArgs: this.options.extraArgs } : {}),
    };

    try {
      this.query = query({
        prompt: this.createInputIterable(),
        options: sdkOptions,
      });
    } catch (error) {
      throw translateMissingClaudeCliError(error);
    }

    void this.consumeStream();
  }

  pushInput(
    text: string,
    promptId?: NonNullable<SDKUserMessage["uuid"]>,
  ): Promise<void> {
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
      ...(promptId !== undefined ? { uuid: promptId } : {}),
    };

    if (this.inputDone || this.stopping) {
      return Promise.reject(new Error("Claude SDK input stream is closed"));
    }

    let resolveConsumed = (): void => {};
    let rejectConsumed = (_error: Error): void => {};
    const consumed = new Promise<void>((resolve, reject) => {
      resolveConsumed = resolve;
      rejectConsumed = reject;
    });

    if (this.inputResolve) {
      const resolve = this.inputResolve;
      this.inputResolve = null;
      resolve({ value: message, done: false });
      resolveConsumed();
      return consumed;
    }

    this.inputQueue.push({
      message,
      rejectConsumed,
      resolveConsumed,
    });
    return consumed;
  }

  /**
   * On Windows, Claude's whole tree ends before its stdin closes: once Claude
   * exits, taskkill can no longer find the tool shells it left behind.
   */
  stop(): Promise<void> {
    if (process.platform !== "win32") {
      this.endSession();
      return Promise.resolve();
    }
    return this.stopWindowsTree();
  }

  private async stopWindowsTree(): Promise<void> {
    this.stopping = true;
    this.rejectQueuedInputs("Claude SDK session stopped before input consumed");
    const child = this.windowsChild;
    let stopped: Awaited<ClaudeTreeStop> = { treeTermination: "confirmed" };
    try {
      if (child) stopped = await stopClaudeTree(child);
    } finally {
      this.endSession();
    }
    if (stopped.treeTermination !== "confirmed") {
      throw new Error(
        "Claude stopped, but Cloudroom could not confirm its tool processes ended. Some may still be running.",
      );
    }
  }

  private endSession(): void {
    this.inputDone = true;
    this.rejectQueuedInputs("Claude SDK session stopped before input consumed");
    this.resolveInputDone();
    this.abortController.abort();
    this.query?.close();
    this.query = undefined;
  }

  async closeGracefully(timeoutMs: number): Promise<void> {
    if (process.platform === "win32") {
      await this.stop();
      return;
    }
    this.inputDone = true;
    this.rejectQueuedInputs("Claude SDK session closed before input consumed");
    this.resolveInputDone();

    if (!this.query) {
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.completion,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Claude SDK session did not close within ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } catch {
      void this.stop();
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private createInputIterable(): AsyncIterable<SDKUserMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SDKUserMessage>> {
            if (self.inputQueue.length > 0) {
              const queued = self.inputQueue.shift();
              if (!queued) {
                return { value: undefined, done: true };
              }
              queued.resolveConsumed();
              return { value: queued.message, done: false };
            }
            if (self.inputDone) {
              return { value: undefined, done: true };
            }
            return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
              self.inputResolve = resolve;
            });
          },
          async return(): Promise<IteratorResult<SDKUserMessage>> {
            self.inputDone = true;
            self.rejectQueuedInputs(
              "Claude SDK input iterator closed before input consumed",
            );
            self.resolveInputDone();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  private resolveInputDone(): void {
    if (!this.inputResolve) return;
    const resolve = this.inputResolve;
    this.inputResolve = null;
    resolve({ value: undefined, done: true });
  }

  private rejectQueuedInputs(message: string): void {
    const error = new Error(message);
    while (this.inputQueue.length > 0) {
      const queued = this.inputQueue.shift();
      if (!queued) {
        return;
      }
      queued.rejectConsumed(error);
    }
  }

  private async consumeStream(): Promise<void> {
    const q = this.query;
    if (!q) return;

    try {
      for await (const message of q) {
        this.captureSessionId(message);
        this.onMessage(message);
      }
      this.onDone();
    } catch (error) {
      this.onDone(
        new Error(
          buildSdkDoneErrorMessage({
            error,
            stderrTail: this.stderrTail,
          }),
        ),
      );
    } finally {
      this.inputDone = true;
      this.rejectQueuedInputs("Claude SDK stream ended before input consumed");
      this.resolveInputDone();
      this.query = undefined;
      if (this.complete) {
        this.complete();
        this.complete = null;
      }
    }
  }

  private captureSessionId(message: SDKMessage): void {
    const { session_id } = message;
    const providerThreadId = session_id?.trim() ?? "";
    if (providerThreadId.length > 0) {
      this.sessionId = providerThreadId;
    }
  }
}
