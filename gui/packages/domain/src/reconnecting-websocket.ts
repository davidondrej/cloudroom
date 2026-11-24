// Ported from partysocket 1.3.0's ReconnectingWebSocket (MIT, see gui/NOTICE),
// keeping only what the app's realtime socket and the host daemon's server
// connection use. Both send only on an open socket and listen through the on*
// handlers, so there is no offline send queue and no EventTarget.

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;
// A connection that stays open this long resets the reconnect backoff.
const MIN_UPTIME_MS = 5_000;

type Listener = (event: any) => void;

interface Socket {
  readonly bufferedAmount: number;
  readonly readyState: number;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export interface ReconnectingWebSocketOptions {
  minReconnectionDelay: number;
  maxReconnectionDelay: number;
  reconnectionDelayGrowFactor: number;
  connectionTimeout: number;
  maxRetries: number;
  WebSocket?: new (url: string, protocols?: string | string[]) => object;
}

class ErrorEvent extends Event {
  readonly message: string;
  readonly error: Error;

  constructor(error: Error) {
    super("error");
    this.message = error.message;
    this.error = error;
  }
}

class CloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean = true;

  constructor(code: number, reason = "") {
    super("close");
    this.code = code;
    this.reason = reason;
  }
}

// A discarded Node `ws` socket can still emit "error"; an EventEmitter with no
// error listener throws, which would crash the process.
function absorbError(): void {}

export class ReconnectingWebSocket {
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;
  private socket: Socket | undefined;
  private retryCount = -1;
  private uptimeTimeout: ReturnType<typeof setTimeout> | undefined;
  private connectTimeout: ReturnType<typeof setTimeout> | undefined;
  private shouldReconnect = true;
  private connectLock = false;
  private closeCalled = false;
  private readonly url: string | (() => string | Promise<string>);
  private readonly protocols: string | string[] | undefined;
  private readonly options: ReconnectingWebSocketOptions;

  constructor(
    url: string | (() => string | Promise<string>),
    protocols: string | string[] | undefined,
    options: ReconnectingWebSocketOptions,
  ) {
    this.url = url;
    this.protocols = protocols;
    this.options = options;
    this.connect();
  }

  get bufferedAmount(): number {
    return this.socket?.bufferedAmount ?? 0;
  }

  get readyState(): number {
    if (this.closeCalled) return CLOSED;
    return this.socket?.readyState ?? CONNECTING;
  }

  send(data: string): void {
    if (this.socket?.readyState === OPEN) this.socket.send(data);
  }

  // Stops reconnecting until reconnect(). A live socket's onclose runs before
  // this returns.
  close(code = 1000, reason?: string): void {
    this.closeCalled = true;
    this.shouldReconnect = false;
    this.clearTimeouts();
    if (this.isLive()) this.disconnect(code, reason);
  }

  // Drops the current socket and connects again at once, with a fresh backoff.
  reconnect(code?: number, reason?: string): void {
    this.shouldReconnect = true;
    this.closeCalled = false;
    this.retryCount = -1;
    if (this.isLive()) this.disconnect(code, reason);
    this.connect();
  }

  private isLive(): boolean {
    const state = this.socket?.readyState;
    return state === CONNECTING || state === OPEN;
  }

  private nextDelay(): number {
    if (this.retryCount <= 0) return 0;
    const { minReconnectionDelay, maxReconnectionDelay } = this.options;
    const growth =
      this.options.reconnectionDelayGrowFactor ** (this.retryCount - 1);
    return Math.min(minReconnectionDelay * growth, maxReconnectionDelay);
  }

  private connect(): void {
    if (this.connectLock || !this.shouldReconnect) return;
    this.connectLock = true;
    if (this.retryCount >= this.options.maxRetries) {
      this.connectLock = false;
      return;
    }
    this.retryCount += 1;
    this.removeListeners();
    const url = this.url;
    new Promise((resolve) => setTimeout(resolve, this.nextDelay()))
      .then(() => (typeof url === "string" ? url : url()))
      .then((nextUrl) => {
        if (this.closeCalled) {
          this.connectLock = false;
          return;
        }
        const WebSocketClass = this.options.WebSocket ?? WebSocket;
        const socket = (
          this.protocols
            ? new WebSocketClass(nextUrl, this.protocols)
            : new WebSocketClass(nextUrl)
        ) as Socket;
        this.socket = socket;
        this.connectLock = false;
        socket.addEventListener("open", this.handleOpen);
        socket.addEventListener("close", this.handleClose);
        socket.addEventListener("message", this.handleMessage);
        socket.addEventListener("error", this.handleError);
        this.connectTimeout = setTimeout(() => {
          this.handleError(new ErrorEvent(new Error("TIMEOUT")));
        }, this.options.connectionTimeout);
      })
      .catch((error: Error) => {
        this.connectLock = false;
        this.handleError(new ErrorEvent(new Error(error.message)));
      });
  }

  // Closes the socket and reports the close at once, without waiting for it.
  private disconnect(code = 1000, reason?: string): void {
    this.clearTimeouts();
    if (!this.socket) return;
    this.removeListeners();
    try {
      if (this.isLive()) this.socket.close(code, reason);
      this.handleClose(new CloseEvent(code, reason));
    } catch {
      // Like partysocket, swallow a throwing close() or onclose handler.
    }
  }

  private readonly handleOpen = (event: unknown): void => {
    clearTimeout(this.connectTimeout);
    this.uptimeTimeout = setTimeout(() => {
      this.retryCount = 0;
    }, MIN_UPTIME_MS);
    this.onopen?.(event);
  };

  private readonly handleMessage = (event: unknown): void => {
    this.onmessage?.(event);
  };

  private readonly handleError = (event: { message?: string }): void => {
    this.disconnect(
      undefined,
      event.message === "TIMEOUT" ? "timeout" : undefined,
    );
    this.onerror?.(event);
    this.connect();
  };

  private readonly handleClose = (event: unknown): void => {
    this.clearTimeouts();
    if (this.shouldReconnect) this.connect();
    this.onclose?.(event);
  };

  private removeListeners(): void {
    if (!this.socket) return;
    this.socket.removeEventListener("open", this.handleOpen);
    this.socket.removeEventListener("close", this.handleClose);
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("error", this.handleError);
    this.socket.addEventListener("error", absorbError);
  }

  private clearTimeouts(): void {
    clearTimeout(this.connectTimeout);
    clearTimeout(this.uptimeTimeout);
  }
}
