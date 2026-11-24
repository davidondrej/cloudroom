function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function extractErrorMessage(
  value: unknown,
  opts?: { legacyKeys?: readonly string[] },
): string | null {
  const pending: unknown[] = [value];
  const visited = new Set<object>();

  // Walk iteratively so deeply nested API errors cannot overflow the call stack.
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      const normalized = current.replace(/\s+/g, " ").trim();
      if (normalized.length > 0) return normalized;
      continue;
    }
    if (
      current === null ||
      typeof current !== "object" ||
      visited.has(current)
    ) {
      continue;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        pending.push(current[index]);
      }
      continue;
    }

    const record = toRecord(current);
    if (!record) continue;
    const keys = [
      ...(typeof record.message === "string" ? ["message"] : []),
      ...(opts?.legacyKeys ?? ["detail"]),
    ];
    for (let index = keys.length - 1; index >= 0; index--) {
      pending.push(record[keys[index]]);
    }
  }
  return null;
}
