import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket as NodeWebSocket } from "ws";
import {
  decodeFrame,
  encodeFrame,
  type Frame,
} from "@cloudroom/tunnel-contract";
import { TunnelSession } from "../src/session.js";

const DOWNLOAD_BYTES = 4 * 1024 * 1024;

/** A tunnel on a slow link: what is sent stays queued until `drain` is set. */
class SlowTunnel extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  drain = false;
  readonly frames: Frame[] = [];

  send(data: string | Uint8Array): void {
    if (typeof data === "string") return;
    this.frames.push(decodeFrame(data));
    if (!this.drain) this.bufferedAmount += data.byteLength;
  }

  terminate(): void {}

  bodyBytes(): number {
    return this.frames.reduce(
      (total, frame) =>
        total + (frame.type === "body-chunk" ? frame.data.byteLength : 0),
      0,
    );
  }
}

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((_request, response) =>
    response.end(Buffer.alloc(DOWNLOAD_BYTES)),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("TunnelSession", () => {
  it("stops reading a big download while the tunnel is backed up, so a ping is never stuck behind it", async () => {
    const tunnel = new SlowTunnel();
    const session = new TunnelSession({
      tunnel: tunnel as unknown as NodeWebSocket,
      log: { warn() {} },
      resolveOrigin: () => ({
        kind: "ok",
        resolved: { origin, publicOrigin: origin },
      }),
    });
    session.start();
    tunnel.emit(
      "message",
      Buffer.from(
        encodeFrame({
          type: "open-http",
          streamId: 1,
          method: "GET",
          path: "/big",
          headers: [],
          hasBody: false,
        }),
      ),
      true,
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(tunnel.bodyBytes()).toBeGreaterThan(0);
    expect(tunnel.bodyBytes()).toBeLessThan(1024 * 1024);

    tunnel.drain = true;
    tunnel.bufferedAmount = 0;
    await expect
      .poll(() => tunnel.frames.at(-1)?.type, { timeout: 5_000 })
      .toBe("body-end");
    expect(tunnel.bodyBytes()).toBe(DOWNLOAD_BYTES);
    session.dispose();
  });
});
