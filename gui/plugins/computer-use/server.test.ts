import { describe, expect, it } from "vitest";
import { decideGate } from "./server.js";

describe("decideGate", () => {
  it("asks about the app an action targets, and never lets input skip the question", () => {
    expect(decideGate({ tool: "list_apps", input: {} })).toEqual({ kind: "free" });
    expect(decideGate({ tool: "list_windows", input: { pid: 42 } })).toEqual({ kind: "free" });
    expect(decideGate({ tool: "click", input: { pid: 42, element_token: "s1:3" } })).toEqual({ kind: "pid", pid: 42 });
    expect(decideGate({ tool: "type_text", input: { text: "hi" } }).kind).toBe("error");
    expect(decideGate({ tool: "launch_app", input: { bundle_id: "com.apple.TextEdit" } })).toEqual({
      kind: "name",
      name: "com.apple.TextEdit",
    });
    expect(decideGate({ tool: "get_desktop_state", input: {} })).toEqual({ kind: "screen" });
    expect(decideGate({ tool: "set_config", input: {} }).kind).toBe("error");
  });
});
