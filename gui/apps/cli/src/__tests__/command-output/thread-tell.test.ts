import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as fixtures from "../helpers/command-output-fixtures.js";
import {
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("room-cli thread tell command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  function stubTellApi(handlers: Parameters<typeof stubServerApi>[0]): void {
    stubServerApi({
      "v1.threads.:id.$get": async () =>
        fixtures.makeThread({
          id: "thread-local",
          projectId: "proj-local",
          providerId: "codex",
          executionTarget: "local",
        }),
      ...handlers,
    });
  }

  it("room-cli thread tell --json prints the raw response plus thread id", async () => {
    const post = vi.fn(async () => ({ ok: true, delivery: "sent" }));
    stubTellApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-json-tell", "hello", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      threadId: "thread-json-tell",
      ok: true,
      delivery: "sent",
      mode: "steer",
    });
  });

  const sendAt = Date.UTC(2026, 10, 8, 7);
  it.each([
    [
      { kind: "interaction" },
      null,
      "waiting for a pending interaction); it dispatches when that clears unless Stop pauses the queue, then run `room-cli thread queue send thread-q qm_1`",
    ],
    [
      {
        kind: "plugin",
        pluginId: "concurrency-limit",
        reason: "4 of 4 running",
      },
      null,
      "concurrency-limit: 4 of 4 running); it dispatches when that clears unless Stop pauses the queue, then run `room-cli thread queue send thread-q qm_1`",
    ],
    [
      { kind: "time" },
      sendAt,
      `scheduled for ${new Date(sendAt).toLocaleString()}); it dispatches at that time on its own. Do not run \`room-cli thread queue send thread-q qm_1\`: it sends the message now.`,
    ],
  ])(
    "room-cli thread tell names the typed reason a message queued for (%j)",
    async (waitingOn, rowSendAt, expected) => {
      // The server says WHY, so the CLI stops inferring it from the flags it
      // sent — which is what let the old four-way delivery enum collapse.
      const post = vi.fn(async () => ({
        ok: true,
        delivery: "queued",
        queuedMessage: { id: "qm_1", waitingOn, sendAt: rowSendAt },
      }));
      stubTellApi({ "v1.threads.:id.send.$post": post });

      await runCommand(["thread", "tell", "thread-q", "hello"], register);

      expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe(
        `Thread thread-q message queued (${expected}`,
      );
    },
  );

  it("room-cli thread tell keeps the steered wording for servers that only report ok", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubTellApi({ "v1.threads.:id.send.$post": post });

    await runCommand(["thread", "tell", "thread-legacy", "hello"], register);

    expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe(
      "Thread thread-legacy steered",
    );
  });

  it.each([
    [
      "was not sent",
      async () =>
        new Response(JSON.stringify({ code: "caller_proof_required" }), {
          status: 401,
        }),
      "Error: The message was not sent; sending it again is safe. HTTP 401",
    ],
    [
      "was not sent when Cloudroom is down",
      () =>
        Promise.reject(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), {
              code: "ECONNREFUSED",
            }),
          }),
        ),
      "Error: The message was not sent; sending it again is safe. Cannot connect to Cloudroom server.",
    ],
    [
      "may already have been sent",
      () => Promise.reject(new TypeError("fetch failed")),
      "Error: Cloudroom did not confirm the message, so it may already have been sent (fetch failed). Check `room-cli thread show thread-x` before sending it again.",
    ],
  ])(
    "room-cli thread tell says a failed message %s",
    async (_, post, error) => {
      stubTellApi({ "v1.threads.:id.send.$post": post });

      await expect(
        runCommand(["thread", "tell", "thread-x", "hello"], register),
      ).rejects.toThrow("process.exit:1");
      expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain(
        error,
      );
    },
  );

  it("room-cli thread tell keeps the request ID when a Cloud reply is lost", async () => {
    const post = vi.fn(async () => new Response("", { status: 200 }));
    stubTellApi({
      "v1.threads.:id.$get": async () =>
        fixtures.makeThread({
          id: "thread-x",
          projectId: "proj-local",
          providerId: "codex",
          executionTarget: "cloud",
        }),
      "v1.threads.:id.send.$post": post,
    });

    await expect(
      runCommand(
        ["thread", "tell", "thread-x", "hi", "--mode", "queue", "--json"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    const { requestId } = (
      post.mock.calls[0] as unknown as [{ json: { requestId: string } }]
    )[0].json;
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toMatchObject({ ok: false, unconfirmed: true, requestId });
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain(
      `--request-id ${requestId}`,
    );
  });

  it("room-cli thread tell --mode queue preserves non-urgent queued delivery", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubTellApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-queue-tell", "hello", "--mode", "queue"],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-queue-tell" },
      json: {
        requestId: expect.any(String),
        input: [{ type: "text", text: "hello", mentions: [] }],
        mode: "queue-if-active",
      },
    });
  });

  it("room-cli thread tell --mode auto preserves explicit legacy auto delivery", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubTellApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-auto-tell", "hello", "--mode", "auto"],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-auto-tell" },
      json: {
        requestId: expect.any(String),
        input: [{ type: "text", text: "hello", mentions: [] }],
        mode: "auto",
      },
    });
  });

  it("room-cli thread tell forwards execution options", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubTellApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      [
        "thread",
        "tell",
        "thread-execution-options",
        "hello",
        "--model",
        "gpt-5.5",
        "--service-tier",
        "fast",
        "--reasoning-level",
        "high",
        "--permission-mode",
        "accept-edits",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-execution-options" },
      json: {
        requestId: expect.any(String),
        input: [{ type: "text", text: "hello", mentions: [] }],
        mode: "steer-if-active",
        model: "gpt-5.5",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      },
    });
  });

  it("room-cli thread tell forwards automatic review mode", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubTellApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      [
        "thread",
        "tell",
        "thread-auto-review",
        "hello",
        "--permission-mode",
        "auto",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-auto-review" },
      json: {
        requestId: expect.any(String),
        input: [{ type: "text", text: "hello", mentions: [] }],
        mode: "steer-if-active",
        permissionMode: "auto",
      },
    });
  });

  it("room-cli thread tell --plan sends the composer's /plan command mention", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubTellApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      [
        "thread",
        "tell",
        "thread-plan",
        "add a README",
        "--plan",
        "--file",
        "existing-report.pdf",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-plan" },
      json: {
        requestId: expect.any(String),
        input: [
          {
            type: "text",
            text: "/plan add a README",
            mentions: [
              {
                start: 0,
                end: 5,
                resource: {
                  kind: "command",
                  trigger: "/",
                  name: "plan",
                  source: "command",
                  origin: "builtin",
                  label: "plan",
                  argumentHint: null,
                },
              },
            ],
          },
          { type: "localFile", path: "existing-report.pdf" },
        ],
        mode: "steer-if-active",
      },
    });
  });

  it.each([
    ["image", "localImage", "screenshot.png", "image/png", false],
    ["file", "localFile", "report.pdf", "application/pdf", false],
    ["file", "localFile", "report with spaces.pdf", "application/pdf", true],
  ] as const)(
    "room-cli thread tell uploads client %s paths to the target project",
    async (flag, type, filename, mimeType, fileUrl) => {
      const clientDir = await mkdtemp(join(tmpdir(), "bb-cli-thread-image-"));
      try {
        const attachmentPath = join(clientDir, filename);
        const uploadedPath = "uploaded-" + filename;
        const bytes = new Uint8Array([137, 80, 78, 71]);
        await writeFile(attachmentPath, bytes);
        const get = vi.fn(async () =>
          fixtures.makeThread({
            id: "thread-attachments",
            projectId: "proj-target",
            providerId: "codex",
          }),
        );
        const post = vi.fn(async () => ({ ok: true }));
        stubTellApi({
          "v1.threads.:id.$get": get,
          "v1.threads.:id.send.$post": post,
        });
        vi.mocked(globalThis.fetch).mockResolvedValue(
          new Response(
            JSON.stringify({
              type,
              path: uploadedPath,
              name: filename,
              mimeType,
              sizeBytes: bytes.byteLength,
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );

        await runCommand(
          [
            "thread",
            "tell",
            "thread-attachments",
            "review these",
            "--file",
            "existing-report.pdf",
            "--" + flag,
            fileUrl ? pathToFileURL(attachmentPath).href : attachmentPath,
          ],
          register,
        );

        expect(get).toHaveBeenCalledWith({
          param: { id: "thread-attachments" },
        });
        expect(globalThis.fetch).toHaveBeenCalledWith(
          "http://server/api/v1/projects/proj-target/attachments",
          expect.objectContaining({
            body: expect.any(FormData),
            method: "POST",
          }),
        );
        const uploadBody = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body;
        expect(uploadBody).toBeInstanceOf(FormData);
        if (!(uploadBody instanceof FormData))
          throw new Error("Missing upload body");
        const uploadedFile = uploadBody.get("file");
        expect(uploadedFile).toBeInstanceOf(File);
        if (!(uploadedFile instanceof File))
          throw new Error("Missing uploaded file");
        expect(uploadedFile.name).toBe(filename);
        expect(uploadedFile.type).toBe(mimeType);
        expect(new Uint8Array(await uploadedFile.arrayBuffer())).toEqual(bytes);
        expect(post).toHaveBeenCalledWith({
          param: { id: "thread-attachments" },
          json: {
            requestId: expect.any(String),
            input: [
              { type: "text", text: "review these", mentions: [] },
              { type: "localFile", path: "existing-report.pdf" },
              { type, path: uploadedPath },
            ],
            mode: "steer-if-active",
          },
        });
      } finally {
        await rm(clientDir, { force: true, recursive: true });
      }
    },
  );

  it("room-cli thread tell includes sender thread metadata when run inside another thread", async () => {
    vi.stubEnv("ROOM_THREAD_ID", "thread-sender");
    const post = vi.fn(async () => ({ ok: true }));
    stubTellApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-receiver", "hello from sender"],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-receiver" },
      json: {
        requestId: expect.any(String),
        input: [{ type: "text", text: "hello from sender", mentions: [] }],
        mode: "steer-if-active",
        senderThreadId: "thread-sender",
      },
    });
  });

  it("room-cli thread tell omits sender metadata when targeting the current thread", async () => {
    vi.stubEnv("ROOM_THREAD_ID", "thread-self");
    const post = vi.fn(async () => ({ ok: true }));
    stubTellApi({ "v1.threads.:id.send.$post": post });

    await runCommand(["thread", "tell", "thread-self", "self note"], register);

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-self" },
      json: {
        requestId: expect.any(String),
        input: [{ type: "text", text: "self note", mentions: [] }],
        mode: "steer-if-active",
      },
    });
  });
});
