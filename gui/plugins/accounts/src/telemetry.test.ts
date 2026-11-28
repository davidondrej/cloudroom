import { describe, expect, it } from "vitest";
import { errorCode } from "./telemetry.js";

describe("errorCode", () => {
  // Approving this computer's Claude login for Cloud fails in four ways, each with its own code.
  it.each([
    ["Sign in to Claude Code on this computer first: run `claude`, then try again.", "signed_out"],
    [
      "Couldn't read this computer's Claude login. Run `claude auth status` in a terminal, then try again.",
      "mac_login_unreadable",
    ],
    ["Couldn't confirm which Claude account you approved. Try again.", "unconfirmed"],
    [
      "Your browser approved a different Claude account than this computer uses. Sign out of claude.ai or open the link in a private window, then approve with a@b.co.",
      "different_account",
    ],
    [
      "That is a different Claude account. Sign out of claude.ai or open the link in a private window, then sign in with a@b.co.",
      "different_account",
    ],
  ])("%s", (message, code) => {
    expect(errorCode(new Error(message))).toBe(code);
  });
});
