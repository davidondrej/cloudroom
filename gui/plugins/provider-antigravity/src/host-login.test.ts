import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityLogin, antigravityExecutable } from "./host-login.js";

const FAKE_AGY = join(dirname(fileURLToPath(import.meta.url)), "fake-agy.mjs");

let dir: string;
let loginFile: string;
let envFile: string;
let login: AntigravityLogin;
let stopped: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "antigravity-login-test-"));
  loginFile = join(dir, "login");
  envFile = join(dir, "env");
  vi.stubEnv("FAKE_AGY_LOGIN_FILE", loginFile);
  vi.stubEnv("FAKE_AGY_ENV_FILE", envFile);
  stopped = 0;
  login = new AntigravityLogin(
    () => {
      stopped += 1;
    },
    () => FAKE_AGY,
  );
});

afterEach(() => {
  login.stop();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("Antigravity sign-in on this machine", () => {
  it("signs in with Google's link and a pasted code, then signs out", async () => {
    expect(await login.run({ action: "status" })).toMatchObject({
      state: "missing",
    });

    const waiting = await login.run({ action: "login", requestId: "first" });
    expect(waiting).toMatchObject({ state: "waiting", login_id: "first" });
    expect(waiting.verification_url).toMatch(
      /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/u,
    );
    // The CLI must only print the link: Cloudroom opens it where the user is.
    expect(readFileSync(envFile, "utf8")).not.toBe("");

    expect(
      await login.run({
        action: "complete",
        requestId: "first",
        code: " good-code \n",
      }),
    ).toMatchObject({ state: "connected", login_id: null });
    expect(existsSync(loginFile)).toBe(true);
    expect(await login.run({ action: "status" })).toMatchObject({
      state: "connected",
    });

    expect(await login.run({ action: "logout" })).toMatchObject({
      state: "missing",
    });
    expect(existsSync(loginFile)).toBe(false);
  });

  it("reports a refused code and lets the sign-in start again", async () => {
    await login.run({ action: "login", requestId: "first" });
    expect(
      await login.run({ action: "complete", requestId: "first", code: "bad" }),
    ).toEqual({
      state: "error",
      message: "Google did not accept that code. Start the sign-in again.",
      login_id: null,
      verification_url: null,
    });

    const again = await login.run({ action: "login", requestId: "second" });
    expect(again).toMatchObject({ state: "waiting", login_id: "second" });
  });

  it("ignores a code or a cancel meant for another sign-in", async () => {
    await login.run({ action: "login", requestId: "first" });
    expect(
      await login.run({
        action: "complete",
        requestId: "other",
        code: "good-code",
      }),
    ).toMatchObject({ state: "waiting", login_id: "first" });
    expect(
      await login.run({ action: "cancel", requestId: "other" }),
    ).toMatchObject({ state: "waiting", login_id: "first" });
    expect(existsSync(loginFile)).toBe(false);

    expect(
      await login.run({ action: "cancel", requestId: "first" }),
    ).toMatchObject({ state: "missing" });
    expect(stopped).toBeGreaterThan(0);
  });

  it("does not start a sign-in when already signed in", async () => {
    await login.run({ action: "login", requestId: "first" });
    await login.run({
      action: "complete",
      requestId: "first",
      code: "good-code",
    });
    expect(
      await login.run({ action: "login", requestId: "second" }),
    ).toMatchObject({ state: "connected", login_id: null });
  });

  it("says so when the CLI is not installed", async () => {
    const missing = new AntigravityLogin(
      () => {},
      () => join(dir, "no-such-agy"),
    );
    expect(await missing.run({ action: "status" })).toEqual({
      state: "unavailable",
      message: "Antigravity is not installed on this machine.",
      login_id: null,
      verification_url: null,
    });
  });
});

describe("antigravityExecutable", () => {
  it("finds agy on PATH, then where Google's installer puts it", () => {
    const fromPath = antigravityExecutable(
      { PATH: dirname(FAKE_AGY) },
      join(dir, "home"),
    );
    // No file named `agy` in that folder, and none under the empty home.
    expect(fromPath).toBe("agy");
  });
});
