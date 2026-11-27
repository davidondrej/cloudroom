import { createHash } from "node:crypto";
import {
  GENERATED_ID_ALPHABET,
  GENERATED_ID_SUFFIX_LENGTH,
} from "@cloudroom/domain";

/** A Local spawn's request ID names its thread within its project, so a retry
 *  after an unanswered request finds that thread instead of a duplicate (#860).
 *  The CLI reads it there when the answer is lost (#2446). */
export function requestThreadId(projectId: string, requestId: string): string {
  const digest = createHash("sha256")
    .update(`spawn:${projectId}:${requestId}`)
    .digest();
  const suffix = [...digest.subarray(0, GENERATED_ID_SUFFIX_LENGTH)].map(
    (byte) => GENERATED_ID_ALPHABET[byte % GENERATED_ID_ALPHABET.length],
  );
  return `thr_${suffix.join("")}`;
}
