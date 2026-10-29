import { describe, expect, it } from "vitest";
import { selectUsageMachine, type UsageMachine } from "./usage-schema.js";

describe("default usage source", () => {
  const machine: UsageMachine = {
    id: "host-one",
    displayName: "My machine",
    status: "connected",
    providers: [],
    error: null,
  };
  const pool: UsageMachine = {
    ...machine,
    id: "source:account-pool",
    displayName: "Account Pooler",
  };
  it("prefers even an empty pool to thread-local usage, while preserving explicit selection", () => {
    expect(selectUsageMachine([machine, pool], null, machine.id)).toBe(pool);
    expect(selectUsageMachine([machine, pool], machine.id, null)).toBe(machine);
    expect(selectUsageMachine([machine], pool.id, machine.id)).toBe(machine);
    expect(
      selectUsageMachine(
        [machine, { ...pool, error: "Unavailable" }],
        null,
        machine.id,
      ),
    ).toBe(machine);
  });
});
