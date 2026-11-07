/** The latest Cloud login switch per agent, by account name, so Core's "keep working" right after it shows as one
 *  quiet line (ADR 20261107-082837). Memory only: Core continues within minutes of a switch. */
const latest = new Map<string, { from: string; to: string; at: number }>();

export function noteCloudAccountSwitch(provider: string, switched: { from: string; to: string } | undefined): void {
  if (switched) latest.set(provider, { ...switched, at: Date.now() });
}

/** A switch that never reached Cloud continues nothing. */
export function forgetCloudAccountSwitch(provider: string): void {
  latest.delete(provider);
}

export function cloudAccountSwitch(provider: string) {
  return latest.get(provider) ?? null;
}
