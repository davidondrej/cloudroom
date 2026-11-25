// Risky local actions need a human click (ADR 0260). The desktop app makes a
// key pair at launch and gives the server it starts only the public half. It
// signs its own window's requests for these actions, so nothing an agent can
// read (files, env, the server's memory) lets it make one.
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export const HUMAN_CLICK_HEADER = "x-cloudroom-human-click";
export const HUMAN_CLICK_PUBLIC_KEY_ENV = "CLOUDROOM_HUMAN_CLICK_KEY";
export const HUMAN_CLICK_REQUIRED_CODE = "human_click_required";
/** The thread whose agent asks, so the app can say who wants it. Informational only. */
export const HUMAN_CLICK_THREAD_HEADER = "x-cloudroom-asking-thread";

const MAX_AGE_MS = 30_000;
const MAX_HEADER_LENGTH = 256;

const ACTIONS = [
  ["plugin-install", /^\/api\/v1\/plugins\/install$/u],
  ["plugin-catalog-install", /^\/api\/v1\/plugin-catalog\/install$/u],
  ["plugin-update", /^\/api\/v1\/plugins\/[^/]+\/update$/u],
  ["approve", /^\/api\/v1\/human-clicks\/[^/]+\/approve$/u],
  ["decline", /^\/api\/v1\/human-clicks\/[^/]+\/decline$/u],
  ["mac-access", /^\/api\/v1\/cloudroom\/account\/mac-access$/u],
  [
    "interaction-respond",
    /^\/api\/v1\/threads\/[^/]+\/interactions\/[^/]+\/respond$/u,
  ],
] as const;

export type HumanClickAction = (typeof ACTIONS)[number][0];

/** The action a request asks for, or null when it needs no human click. */
export function humanClickAction(
  method: string,
  path: string,
): HumanClickAction | null {
  if (method.toUpperCase() !== "POST") return null;
  return ACTIONS.find(([, pattern]) => pattern.test(path))?.[0] ?? null;
}

const signedText = (
  method: string,
  path: string,
  time: string,
  nonce: string,
): Buffer => Buffer.from(`${method.toUpperCase()} ${path} ${time} ${nonce}`);

export interface HumanClickSigner {
  /** For the server's environment. Public, so it may be read by anyone. */
  publicKey: string;
  /** The header value for a request, or null when it needs no human click. */
  sign(method: string, path: string): string | null;
}

export function createHumanClickSigner(): HumanClickSigner {
  const keys = generateKeyPairSync("ed25519");
  return {
    publicKey: keys.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    sign(method, path) {
      if (humanClickAction(method, path) === null) return null;
      const time = String(Date.now());
      const nonce = randomBytes(12).toString("base64url");
      const signature = sign(
        null,
        signedText(method, path, time, nonce),
        keys.privateKey,
      ).toString("base64url");
      return `${time}.${nonce}.${signature}`;
    },
  };
}

export interface HumanClickVerifier {
  /** False when the server was started without a key: then nothing is refused. */
  enabled: boolean;
  /** True when the key it was given can't be read: then nothing verifies. */
  broken: boolean;
  /** True once for each fresh header the desktop app signed for this request. */
  verify(header: string | undefined, method: string, path: string): boolean;
}

export function createHumanClickVerifier(
  publicKey: string | undefined,
  now: () => number = Date.now,
): HumanClickVerifier {
  let key: KeyObject | null = null;
  if (publicKey !== undefined) {
    try {
      key = createPublicKey({
        format: "der",
        key: Buffer.from(publicKey, "base64"),
        type: "spki",
      });
    } catch {
      // A key that can't be read verifies nothing, so every action is refused.
    }
  }
  const used = new Map<string, number>();
  return {
    enabled: publicKey !== undefined,
    broken: publicKey !== undefined && key === null,
    verify(header, method, path) {
      if (key === null || header === undefined) return false;
      if (header.length > MAX_HEADER_LENGTH) return false;
      const [time = "", nonce = "", signature = "", extra] = header.split(".");
      if (extra !== undefined || !/^\d{1,16}$/u.test(time)) return false;
      if (!/^[\w-]{1,32}$/u.test(nonce)) return false;
      if (Math.abs(now() - Number(time)) > MAX_AGE_MS) return false;
      const bytes = Buffer.from(signature, "base64url");
      // One spelling per signature, so a re-encoded copy is the same header.
      if (bytes.toString("base64url") !== signature) return false;
      for (const [seen, at] of used) {
        if (now() - at > 2 * MAX_AGE_MS) used.delete(seen);
      }
      const once = `${time}.${nonce}`;
      if (used.has(once)) return false;
      const valid = verify(
        null,
        signedText(method, path, time, nonce),
        key,
        bytes,
      );
      if (valid) used.set(once, now());
      return valid;
    },
  };
}
