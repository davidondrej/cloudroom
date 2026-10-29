import { randomBytes } from "node:crypto";
import { GENERATED_ID_ALPHABET, GENERATED_ID_SUFFIX_LENGTH } from "@cloudroom/domain";

function createId(prefix: string): string {
  let suffix = "";
  for (const byte of randomBytes(GENERATED_ID_SUFFIX_LENGTH)) {
    suffix += GENERATED_ID_ALPHABET[byte % GENERATED_ID_ALPHABET.length];
  }
  return `${prefix}_${suffix}`;
}

export function createHostId(): string {
  return createId("host");
}

export function createProjectId(): string {
  return createId("proj");
}

export function createProjectSourceId(): string {
  return createId("src");
}

export function createEnvironmentId(): string {
  return createId("env");
}

export function createThreadId(): string {
  return createId("thr");
}

export function createThreadSectionId(): string {
  return createId("sec");
}

export function createThreadProvisioningId(): string {
  return createId("tpv");
}

export function createEventId(): string {
  return createId("evt");
}

export function createPromptHistoryEntryId(): string {
  return createId("phist");
}

export function createQueuedThreadMessageId(): string {
  return createId("qmsg");
}

export function createQueuedThreadMessageClaimToken(): string {
  return createId("qclaim");
}

export function createPendingInteractionId(): string {
  return createId("pint");
}

export function createHostDaemonSessionId(): string {
  return createId("hses");
}

export function createTerminalSessionId(): string {
  return createId("term");
}
