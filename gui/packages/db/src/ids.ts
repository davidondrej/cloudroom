import { randomBytes } from "node:crypto";
import { GENERATED_ID_ALPHABET, GENERATED_ID_SUFFIX_LENGTH } from "@cloudroom/domain";

function randomSuffix(): string {
  let suffix = "";
  for (const byte of randomBytes(GENERATED_ID_SUFFIX_LENGTH)) {
    suffix += GENERATED_ID_ALPHABET[byte % GENERATED_ID_ALPHABET.length];
  }
  return suffix;
}

function createId(prefix: string): string {
  return `${prefix}_${randomSuffix()}`;
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

const EVENT_ID_TIME_LENGTH = 9;

/**
 * Starts with the time, so new events land next to each other in the primary key index. A fully random ID put
 * every insert on a random page of that index, and each one is a 4 KB disk write (#1248). The alphabet is in
 * byte order, so IDs sort by time. Nothing reads the time back: the event's order is its `sequence`.
 */
export function createEventId(): string {
  let time = "";
  let rest = Date.now();
  for (let position = 0; position < EVENT_ID_TIME_LENGTH; position += 1) {
    time = GENERATED_ID_ALPHABET[rest % GENERATED_ID_ALPHABET.length] + time;
    rest = Math.floor(rest / GENERATED_ID_ALPHABET.length);
  }
  return `evt_${time}${randomSuffix()}`;
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
