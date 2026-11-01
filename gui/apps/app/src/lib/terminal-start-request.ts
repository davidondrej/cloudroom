import type { CreateTerminalRequest } from "@cloudroom/server-contract";

type TerminalStartRequest = Pick<CreateTerminalRequest, "start" | "title">;

let pending: TerminalStartRequest | null = null;

export function runInNewTerminal(
  request: TerminalStartRequest,
  openTerminal: () => boolean,
): boolean {
  pending = request;
  try {
    return openTerminal();
  } finally {
    pending = null;
  }
}

export function takeTerminalStartRequest(): TerminalStartRequest {
  const request = pending ?? {};
  pending = null;
  return request;
}
