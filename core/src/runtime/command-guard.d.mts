export function checkCommand(command: unknown): string | null;
export function codexHookSource(): string;
export function codexGuardConfig(command: string): {
  "hooks.PreToolUse": { matcher: string; hooks: { async: boolean; command: string; timeout: number; type: string }[] }[];
  "hooks.state": Record<string, { enabled: boolean; trusted_hash: string }>;
};
export function commandGuardBlockReason(params: unknown): string | null;
export function shellQuote(value: string): string;
