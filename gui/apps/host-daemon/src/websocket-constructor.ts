import { WebSocket as NodeWebSocket } from "ws";

interface NodeWebSocketConstructor {
  new (address: string | URL, protocols?: string | string[]): object;
}

export type NodeWebSocketHeaders =
  | Record<string, string>
  | (() => Record<string, string>);

export function createNodeWebSocketConstructor(
  headers: NodeWebSocketHeaders | undefined,
): NodeWebSocketConstructor {
  if (!headers) {
    return NodeWebSocket;
  }

  return class HeaderAwareWebSocket extends NodeWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, {
        headers: typeof headers === "function" ? headers() : headers,
      });
    }
  };
}
