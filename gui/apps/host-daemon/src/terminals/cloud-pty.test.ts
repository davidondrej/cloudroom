import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openCloudPty, type CloudPty } from "./cloud-pty.js";

interface Attach {
  query: URLSearchParams;
  received: Buffer[];
  socket: Socket;
}

type Step = number | ((attach: Attach) => void);

function frame(kind: number, data: Buffer | string): Buffer {
  const bytes = Buffer.from(data);
  const header = Buffer.alloc(5);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(bytes.byteLength, 1);
  return Buffer.concat([header, bytes]);
}

function hello(offset: number): Buffer {
  return frame(
    2,
    JSON.stringify({ offset, cwd: "/code/app", shell: "/bin/bash" }),
  );
}

const exit = (code: number) => frame(1, JSON.stringify({ code }));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let server: Server | null = null;

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = null;
});

async function fakeCore(steps: Step[]) {
  const attaches: Attach[] = [];
  const deletes: string[] = [];
  let upgrades = 0;
  server = createServer((request, response) => {
    deletes.push(`${request.method} ${request.url}`);
    response.end("{}");
  });
  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    const step = steps[Math.min(upgrades, steps.length - 1)];
    upgrades += 1;
    if (typeof step === "number") {
      socket.end(
        `HTTP/1.1 ${step} Refused\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`,
      );
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    const attach: Attach = {
      query: new URL(request.url ?? "", "http://core").searchParams,
      received: [],
      socket,
    };
    socket.on("data", (chunk: Buffer) => attach.received.push(chunk));
    attaches.push(attach);
    step(attach);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const attached = async (count: number) => {
    while (attaches.length < count) await wait(5);
    return attaches[count - 1] as Attach;
  };
  return {
    attached,
    deletes,
    upgrades: () => upgrades,
    open: () =>
      openCloudPty({
        cols: 100,
        command: null,
        rows: 30,
        target: {
          session: "ses_1",
          token: "secret",
          url: `http://127.0.0.1:${port}`,
        },
        terminalId: "term_1",
      }),
  };
}

function watch(cloud: CloudPty) {
  const state = {
    exitCode: undefined as number | null | undefined,
    output: "",
  };
  cloud.pty.onData((data) => {
    state.output += data;
  });
  cloud.pty.onExit((event) => {
    state.exitCode = event.exitCode;
  });
  return state;
}

describe("cloud terminal connection", () => {
  it("replays missed output after a dropped connection, then reports the exit", async () => {
    const core = await fakeCore([
      (attach) => attach.socket.write(hello(0)),
      (attach) => attach.socket.write(hello(6)),
    ]);
    const cloud = await core.open();
    expect(cloud.cwd).toBe("/code/app");
    const state = watch(cloud);
    const first = await core.attached(1);
    expect(first.query.get("session")).toBe("ses_1");
    first.socket.write(frame(0, "hello "));
    await wait(50);
    first.socket.destroy();
    await wait(100);
    cloud.pty.write("typed while offline\n");

    const second = await core.attached(2);
    expect(second.query.get("since")).toBe("6");
    while (!Buffer.concat(second.received).includes("typed while offline")) {
      await wait(10);
    }
    second.socket.write(frame(0, "world"));
    second.socket.write(exit(0));
    while (state.exitCode === undefined) await wait(10);

    expect(state.exitCode).toBe(0);
    expect(state.output.startsWith("hello ")).toBe(true);
    expect(state.output).toContain("Reconnecting");
    expect(state.output.endsWith("world")).toBe(true);
    cloud.pty.dispose();
    await wait(50);
    expect(core.deletes).toEqual(["DELETE /v1/terminals/term_1"]);
  });

  it("keeps output and an exit that arrive together with the hello", async () => {
    const core = await fakeCore([
      (attach) =>
        attach.socket.write(
          Buffer.concat([hello(0), frame(0, "done\r\n"), exit(3)]),
        ),
    ]);
    const cloud = await core.open();
    await wait(20);
    const state = watch(cloud);

    expect(state.output).toBe("done\r\n");
    expect(state.exitCode).toBe(3);
  });

  it("runs one reconnect loop when a reconnect closes before its hello", async () => {
    const core = await fakeCore([
      (attach) => attach.socket.write(hello(0)),
      (attach) => attach.socket.destroy(),
      (attach) => attach.socket.write(hello(0)),
    ]);
    const cloud = await core.open();
    const state = watch(cloud);
    (await core.attached(1)).socket.destroy();
    await core.attached(3);
    await wait(2_000);

    expect(core.upgrades()).toBe(3);
    expect(state.exitCode).toBeUndefined();
    cloud.pty.dispose();
  });

  it("keeps the shell through an outage instead of ending or deleting it", async () => {
    const core = await fakeCore([
      (attach) => attach.socket.write(hello(0)),
      503,
      503,
      (attach) => attach.socket.write(hello(0)),
    ]);
    const cloud = await core.open();
    const state = watch(cloud);
    (await core.attached(1)).socket.destroy();
    await core.attached(2);
    await wait(50);

    expect(state.exitCode).toBeUndefined();
    expect(state.output).toContain("Reconnected.");
    expect(core.deletes).toEqual([]);
    cloud.pty.dispose();
  });

  it("ends without deleting when the sandbox says the shell is gone", async () => {
    const core = await fakeCore([
      (attach) => attach.socket.write(hello(0)),
      410,
    ]);
    const cloud = await core.open();
    const state = watch(cloud);
    (await core.attached(1)).socket.destroy();
    while (state.exitCode === undefined) await wait(10);
    cloud.pty.dispose();
    await wait(50);

    expect(state.exitCode).toBeNull();
    expect(core.deletes).toEqual([]);
  });
});
