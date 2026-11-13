#!/usr/bin/env node

/**
 * A scripted stand-in for Google's `agy` CLI, for the sign-in tests.
 *
 * - `agy acp` answers ACP `initialize`, `session/list` and `logout`. It is
 *   signed in while the file named by FAKE_AGY_LOGIN_FILE exists.
 * - `agy acp --login` prints the sign-in link the real CLI prints, then reads
 *   one line: "good-code" signs in and exits 0, anything else exits 1.
 *   FAKE_AGY_ENV_FILE receives the SSH_CONNECTION it was started with.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const loginFile = process.env.FAKE_AGY_LOGIN_FILE;
const lines = createInterface({ input: process.stdin });

if (process.argv.includes("--login")) {
  if (process.env.FAKE_AGY_ENV_FILE)
    writeFileSync(
      process.env.FAKE_AGY_ENV_FILE,
      process.env.SSH_CONNECTION ?? "",
    );
  process.stdout.write(
    "Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=fake&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=fake-state\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n",
  );
  lines.once("line", (line) => {
    if (line === "good-code") {
      writeFileSync(loginFile, "signed-in");
      process.exit(0);
    }
    process.stdout.write(
      '\ncouldn\'t log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."\n',
    );
    process.exit(1);
  });
} else {
  const reply = (id, body) =>
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`,
    );
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      reply(message.id, { result: { protocolVersion: 1 } });
    } else if (message.method === "logout") {
      rmSync(loginFile, { force: true });
      reply(message.id, { result: {} });
    } else if (existsSync(loginFile)) {
      reply(message.id, { result: { sessions: [] } });
    } else {
      // ACP's reserved auth-required error.
      reply(message.id, {
        error: { code: -32000, message: "Authentication required" },
      });
    }
  });
}
