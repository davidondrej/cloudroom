export interface Secret {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  idToken?: string;
  issuedAt?: number;
}

export interface SignedIn {
  email: string | null;
  plan: string | null;
  accountKey: string | null;
  secret: Secret;
}

export class SignInAgainError extends Error {}

export function readReset(
  value: string | number | null | undefined,
): number | null {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric))
    return Math.round(numeric < 1e12 ? numeric * 1_000 : numeric);
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function jwtClaims(token: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(token?.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
