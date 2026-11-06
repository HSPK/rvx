import {assertAuthenticated, AuthenticationRequired, requireAuthentication} from "../auth/session";

/** Authenticated app-level heartbeat; only a matching pong establishes connectivity or RTT. */
export class ConnectionMonitor {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: {id: string; sent: number} | null = null;
  private lifetime = new AbortController();
  private attempts = 0;
  private sequence = 0;
  private connectedBefore = false;
  private pageHidden = false;
  private state = "";
  constructor(private reconnected: () => void, private changed: (state: {state: string; text: string; label: string; announce: boolean}) => void) {
    this.update("connecting", "Connecting");
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {this.release(); this.update("offline", "Inactive while this page is hidden");}
      else this.connect();
    }, {signal: this.lifetime.signal});
    window.addEventListener("online", () => this.connect(), {signal: this.lifetime.signal});
    window.addEventListener("offline", () => {this.release(); this.update("offline", "Offline");}, {signal: this.lifetime.signal});
    window.addEventListener("pagehide", () => {this.pageHidden = true; this.release();}, {signal: this.lifetime.signal});
    window.addEventListener("pageshow", () => {this.pageHidden = false; this.connect();}, {signal: this.lifetime.signal});
  }
  start(): void {this.connect();}
  private update(state: string, text: string): void {
    const label = state === "offline" ? text === "Sign in required" ? "Sign in" : navigator.onLine ? "Disconnected" : "Offline"
      : state === "connecting" && this.connectedBefore ? "Reconnecting" : "";
    this.changed({state, text, label, announce: state !== this.state});
    this.state = state;
  }
  private connect(): void {
    if (this.lifetime.signal.aborted || this.pageHidden || document.hidden || this.socket) return;
    try {assertAuthenticated();} catch (error) {if (error instanceof AuthenticationRequired) return; throw error;}
    if (!navigator.onLine) {this.update("offline", "Offline"); return;}
    this.clearTimer();
    this.update("connecting", this.connectedBefore ? "Reconnecting" : "Connecting");
    const url = new URL("/api/ui/connection", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url); this.socket = socket;
    this.timer = setTimeout(() => this.failed(socket), 10_000);
    socket.onopen = () => {if (this.socket === socket) this.ping(socket);};
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      let value: unknown;
      try {value = typeof event.data === "string" && event.data.length <= 1024 ? JSON.parse(event.data) : null;}
      catch {this.failed(socket); return;}
      if (!value || typeof value !== "object" || !("type" in value) || value.type !== "pong" || !("id" in value) || !this.pending || value.id !== this.pending.id) {this.failed(socket); return;}
      const rtt = Math.max(0, Math.round(performance.now() - this.pending.sent));
      const reconnect = this.connectedBefore && this.state !== "connected";
      this.pending = null; this.attempts = 0; this.connectedBefore = true;
      this.update("connected", `Connected · WebSocket RTT ${rtt} ms`);
      this.clearTimer(); this.timer = setTimeout(() => this.ping(socket), 5000);
      if (reconnect) this.reconnected();
    };
    socket.onerror = () => this.failed(socket);
    socket.onclose = event => {
      if (this.socket === socket && event.code === 1008 && event.reason === "session expired or revoked") {
        this.suspend(); requireAuthentication(); return;
      }
      this.failed(socket);
    };
  }
  private ping(socket: WebSocket): void {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    this.clearTimer();
    const id = `rvx-${++this.sequence}`;
    this.pending = {id, sent: performance.now()};
    socket.send(JSON.stringify({type: "ping", id}));
    this.timer = setTimeout(() => this.failed(socket), 8000);
  }
  private failed(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.release(); this.update("offline", navigator.onLine ? "Disconnected · retrying connection" : "Offline");
    if (!document.hidden && navigator.onLine && !this.lifetime.signal.aborted) {
      this.timer = setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)));
    }
  }
  private clearTimer(): void {if (this.timer !== null) clearTimeout(this.timer); this.timer = null;}
  private release(): void {
    this.clearTimer(); this.pending = null;
    const socket = this.socket; this.socket = null;
    if (socket) {socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; socket.close();}
  }
  /** Stop retries and retire the socket while a sign-in form owns authentication recovery. */
  suspend(): void {this.release(); this.update("offline", "Sign in required");}
  destroy(): void {this.lifetime.abort(); this.release();}
}
