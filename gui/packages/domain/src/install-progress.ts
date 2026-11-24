// Installs report no progress, so their progress follows time: about half at 30 s, slowing toward 95 % (ADR 20261111-123959).
export function installPercent(since: number, now = Date.now()): number {
  return Math.round(95 * (1 - Math.exp(-Math.max(0, now - since) / 45_000)));
}
