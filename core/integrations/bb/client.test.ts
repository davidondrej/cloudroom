import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { CloudroomClient, CloudroomConnectionError, CloudroomError } from "./client.ts";

async function fixture(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, unknown>,
  ) => void | Promise<void>,
  timeoutMs = 5000,
) {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, "Bearer test-token");
    let input = "";
    for await (const chunk of req) input += chunk;
    await handler(req, res, input ? JSON.parse(input) : {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    client: new CloudroomClient({ url, token: "test-token", timeoutMs }),
    url,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sendJson(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

test("routes Cursor account operations and rejects off-domain login links", async (t) => {
  let url = "https://cursor.com/loginDeepControl?challenge=fixture";
  const bodies: Record<string, unknown>[] = [];
  const service = await fixture((req, res, body) => {
    bodies.push(body);
    sendJson(res, { state: "waiting", email: null, plan: null, message: null, login_id: "login", verification_url: url, user_code: null }, req.method === "POST" ? 202 : 200);
  });
  t.after(() => service.close());
  assert.equal((await service.client.cursorAuth()).verification_url, url);
  await service.client.cursorAuth("login", "login");
  await service.client.cursorAuth("cancel", "login");
  await service.client.cursorAuth("key", "key", "synthetic-key");
  assert.deepEqual(bodies, [{}, { request_id: "login" }, { request_id: "login" }, { request_id: "key", api_key: "synthetic-key" }]);
  assert.deepEqual(service.requests, ["GET /v1/accounts/cursor", "POST /v1/accounts/cursor/login", "POST /v1/accounts/cursor/cancel", "POST /v1/accounts/cursor/key"]);
  for (url of ["https://cursor.com.evil.invalid/loginDeepControl?challenge=fixture", "https://user:pass@cursor.com/loginDeepControl", "https://cursor.com/other", "http://cursor.com/loginDeepControl"]) {
    await assert.rejects(service.client.cursorAuth(), /Unexpected Cursor sign-in URL/);
  }
});

test("reports allowlisted rejections, keeps temporary conflicts retryable, and shows unknown core errors", async (t) => {
  let body: unknown;
  const service = await fixture((_req, res) => sendJson(res, body, 409));
  t.after(() => service.close());
  for (const [value, code, retryable] of [
    [{ code: "invalid_reasoning_effort", error: "SECRET-CANARY" }, "invalid_reasoning_effort", false],
    [{ error: "invalid reasoning effort" }, "invalid_reasoning_effort", false],
    [{ code: "invalid_model" }, "invalid_model", false],
    [{ code: "invalid_provider" }, "invalid_provider", false],
    [{ code: "request_conflict" }, "request_conflict", false],
    [{ code: "storage_blocked" }, "storage_blocked", true],
    [{ error: "storage unsafe; new execution is blocked" }, "storage_blocked", true],
    [{ code: "service_stopping" }, "service_stopping", true],
    [{ code: "model_catalog_unavailable" }, "model_catalog_unavailable", true],
    [{ code: "SECRET-CANARY", error: "SECRET-CANARY" }, null, true],
    [{ code: "constructor", error: "SECRET-CANARY" }, null, true],
    [{ code: "invalid_model", padding: "SECRET-CANARY".repeat(1000) }, null, true],
  ] as const) {
    body = value;
    await assert.rejects(service.client.start("rejected", "codex", { reasoning: "max" }), (error: unknown) => {
      assert(error instanceof CloudroomError);
      assert.equal(error.status, 409);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      // Allowlisted codes keep their friendly text; unknown rejections show the core's own error (ADR 0123).
      const shown = code === null && typeof (value as { error?: unknown }).error === "string";
      assert.equal(error.message.includes("SECRET-CANARY"), shown);
      return true;
    });
  }
  assert.equal(service.requests.length, 12);
});

test("attachment failures distinguish permissions and size without disclosing server details or retrying", async (t) => {
  let code = "";
  const service = await fixture((req, res) => {
    assert(req.url?.startsWith("/v1/sessions/s1/attachments?"));
    sendJson(res, { code, error: "EACCES /private/SECRET-CANARY test-token" }, 409);
  });
  t.after(() => service.close());
  for (const [rejection, message] of [
    ["attachment_permission_denied", "Cloud folder permission denied"],
    ["attachment_too_large", "The attachment exceeds the Cloud size limit (10 MiB per image, 100 MiB per file)."],
    ["invalid_attachment", "The attachment could not be stored on Cloud."],
  ]) {
    code = rejection;
    const bytes = new TextEncoder().encode("{}");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    await assert.rejects(service.client.attach("s1", "upload", "image.png", "image", { body, length: bytes.length }), (error: unknown) => {
      assert(error instanceof CloudroomError);
      assert.equal(error.status, 409);
      assert.equal(error.code, rejection);
      assert.equal(error.message, message);
      assert.equal(error.retryable, false);
      return true;
    });
  }
  assert.equal(service.requests.length, 3);
});

function event(sequence: number, data: unknown = {}, session_id = "s1") {
  return { sequence, session_id, kind: "native", data };
}

function frame(sequence: number, data: unknown = {}) {
  return `id: ${sequence}\r\nevent: record\r\ndata: ${JSON.stringify(event(sequence, data))}\r\n\r\n`;
}

function snapshot(last_sequence: number) {
  return {
    session: {
      session_id: "s1",
      harness: "codex",
      state: "idle",
      native_id: "native-1",
      current_request: null,
      last_sequence,
      queue: [],
      receipts: {},
    },
  };
}

test("requires secure explicit connection settings", () => {
  for (const url of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com?token=secret",
    "https://example.com#secret",
    "file:///tmp/core",
  ]) {
    assert.throws(
      () => new CloudroomClient({ url, token: "test-token" }),
      CloudroomError,
    );
  }
  for (const token of ["", "   ", "secret\nheader", "test-token\t", " test-token", "test-token ", "test\u0000token", "test\u007ftoken", "tést-token"]) {
    assert.throws(
      () => new CloudroomClient({ url: "https://example.com", token }),
      CloudroomError,
    );
  }
  const client = new CloudroomClient({
    url: "https://example.com",
    token: "never-serialize-this",
  });
  assert.equal(JSON.stringify(client), "{}");
});

test("keeps the gate token in a cookie for commands and SSE, never in URLs or errors", async (t) => {
  const gateToken = "gate-fixture-secret";
  const service = await fixture((req, res, body) => {
    assert.equal(req.headers.cookie, `_port_auth=${gateToken}`);
    assert.ok(!req.url!.includes(gateToken));
    if (req.url === "/v1/ready") return sendJson(res, { ready: true });
    if (req.url === "/v1/sessions") return sendJson(res, { session_id: "s1", receipt: { request_id: body.request_id, command: "start", state: "accepted", input: {} }, saving: {} }, 202);
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(frame(1));
  });
  t.after(() => service.close());
  const client = new CloudroomClient({ url: service.url, token: "test-token", gateToken });
  assert.deepEqual(await client.ready(), { ready: true });
  await client.start("gate-start");
  const records = [];
  for await (const record of client.stream("s1", { signal: AbortSignal.timeout(1000) })) records.push(record);
  assert.equal(records.length, 1);
  assert.equal(JSON.stringify(client), "{}");
  for (const invalid of ["", "token;other=secret", "secret\r\nInjected: yes", "a".repeat(4097)]) assert.throws(() => new CloudroomClient({ url: service.url, token: "test-token", gateToken: invalid }), CloudroomError);
});

test("rejects each authentication layer independently and replays through the gate after reconnect", async (t) => {
  const gateToken = "gate-secret";
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    if (req.headers.cookie !== `_port_auth=${gateToken}`) return sendJson(res, { error: gateToken }, 403);
    if (req.headers.authorization !== "Bearer test-token") return sendJson(res, { error: "test-token" }, 401);
    if (req.url === "/v1/ready") return sendJson(res, { ready: true });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(req.url?.endsWith("after=0") ? frame(9) : frame(18));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  for (const [token, gate, status] of [["test-token", undefined, 403], ["test-token", "wrong-gate", 403], ["wrong-core", gateToken, 401]] as const) {
    const client = new CloudroomClient({ url, token, gateToken: gate });
    const rejected = (error: unknown) => error instanceof CloudroomError && error.status === status && error.message === `Cloudroom authentication failed (HTTP ${status})`;
    await assert.rejects(client.ready(), rejected);
    await assert.rejects(client.start("rejected"), rejected);
    await assert.rejects(async () => {
      for await (const _ of client.stream("s1", { signal: AbortSignal.timeout(1000) })) assert.fail("unauthorized stream");
    }, rejected);
  }
  const before = paths.length;
  assert.throws(() => new CloudroomClient({ url, token: "", gateToken }), CloudroomError);
  assert.equal(paths.length, before);
  const client = new CloudroomClient({ url, token: "test-token", gateToken });
  const seen: number[] = [];
  for (const after of [0, 9]) {
    for await (const record of client.stream("s1", { after, signal: AbortSignal.timeout(1000) })) seen.push(record.sequence);
  }
  assert.deepEqual(seen, [9, 18]);
  assert.deepEqual(paths.slice(-2), ["/v1/sessions/s1/stream?after=0", "/v1/sessions/s1/stream?after=9"]);
});

test("never forwards either credential to a redirect destination", async (t) => {
  let redirected = false;
  const destination = await fixture(() => { redirected = true; });
  const service = await fixture((_req, res) => { res.writeHead(307, { Location: destination.url }); res.end(); });
  t.after(() => Promise.all([service.close(), destination.close()]));
  const client = new CloudroomClient({ url: service.url, token: "test-token", gateToken: "gate-secret" });
  await assert.rejects(client.ready(), /unreachable/);
  await assert.rejects(client.start("redirected"), /unreachable/);
  await assert.rejects(async () => {
    for await (const _ of client.stream("s1", { signal: AbortSignal.timeout(1000) })) assert.fail("redirected stream");
  }, /unreachable/);
  assert.equal(redirected, false);
  assert.deepEqual(destination.requests, []);
});

test("routes commands, preserves caller request IDs, and never treats acceptance as completion", async (t) => {
  const prompts: unknown[] = [];
  const service = await fixture((req, res, body) => {
    if (req.url?.endsWith("/prompts")) prompts.push(body);
    const command =
      req.url === "/v1/sessions"
        ? "start"
        : req.url?.endsWith("/prompts")
          ? "prompt"
          : req.url?.split("/").at(-1);
    sendJson(
      res,
      {
        session_id: "s1",
        receipt: {
          request_id: body.request_id,
          command,
          input: body,
          state: "accepted",
        },
        saving: "pending",
      },
      202,
    );
  });
  t.after(() => service.close());
  const accepted = await service.client.start("create_1", "pi", { provider: "openai-codex", model: "gpt-6-astra" });
  assert.deepEqual(accepted.receipt.input, { request_id: "create_1", harness: "pi", provider: "openai-codex", model: "gpt-6-astra" });
  assert.equal(accepted.receipt.state, "accepted");
  assert.equal(accepted.saving, "pending");
  await service.client.prompt("s1", "message_1", "hello");
  await service.client.prompt("s1", "message_1", "hello");
  await service.client.prompt("s1", "level", "next", "high");
  await service.client.interrupt("s1", "stop_1", "message_1");
  await service.client.close("s1", "close_1");
  assert.deepEqual(prompts[0], { request_id: "message_1", text: "hello" });
  assert.deepEqual(prompts.at(-1), { request_id: "level", text: "next", reasoning: "high" });
  assert.deepEqual(service.requests, [
    "POST /v1/sessions",
    "POST /v1/sessions/s1/prompts",
    "POST /v1/sessions/s1/prompts",
    "POST /v1/sessions/s1/prompts",
    "POST /v1/sessions/s1/interrupt",
    "POST /v1/sessions/s1/close",
  ]);
});

test("posts edit, cancel, steer, compact, and rewind commands", async (t) => {
  const bodies: object[] = [];
  const service = await fixture((req, res, body) => {
    bodies.push({ url: req.url, ...body });
    sendJson(res, {
      session_id: "s1",
      receipt: { request_id: body.request_id, command: String(req.url).split("/").pop(), input: body, state: "accepted" },
      saving: {},
    }, 202);
  });
  t.after(() => service.close());
  await service.client.edit("s1", "e1", "p1", 1, "newer", { service_tier: "fast" });
  await service.client.cancel("s1", "c1", "p1");
  await service.client.steer("s1", "s1-steer", "p1", "turn left");
  await service.client.compact("s1", "k1");
  await service.client.rewind("s1", "r1", "turn-1");
  assert.deepEqual(service.requests, [
    "POST /v1/sessions/s1/edit",
    "POST /v1/sessions/s1/cancel",
    "POST /v1/sessions/s1/steer",
    "POST /v1/sessions/s1/compact",
    "POST /v1/sessions/s1/rewind",
  ]);
  assert.equal((bodies[0] as { expected_revision?: number }).expected_revision, 1);
  assert.equal((bodies[2] as { text?: string }).text, "turn left");
  assert.equal((bodies[4] as { before?: string }).before, "turn-1");
});

test("rejects invalid requests before network access", async (t) => {
  const service = await fixture(() =>
    assert.fail("request must not reach server"),
  );
  t.after(() => service.close());
  await assert.rejects(service.client.start("bad/id"), /request_id/);
  assert.throws(() => service.client.prompt("s1", "p1", " "), /Prompt/);
  assert.throws(
    () => service.client.prompt("s1", "p1", "🟠".repeat(70000)),
    /bytes/,
  );
  assert.throws(
    () => service.client.interrupt("s1", "stop", "bad/id"),
    /request_id/,
  );
  assert.deepEqual(service.requests, []);
});

test("rejects a receipt for another request or session", async (t) => {
  const service = await fixture((_req, res) =>
    sendJson(
      res,
      {
        session_id: "other-session",
        receipt: {
          request_id: "other-request",
          command: "prompt",
          state: "completed",
          input: {},
        },
        saving: true,
      },
      202,
    ),
  );
  t.after(() => service.close());
  await assert.rejects(
    service.client.prompt("s1", "p1", "hello"),
    /does not match/,
  );
});

test("authentication failures and redirects do not leak tokens or retry commands", async (t) => {
  const service = await fixture((req, res) => {
    if (req.url === "/v1/health")
      return sendJson(res, { error: "secret-from-server" }, 401);
    res.writeHead(307, { Location: "/stolen" });
    res.end();
  });
  t.after(() => service.close());
  await assert.rejects(
    service.client.health(),
    (error: unknown) =>
      error instanceof CloudroomError &&
      error.status === 401 &&
      !error.message.includes("secret-from-server"),
  );
  await assert.rejects(service.client.start("p1"), /unreachable/);
  assert.deepEqual(service.requests, ["GET /v1/health", "POST /v1/sessions"]);
});

test("replay supports noncontiguous sequences and rejects wrong-session or unordered records", async (t) => {
  let variant = 0;
  const service = await fixture((req, res) => {
    if (req.url === "/v1/sessions/s1") return sendJson(res, snapshot(18));
    const events =
      variant === 0
        ? [event(9), event(18)]
        : variant === 1
          ? [event(9, {}, "other")]
          : [event(9), event(8)];
    if (req.url === "/v1/sessions/s1/events?after=5")
      return sendJson(res, { events });
    assert.equal(req.url, "/v1/sessions/s1/stream?after=5");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      events
        .map(
          (item) =>
            `id: ${item.sequence}\nevent: record\ndata: ${JSON.stringify(item)}\n\n`,
        )
        .join(""),
    );
  });
  t.after(() => service.close());
  assert.deepEqual(
    (await service.client.events("s1", 5)).map((item) => item.sequence),
    [9, 18],
  );
  variant = 1;
  await assert.rejects(service.client.events("s1", 5), /session mismatch/);
  variant = 2;
  await assert.rejects(service.client.events("s1", 5), /out of order/);
});

test("replays more than 16 MiB and 256 records, stopping at the snapshot without closing the session", async (t) => {
  const records = Array.from({ length: 300 }, (_, i) =>
    event((i + 1) * 2, { text: "x".repeat(64 * 1024) }),
  );
  const service = await fixture(async (req, res) => {
    if (req.url === "/v1/sessions/s1") return sendJson(res, snapshot(600));
    if (req.url === "/v1/sessions/s1/events?after=0")
      return sendJson(res, { events: records.slice(0, 256) });
    assert.equal(req.url, "/v1/sessions/s1/stream?after=0");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const item of records) {
      if (!res.write(frame(item.sequence, item.data))) await once(res, "drain");
    }
    res.write(frame(602, { text: "new output after the snapshot" }));
  });
  t.after(() => service.close());
  const client = new CloudroomClient({
    url: service.url,
    token: "test-token",
    timeoutMs: 5000,
  });
  assert.deepEqual(await client.events("s1"), records);
  assert.deepEqual(service.requests, [
    "GET /v1/sessions/s1",
    "GET /v1/sessions/s1/stream?after=0",
  ]);
});

test("replay handles caught-up cursors and rejects incomplete or cancelled history", async (t) => {
  let last = 0;
  let mode = "incomplete";
  const service = await fixture((req, res) => {
    if (req.url === "/v1/sessions/s1") return sendJson(res, snapshot(last));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "cancel") return res.flushHeaders();
    res.end(frame(9) + (mode === "past-snapshot" ? frame(21) : ""));
  });
  t.after(() => service.close());
  assert.deepEqual(await service.client.events("s1"), []);
  last = 18;
  assert.deepEqual(await service.client.events("s1", 18), []);
  assert.deepEqual(await service.client.events("s1", 20), []);
  assert(
    service.requests.every((request) => request === "GET /v1/sessions/s1"),
  );
  await assert.rejects(
    service.client.events("s1"),
    /Incomplete Cloudroom history/,
  );
  mode = "past-snapshot";
  await assert.rejects(
    service.client.events("s1"),
    /Incomplete Cloudroom history/,
  );
  mode = "cancel";
  await assert.rejects(
    service.client.events("s1", 0, AbortSignal.timeout(50)),
    /abort|cancel|timeout/i,
  );
  assert(service.requests.every((request) => request.startsWith("GET ")));
});

test("preserves nested JSON payloads and rejects nonfinite nested numbers", async (t) => {
  const data = {
    items: [null, false, 0, "", { output: ["🟠", { text: "tool result" }] }],
  };
  let invalid = false;
  const service = await fixture((req, res) => {
    if (req.url === "/v1/sessions/s1") return sendJson(res, snapshot(9));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      invalid
        ? frame(9, { items: ["overflow"] }).replace('"overflow"', "1e999")
        : frame(9, data),
    );
  });
  t.after(() => service.close());
  assert.deepEqual((await service.client.events("s1"))[0].data, data);
  invalid = true;
  await assert.rejects(
    service.client.events("s1"),
    /Invalid Cloudroom response/,
  );
});

test("reports idle connections, distinguishes transport from replay failures, and keeps diagnostics safe", async (t) => {
  let mode = "idle";
  let stream: ServerResponse | undefined;
  const service = await fixture((_req, res) => {
    if (mode === "unauthorized") return sendJson(res, { error: "SECRET-CANARY" }, 401);
    if (mode === "invalid-type") return sendJson(res, {});
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "invalid-record") return void res.end("id: 1\nevent: record\ndata: invalid-json\n\n");
    res.write(": keep-alive\n\n");
    stream = res;
  });
  t.after(() => service.close());
  let connections = 0;
  const connected = Promise.withResolvers<void>();
  const consume = async () => {
    for await (const _ of service.client.stream("s1", {
      signal: AbortSignal.timeout(2000),
      onConnected: () => { connections++; connected.resolve(); },
    })) assert.fail("idle stream must not invent records");
  };
  const disconnected = assert.rejects(consume(), (error: unknown) => {
    assert(error instanceof CloudroomConnectionError);
    assert.equal(error.networkCode, "UND_ERR_SOCKET");
    assert.equal(error.message, "Cloudroom event stream disconnected");
    return true;
  });
  await connected.promise;
  assert.equal(connections, 1);
  stream!.destroy();
  await disconnected;
  for (mode of ["unauthorized", "invalid-type"]) {
    await assert.rejects(consume(), CloudroomError);
    assert.equal(connections, 1);
  }
  mode = "invalid-record";
  await assert.rejects(consume(), (error: unknown) => error instanceof CloudroomError && !(error instanceof CloudroomConnectionError));
  assert.equal(connections, 2);
  const diagnostic = new CloudroomConnectionError("Disconnected", new Error("SECRET-CANARY", { cause: { code: "SECRET-CANARY" } }));
  assert.equal(diagnostic.networkCode, null);
  assert(!JSON.stringify(diagnostic).includes("SECRET-CANARY"));
  assert(!diagnostic.stack?.includes("SECRET-CANARY"));
});

test("streams fragmented UTF-8 and CRLF frames, ignores heartbeat/duplicates, and detaches without closing the session", async (t) => {
  const service = await fixture((req, res) => {
    assert.equal(req.url, "/v1/sessions/s1/stream?after=5");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const bytes = Buffer.from(
      `: heartbeat\r\n\r\n${frame(5)}${frame(9, { text: "hello 🟠" })}${frame(9)}${frame(12)}`,
    );
    let i = 0;
    const timer = setInterval(() => {
      if (i >= bytes.length) {
        clearInterval(timer);
        res.end();
      } else res.write(bytes.subarray(i, ++i));
    }, 1);
    res.on("close", () => clearInterval(timer));
  });
  t.after(() => service.close());
  const found = [];
  for await (const item of service.client.stream("s1", {
    after: 5,
    signal: AbortSignal.timeout(5000),
  })) {
    found.push(item);
    if (found.length === 2) break;
  }
  assert.deepEqual(
    found.map((item) => item.sequence),
    [9, 12],
  );
  assert.deepEqual(found[0].data, { text: "hello 🟠" });
  assert.deepEqual(service.requests, ["GET /v1/sessions/s1/stream?after=5"]);
});

test("rejects invalid stream cursors and mismatched event bodies", async (t) => {
  const service = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`id: 20\nevent: record\ndata: ${JSON.stringify(event(21))}\n\n`);
  });
  t.after(() => service.close());
  await assert.rejects(async () => {
    for await (const _ of service.client.stream("s1", {
      signal: AbortSignal.timeout(1000),
    })) {
    }
  }, /cursor mismatch/);
});

test("times out a stalled command without resubmitting", async (t) => {
  const service = await fixture(() => {}, 150);
  t.after(() => service.close());
  await assert.rejects(service.client.start("once"), /cancelled or timed out/);
  assert.equal(service.requests.length, 1);
});

test("reads core status without exposing private fields as client configuration", async (t) => {
  const service = await fixture((_req, res) =>
    sendJson(res, {
      session: {
        session_id: "s1",
        harness: "codex",
        state: "idle",
        native_id: "native-1",
        current_request: null,
        last_sequence: 42,
        queue: ["p2"],
        receipts: {
          p2: {
            request_id: "p2",
            command: "prompt",
            state: "accepted",
            input: { text: "next" },
          },
        },
      },
    }),
  );
  t.after(() => service.close());
  const state = await service.client.session("s1");
  assert.equal(state.native_id, "native-1");
  assert.equal(state.receipts.p2.state, "accepted");
  assert.deepEqual(state.queue, ["p2"]);
});
