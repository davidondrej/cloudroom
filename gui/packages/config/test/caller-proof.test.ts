import {
  chmod,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALLER_PROOF_STATUS_HEADER,
  CALLER_PROOF_TIMED_OUT_MESSAGE,
  CALLER_TOKEN_HEADER,
  callerTokenFor,
  createCallerProofFetch,
  createCallerProofIssuer,
  proveLocalCaller,
  SERVER_CALLER_PROOF_PATH,
  tcpConnectionOwner,
  type CallerProofIssuer,
} from "../src/caller-proof.js";

const dirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "caller-proof-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    await chmod(join(dir, "caller-proofs"), 0o700).catch(() => {});
    await rm(dir, { force: true, recursive: true });
  }
});

function issuerFetch(issuer: CallerProofIssuer, origin: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
      new Response(JSON.stringify(body), { headers, status });
    if (url.origin !== origin) throw new Error(`unexpected ${url.href}`);
    if (url.pathname === SERVER_CALLER_PROOF_PATH) return json(issuer.start());
    if (url.pathname.startsWith(`${SERVER_CALLER_PROOF_PATH}/`)) {
      const { claim } = JSON.parse(String(init?.body)) as { claim: string };
      const token = await issuer.finish(url.pathname.split("/").pop()!, claim);
      return token === null ? json({}, 403) : json({ token });
    }
    const token = new Headers(init?.headers).get(CALLER_TOKEN_HEADER);
    return issuer.verify(token ?? undefined)
      ? json({ ok: true })
      : json({}, 401, { [CALLER_PROOF_STATUS_HEADER]: "required" });
  }) as typeof fetch;
}

describe("caller proof", () => {
  it("gives a token only to a caller that can write in the data folder", async () => {
    const issuer = await createCallerProofIssuer({
      dataDir: await tempDataDir(),
    });
    const origin = "http://127.0.0.1:1";
    const token = await proveLocalCaller({
      baseUrl: origin,
      fetch: issuerFetch(issuer, origin),
      proofPath: SERVER_CALLER_PROOF_PATH,
    });
    expect(token).toEqual(expect.any(String));
    expect(issuer.verify(token!)).toBe(true);
    expect(issuer.verify("not-a-token")).toBe(false);
    expect(await readdir(issuer.directory)).toEqual([]);
  });

  it("refuses a caller that only knows the proof file name", async () => {
    const issuer = await createCallerProofIssuer({
      dataDir: await tempDataDir(),
    });
    const started = issuer.start();
    await writeFile(join(issuer.directory, started.id), started.id);
    expect(await issuer.finish(started.id, "guessed-claim")).toBeNull();
    expect(await issuer.finish(started.id, started.claim)).toEqual(
      expect.any(String),
    );
    expect(await issuer.finish(started.id, started.claim)).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked proof file",
    async () => {
      const dataDir = await tempDataDir();
      const issuer = await createCallerProofIssuer({ dataDir });
      const linked = issuer.start();
      const elsewhere = join(dataDir, "elsewhere");
      await writeFile(elsewhere, linked.id);
      await symlink(elsewhere, join(issuer.directory, linked.id));
      expect(await issuer.finish(linked.id, linked.claim)).toBeNull();
    },
  );

  it("refuses missing files, wrong content, and old proofs", async () => {
    let now = 1_000_000;
    const dataDir = await tempDataDir();
    const issuer = await createCallerProofIssuer({ dataDir, now: () => now });

    const missing = issuer.start();
    expect(await issuer.finish(missing.id, missing.claim)).toBeNull();

    const wrong = issuer.start();
    await writeFile(join(issuer.directory, wrong.id), "something else");
    expect(await issuer.finish(wrong.id, wrong.claim)).toBeNull();

    const old = issuer.start();
    await writeFile(join(issuer.directory, old.id), old.id);
    now += 31_000;
    expect(await issuer.finish(old.id, old.claim)).toBeNull();
  });

  it("redeems one proof once, even when asked many times at once", async () => {
    const issuer = await createCallerProofIssuer({
      dataDir: await tempDataDir(),
    });
    const started = issuer.start();
    await writeFile(join(issuer.directory, started.id), started.id);
    const tokens = await Promise.all(
      Array.from({ length: 20 }, () =>
        issuer.finish(started.id, started.claim),
      ),
    );
    expect(tokens.filter((token) => token !== null)).toHaveLength(1);
  });

  it("expires idle tokens", async () => {
    let now = 1_000_000;
    const issuer = await createCallerProofIssuer({
      dataDir: await tempDataDir(),
      now: () => now,
    });
    const started = issuer.start();
    await writeFile(join(issuer.directory, started.id), started.id);
    const token = (await issuer.finish(started.id, started.claim))!;
    now += 23 * 60 * 60 * 1000;
    expect(issuer.verify(token)).toBe(true);
    now += 25 * 60 * 60 * 1000;
    expect(issuer.verify(token)).toBe(false);
    expect(issuer.verify(issuer.issueInternal())).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "returns no token when the caller cannot write there",
    async () => {
      const issuer = await createCallerProofIssuer({
        dataDir: await tempDataDir(),
      });
      await chmod(issuer.directory, 0o500);
      const origin = "http://127.0.0.1:2";
      expect(
        await proveLocalCaller({
          baseUrl: origin,
          fetch: issuerFetch(issuer, origin),
          proofPath: SERVER_CALLER_PROOF_PATH,
        }),
      ).toBeNull();
    },
  );

  it("tries a failed proof again after a short wait, even while requests keep failing", async () => {
    const issuer = await createCallerProofIssuer({
      dataDir: await tempDataDir(),
    });
    const origin = "http://127.0.0.1:4";
    const base = issuerFetch(issuer, origin);
    let proofsRefused = true;
    const authed = createCallerProofFetch(((input, init) =>
      proofsRefused &&
      new URL(String(input)).pathname === SERVER_CALLER_PROOF_PATH
        ? Promise.resolve(new Response("{}", { status: 503 }))
        : base(input, init)) as typeof fetch);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    expect((await authed(`${origin}/api/v1/hosts`)).status).toBe(401);
    proofsRefused = false;
    now += 1_500;
    expect((await authed(`${origin}/api/v1/hosts`)).status).toBe(401);
    now += 1_000;
    expect((await authed(`${origin}/api/v1/hosts`)).status).toBe(200);

    // A proof that times out says Cloudroom is busy, and its POST is never sent (#1285).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: string[] = [];
    const busy = createCallerProofFetch(((input) => {
      sent.push(new URL(String(input)).pathname);
      now += 60_000;
      return Promise.reject(
        Object.assign(new Error("busy"), { name: "TimeoutError" }),
      );
    }) as typeof fetch);
    const refused = await busy("http://127.0.0.1:9/api/v1/hosts", {
      body: "{}",
      method: "POST",
    });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      message: CALLER_PROOF_TIMED_OUT_MESSAGE,
    });
    expect(sent).toEqual([SERVER_CALLER_PROOF_PATH]);
  });

  it("keeps a Request's own headers when it adds the caller token", async () => {
    const issuer = await createCallerProofIssuer({
      dataDir: await tempDataDir(),
    });
    const origin = "http://127.0.0.1:5";
    const base = issuerFetch(issuer, origin);
    const seen: Headers[] = [];
    const authed = createCallerProofFetch(((input, init) => {
      if (
        new URL(String(input instanceof Request ? input.url : input))
          .pathname === "/api/v1/terminals"
      ) {
        seen.push(new Headers(init?.headers));
      }
      return base(input instanceof Request ? input.url : input, init);
    }) as typeof fetch);
    await authed(
      new Request(`${origin}/api/v1/terminals`, {
        body: "{}",
        headers: {
          authorization: "Bearer other",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(seen[0]?.get("authorization")).toBe("Bearer other");
    expect(seen[0]?.get("content-type")).toBe("application/json");
    expect(seen[0]?.get(CALLER_TOKEN_HEADER)).toEqual(expect.any(String));
  });

  it("lets a token lookup prove again once a failed proof is old", async () => {
    const issuer = await createCallerProofIssuer({
      dataDir: await tempDataDir(),
    });
    const origin = "http://127.0.0.1:6";
    const base = issuerFetch(issuer, origin);
    let proofsRefused = true;
    vi.stubGlobal("fetch", ((input, init) =>
      proofsRefused
        ? Promise.resolve(new Response("{}", { status: 503 }))
        : base(input, init)) as typeof fetch);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      expect(await callerTokenFor(origin)).toBeNull();
      proofsRefused = false;
      now += 1_500;
      expect(await callerTokenFor(origin)).toBeNull();
      now += 1_000;
      expect(await callerTokenFor(origin)).toEqual(expect.any(String));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("proves on a refused request and retries it once", async () => {
    const issuer = await createCallerProofIssuer({
      dataDir: await tempDataDir(),
    });
    const origin = "http://127.0.0.1:3";
    const calls: string[] = [];
    const base = issuerFetch(issuer, origin);
    const authed = createCallerProofFetch(((input, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return base(input, init);
    }) as typeof fetch);

    const response = await authed(`${origin}/api/v1/terminals`);
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "GET /api/v1/terminals",
      `POST ${SERVER_CALLER_PROOF_PATH}`,
      expect.stringMatching(/^POST \/api\/v1\/caller-proofs\//u),
      "GET /api/v1/terminals",
    ]);

    calls.length = 0;
    const post = await authed(`${origin}/api/v1/terminals`, {
      body: "{}",
      method: "POST",
    });
    expect(post.status).toBe(200);
    expect(calls).toEqual(["POST /api/v1/terminals"]);
  });

  it.each([
    [
      "refuses a proof",
      7,
      () => Promise.resolve(new Response("{}", { status: 403 })),
      "was refused (403)",
    ],
    [
      "is slower than the caller's own request timeout",
      8,
      () =>
        Promise.reject(
          Object.assign(new Error("Cloudroom request timed out after 6s."), {
            name: "BbRequestTimeoutError",
          }),
        ),
      "timed out",
    ],
  ])(
    "proves again when a busy server %s, so the request still goes through",
    async (_, port, fail, reason) => {
      const issuer = await createCallerProofIssuer({
        dataDir: await tempDataDir(),
      });
      const origin = `http://127.0.0.1:${port}`;
      const base = issuerFetch(issuer, origin);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let refused = false;
      const authed = createCallerProofFetch(((input, init) => {
        const finishing = new URL(String(input)).pathname.startsWith(
          `${SERVER_CALLER_PROOF_PATH}/`,
        );
        if (finishing && !refused) {
          refused = true;
          return fail();
        }
        return base(input, init);
      }) as typeof fetch);

      const response = await authed(`${origin}/internal/hosts/enroll`, {
        body: "{}",
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(
        `Cloudroom caller proof ${reason}; retrying in 1 s`,
      );
      expect(await readdir(issuer.directory)).toEqual([]);
    },
  );
});

// Rows as Linux writes them on little-endian machines (all our CI runners).
describe.runIf(endianness() === "LE")("tcpConnectionOwner", () => {
  const header =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const row = (local: string, remote: string, uid: number, inode = 1) =>
    `   0: ${local} ${remote} ${inode === 0 ? "06" : "01"} 00000000:00000000 00:00000000 00000000 ${uid}        0 ${inode} 1 0000000000000000 20 0 0 10 -1`;
  const table = (...rows: string[]) => [header, ...rows, ""].join("\n");
  // 127.0.0.1:42044 (A43C) is the caller, 127.0.0.1:46305 (B4E1) is us.
  const v4 = (address: string, port: string) => `${address}:${port}`;
  const v6 = (address: string, port: string) =>
    `0000000000000000FFFF0000${address}:${port}`;
  const peer = {
    localAddress: "127.0.0.1",
    localPort: 46305,
    remoteAddress: "127.0.0.1",
    remotePort: 42044,
  };

  it("finds the one live socket at the caller's end of this connection", () => {
    const tcp = table(
      // Our own end of the connection, with our uid.
      row(v4("0100007F", "B4E1"), v4("0100007F", "A43C"), 1003),
      // Another account using the same ports from 127.0.0.2.
      row(v4("0200007F", "A43C"), v4("0100007F", "B4E1"), 65534),
      // The caller's end, plus a closed earlier socket the kernel lists as uid 0.
      row(v4("0100007F", "A43C"), v4("0100007F", "B4E1"), 1001),
      row(v4("0100007F", "A43C"), v4("0100007F", "B4E1"), 0, 0),
    );
    expect(tcpConnectionOwner(peer, [tcp, null])).toBe(1001);
    // A dual-stack listener sees the same IPv4 caller as IPv4-mapped.
    const mapped = {
      ...peer,
      localAddress: "::ffff:127.0.0.1",
      remoteAddress: "::ffff:127.0.0.1",
    };
    expect(tcpConnectionOwner(mapped, [tcp, null])).toBe(1001);
    // A caller on an IPv6 socket is listed in tcp6, also for 127.0.0.1.
    const tcp6 = table(
      row(v6("0100007F", "A43C"), v6("0100007F", "B4E1"), 1002),
    );
    expect(tcpConnectionOwner(peer, [table(), tcp6])).toBe(1002);
    const loopback6 = "00000000000000000000000001000000";
    expect(
      tcpConnectionOwner(
        { ...peer, localAddress: "::1", remoteAddress: "::1" },
        [null, table(row(`${loopback6}:A43C`, `${loopback6}:B4E1`, 1004))],
      ),
    ).toBe(1004);
  });

  it("names no owner when the tables can't say for sure", () => {
    const caller = row(v4("0100007F", "A43C"), v4("0100007F", "B4E1"), 1001);
    expect(tcpConnectionOwner(peer, [null, null])).toBeNull();
    expect(tcpConnectionOwner(peer, [table(), table()])).toBeNull();
    expect(
      tcpConnectionOwner({ ...peer, remotePort: undefined }, [
        table(caller),
        null,
      ]),
    ).toBeNull();
    const twice = table(
      row(v6("0100007F", "A43C"), v6("0100007F", "B4E1"), 1003),
    );
    expect(tcpConnectionOwner(peer, [table(caller), twice])).toBeNull();
  });
});
