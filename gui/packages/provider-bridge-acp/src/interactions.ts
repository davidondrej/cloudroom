import {
  isApprovalPendingInteractionPayload,
  isApprovalPendingInteractionResolution,
} from "@cloudroom/domain";
import type {
  PendingInteractionApprovalDecision,
  PendingInteractionApprovalSubject,
  PendingInteractionPayload,
  PendingInteractionResolution,
} from "@cloudroom/domain";
import { toolKindPresentation } from "./presentation.js";
import {
  type AcpToolCallOperation,
  type AcpToolCallOperationInput,
  type AcpToolCallPathOptions,
  classifyAcpToolCall as classifyAcpToolCallOperation,
  extractAcpCommand,
  extractAcpToolCallPaths,
  resolveAcpFileChangeWriteScope,
} from "./tool-call-operation.js";
import {
  classifyAcpToolCall,
  extractAcpToolCallOutputText,
  type AcpInjectedTool,
} from "./tool-classification.js";
import {
  extractAcpContentText,
  type AcpPermissionOptionKind,
  type AcpToolCallUpdateEvent,
  type AcpToolKind,
} from "./wire.js";
import type { AcpDialect } from "./dialect.js";

type AcpDialectToolCallClassifier = NonNullable<AcpDialect["classifyToolCall"]>;

type ToolUseApprovalSubject = Extract<
  PendingInteractionApprovalSubject,
  { kind: "tool_use" }
>;

interface AcpPermissionResponse {
  decision: "allow_once" | "allow_for_session" | "deny";
}

interface AcpPermissionToolCall extends AcpToolCallOperationInput {
  toolCallId: string;
  kind?: AcpToolKind | undefined;
  rawKind?: string | undefined;
  startedToolCall?: AcpToolCallUpdateEvent | undefined;
  injectedTool?: AcpInjectedTool | undefined;
}

function rawInputCommand(rawInput: unknown): string | undefined {
  return extractAcpCommand({ rawInput });
}

// The args JSON the agent streamed into a call that has not run yet; never its output.
function streamedArgsCommand(
  started: AcpToolCallUpdateEvent,
): string | undefined {
  const entry = started.content?.length === 1 ? started.content[0] : undefined;
  if (
    entry?.type !== "content" ||
    started.rawOutput !== undefined ||
    started.status === "completed" ||
    started.status === "failed"
  ) {
    return undefined;
  }
  const text = extractAcpContentText(entry.content);
  try {
    return text === undefined ? undefined : rawInputCommand(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function classifyAcpPermission(
  toolCall: AcpPermissionToolCall,
  options: AcpToolCallPathOptions | undefined,
  streamedArgsTitle: string | undefined,
): AcpToolCallOperation {
  const own = classifyAcpToolCallOperation(toolCall, options);
  const started = toolCall.startedToolCall;
  const operation =
    own.kind !== "generic" || !started
      ? own
      : classifyAcpToolCallOperation(started, options);
  if (
    !started ||
    operation.kind !== "command" ||
    operation.command !== streamedArgsTitle
  ) {
    return operation;
  }
  const source = operation === own ? toolCall : started;
  if (rawInputCommand(source.rawInput) !== undefined) {
    return operation;
  }
  // Kimi asks before it sends rawInput, so the title is just "Bash" and the command is only in the streamed args (#2433).
  const command =
    rawInputCommand(toolCall.rawInput) ??
    rawInputCommand(started.rawInput) ??
    streamedArgsCommand(started);
  return command === undefined ? operation : { kind: "command", command };
}

function permissionToolCallEvent(
  toolCall: AcpPermissionToolCall,
): AcpToolCallUpdateEvent {
  return {
    sessionUpdate: "tool_call",
    toolCallId: toolCall.toolCallId,
    ...(toolCall.title !== undefined ? { title: toolCall.title } : {}),
    ...(toolCall.kind !== undefined ? { kind: toolCall.kind } : {}),
    ...(toolCall.rawKind !== undefined ? { rawKind: toolCall.rawKind } : {}),
    ...(toolCall.content !== undefined
      ? { content: [...toolCall.content] }
      : {}),
    ...(toolCall.locations !== undefined
      ? { locations: [...toolCall.locations] }
      : {}),
    ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
  };
}

function buildToolUseSubject(
  toolCall: AcpPermissionToolCall | undefined,
  options: AcpToolCallPathOptions | undefined,
  dialectClassify: AcpDialectToolCallClassifier | undefined,
): ToolUseApprovalSubject {
  if (toolCall === undefined) {
    return {
      kind: "tool_use",
      itemId: "acp-permission",
      tool: "tool",
      presentation: toolKindPresentation({
        kind: undefined,
        title: "ACP permission request",
      }),
    };
  }
  const classify = (event: AcpToolCallUpdateEvent) =>
    (toolCall.injectedTool === undefined
      ? dialectClassify?.(event)
      : undefined) ??
    classifyAcpToolCall(event, toolCall.injectedTool, options);
  const own = classify(permissionToolCallEvent(toolCall));
  const described =
    own.presentation.title === undefined && toolCall.startedToolCall
      ? classify(toolCall.startedToolCall)
      : own;
  return {
    kind: "tool_use",
    itemId: toolCall.toolCallId,
    tool:
      described.item.type === "tool"
        ? described.item.tool
        : (toolCall.kind ??
          toolCall.startedToolCall?.kind ??
          described.item.type),
    presentation: described.presentation,
  };
}

function permissionReason(
  toolCall: AcpPermissionToolCall | undefined,
): string | undefined {
  if (toolCall === undefined || toolCall.content === undefined) {
    return undefined;
  }
  return extractAcpToolCallOutputText({
    sessionUpdate: "tool_call",
    toolCallId: toolCall.toolCallId,
    content: [...toolCall.content],
  });
}

export function buildAcpApprovalDecisions(
  options: readonly { kind: AcpPermissionOptionKind }[],
): PendingInteractionApprovalDecision[] {
  const kinds = new Set(options.map((option) => option.kind));
  const decisions: PendingInteractionApprovalDecision[] = [];
  if (kinds.has("allow_once")) {
    decisions.push("allow_once");
  }
  if (kinds.has("allow_always")) {
    decisions.push("allow_for_session");
  }
  if (kinds.has("reject_once") || kinds.has("reject_always")) {
    decisions.push("deny");
  }
  return decisions.length > 0 ? decisions : ["deny"];
}

export function buildAcpPermissionInteractionPayload(args: {
  toolCall: AcpPermissionToolCall | undefined;
  options: readonly { kind: AcpPermissionOptionKind }[];
  cwd?: string | undefined;
  classifyToolCall?: AcpDialectToolCallClassifier | undefined;
  // The bare title of the agent's own call that has its command only in the streamed args.
  streamedArgsTitle?: string | undefined;
}): PendingInteractionPayload {
  const toolCall = args.toolCall;
  const pathOptions = { cwd: args.cwd };
  const availableDecisions = buildAcpApprovalDecisions(args.options);
  const reason = permissionReason(toolCall) ?? null;
  const operation = toolCall
    ? classifyAcpPermission(toolCall, pathOptions, args.streamedArgsTitle)
    : undefined;
  if (toolCall && operation?.kind === "file_change") {
    const ownPaths = extractAcpToolCallPaths(toolCall, pathOptions);
    return {
      kind: "approval",
      subject: {
        kind: "file_change",
        itemId: toolCall.toolCallId,
        writeScope: resolveAcpFileChangeWriteScope(
          ownPaths.length > 0 ? ownPaths : operation.paths,
        ),
        sessionGrant: null,
      },
      reason,
      availableDecisions,
    };
  }
  if (toolCall && operation?.kind === "command") {
    return {
      kind: "approval",
      subject: {
        kind: "command",
        itemId: toolCall.toolCallId,
        command: operation.command,
        cwd: null,
        actions: [{ type: "unknown", command: operation.command }],
        sessionGrant: null,
      },
      reason,
      availableDecisions,
    };
  }
  return {
    kind: "approval",
    subject: buildToolUseSubject(toolCall, pathOptions, args.classifyToolCall),
    reason,
    availableDecisions,
  };
}

export function resolveAcpPermissionDecision(args: {
  payload: PendingInteractionPayload;
  resolution: PendingInteractionResolution;
}): AcpPermissionResponse | null {
  if (
    !isApprovalPendingInteractionPayload(args.payload) ||
    !isApprovalPendingInteractionResolution(args.resolution)
  ) {
    return null;
  }
  return { decision: args.resolution.decision };
}
