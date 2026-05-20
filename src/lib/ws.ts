import type { ClientEvent, ServerEvent } from "../../shared/protocol";

type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

type Options = {
  url: string;
  onMessage: (event: ServerEvent) => void;
  onOpen?: () => void;
  onStateChange?: (state: ConnectionState) => void;
};

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

export class ReconnectingSocket {
  private options: Options;
  private socket: WebSocket | null = null;
  private state: ConnectionState = "connecting";
  private closed = false;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: number | null = null;

  constructor(options: Options) {
    this.options = options;
    this.connect();
  }

  send(event: ClientEvent) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
    }
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setState("closed");
  }

  private connect() {
    if (this.closed) return;
    this.setState(this.backoff === INITIAL_BACKOFF_MS ? "connecting" : "reconnecting");

    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.setState("open");
      this.options.onOpen?.();
    });

    socket.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(event.data) as ServerEvent;
        this.options.onMessage(parsed);
      } catch {
        // Server should always send JSON; drop anything else silently.
      }
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      if (this.closed) return;
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // The close event will follow; reconnect logic lives there.
    });
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.setState("reconnecting");
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: ConnectionState) {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
