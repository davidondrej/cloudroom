import type { ThreadRuntimeDisplayStatus } from "@cloudroom/domain";
import { assertNever } from "@cloudroom/core-ui";

export const PROMPT_PLACEHOLDER_HINT = "@ to tag an Agent";

export function getFollowUpPromptPlaceholder(
  displayStatus: ThreadRuntimeDisplayStatus,
): string {
  switch (displayStatus) {
    case "provisioning":
      return "Setting up workspace...";
    case "starting":
      return "Starting thread...";
    case "stopping":
      return "Queue a message to run after the stop";
    case "waiting-for-host":
      return "Host disconnected";
    case "host-reconnecting":
      return "Waiting for host to reconnect...";
    case "error":
      return "Retry by sending a follow-up message";
    case "pending":
    case "idle":
    case "active":
      return "Ask Cloudroom";
    default:
      return assertNever(displayStatus);
  }
}

export function getCompactFollowUpPromptPlaceholder(
  displayStatus: ThreadRuntimeDisplayStatus,
): string {
  switch (displayStatus) {
    case "provisioning":
      return "Setting up...";
    case "starting":
      return "Starting...";
    case "stopping":
      return "Queue for after the stop";
    case "waiting-for-host":
      return "Host disconnected";
    case "host-reconnecting":
      return "Reconnecting...";
    case "error":
      return "Send a follow-up";
    case "pending":
    case "idle":
    case "active":
      return "Ask Cloudroom";
    default:
      return assertNever(displayStatus);
  }
}

export function getFollowUpPromptPlaceholderHint(
  displayStatus: ThreadRuntimeDisplayStatus,
): string | undefined {
  return displayStatus === "pending" ||
    displayStatus === "idle" ||
    displayStatus === "active"
    ? PROMPT_PLACEHOLDER_HINT
    : undefined;
}
