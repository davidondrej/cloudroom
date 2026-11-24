import { homedir } from "node:os";
import { expect, it } from "vitest";
import { scrub } from "../../src/services/cloudroom/setup-telemetry.js";

// Telemetry never sends paths or secrets (ADR 0198). Every setup message, Windows error, and crash log goes through scrub().
it("drops private paths and credentials, but keeps tool paths, sign-in URLs, and plain errors", () => {
  const leaks = [
    `Could not read ${homedir()}/private-client/budget.csv`,
    "Could not read /Volumes/Client/acme/plan.md",
    "Could not read C:\\Users\\Jane\\clients\\acme.docx",
    "Could not read D:\\work\\acme\\notes.txt",
    "Could not read file:///Users/jane/acme/plan.md",
    "Authorization: Bearer short-secret-123",
    "token=abc123 password: hunter2",
    '{"api_key":"abcd1234"}',
  ];
  for (const text of leaks) expect(scrub(text)).not.toMatch(/private-client|budget|acme|Jane|jane|short-secret|abc123|hunter2|abcd1234/);
  expect(scrub(`Could not read ${homedir()}/private-client/budget.csv`)).toBe("Could not read <path>");

  for (const kept of ["~/.local/bin/claude", "/opt/homebrew/bin/codex", "C:\\Program Files\\Git\\cmd\\git.exe", "~\\AppData\\Local\\Programs\\Cloudroom\\Cloudroom.exe"]) {
    expect(scrub(`Running ${kept} failed`)).toBe(`Running ${kept} failed`);
  }
  expect(scrub("Open https://claude.com/cai/oauth/authorize?code=secret")).toBe("Open https://claude.com/cai/oauth/authorize");
  expect(scrub("Claude sign-in timed out. Run /login, and/or retry in 1/2 a minute.")).toBe("Claude sign-in timed out. Run /login, and/or retry in 1/2 a minute.");
});
