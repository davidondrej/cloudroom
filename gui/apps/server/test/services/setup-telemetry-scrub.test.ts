import { homedir } from "node:os";
import { expect, it } from "vitest";
import { scrub, scrubFeedback } from "../../src/services/cloudroom/setup-telemetry.js";

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
    "postgres://admin:hunter2@localhost:5432/app",
    "postgres://admin:p@ss-hunter2@localhost:5432/app",
    "postgres://admin:p'ass-hunter2@localhost:5432/app",
    'postgres://admin:pa"ss-hunter2@localhost:5432/app',
    "redis://:short-secret@127.0.0.1:6379",
    "http://user:hunter2@devbox/api?token=abc123",
  ];
  for (const text of leaks) expect(scrub(text)).not.toMatch(/private-client|budget|acme|Jane|jane|short-secret|abc123|hunter2|abcd1234/);
  expect(scrub(`Could not read ${homedir()}/private-client/budget.csv`)).toBe("Could not read <path>");
  expect(scrub("postgres://admin:hunter2@localhost:5432/app")).toBe("postgres://***@localhost:5432/app");
  expect(scrub("postgres://admin:p'ass-hunter2@localhost:5432/app")).toBe("postgres://***@localhost:5432/app");
  expect(scrub('postgres://admin:pa"ss-hunter2@localhost:5432/app')).toBe("postgres://***@localhost:5432/app");
  expect(scrub("redis://:short-secret@127.0.0.1:6379")).toBe("redis://***@127.0.0.1:6379");
  expect(scrub("http://user:hunter2@devbox/api?token=abc123")).toBe("http://devbox/api");
  expect(scrub('{"url":"postgres://localhost:5432/app","email":"jane@acme.com"}')).toBe('{"url":"postgres://localhost:5432/app","email":"email-***"}');

  for (const kept of ["~/.local/bin/claude", "/opt/homebrew/bin/codex", "C:\\Program Files\\Git\\cmd\\git.exe", "~\\AppData\\Local\\Programs\\Cloudroom\\Cloudroom.exe"]) {
    expect(scrub(`Running ${kept} failed`)).toBe(`Running ${kept} failed`);
  }
  expect(scrub("Open https://claude.com/cai/oauth/authorize?code=secret")).toBe("Open https://claude.com/cai/oauth/authorize");
  expect(scrub("Claude sign-in timed out. Run /login, and/or retry in 1/2 a minute.")).toBe("Claude sign-in timed out. Run /login, and/or retry in 1/2 a minute.");
});

it("scrubFeedback removes secrets and private paths while keeping multiline feedback and identifiers", () => {
  const padding = "x ".repeat(200);
  const raw = [
    "provider-cli-unsupported-version hit in ~/.local/bin/claude",
    `Failed reading ${homedir()}/secret-client/app.ts with ghp_1234567890abcdef and alice@example.com`,
    "DB error: postgres://admin:p'ass-hunter2@db.internal:5432/prod",
    ["BEGIN", "END"].map((edge) => `-----${edge} RSA PRIVATE ${"KEY"}-----`).join("\nMIIEpAIBAAKCAQEA\n"),
    `Detail: ${padding}`,
  ].join("\n");
  const clean = scrubFeedback(raw);
  expect(clean.length).toBeGreaterThan(300);
  expect(clean).toContain("\n");
  expect(clean).toContain("provider-cli-unsupported-version");
  expect(clean).toContain("~/.local/bin/claude");
  expect(clean).toContain("<private-key>");
  expect(clean).toContain("postgres://***@db.internal:5432/prod");
  expect(clean).not.toMatch(/secret-client|ghp_|alice@example\.com|MIIEpAIBAAKCAQEA|p'ass-hunter2/);
});
