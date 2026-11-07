// One Socket Mode WebSocket (issue #109), behind a small interface so tests use a fake. No SDK: the listener
// (src/core/listener.ts) owns reconnects and the ack-after-store rule, so the source needs only a raw socket.
// The URL carries a one-time ticket: it is never logged.

export interface SocketConnection {
  /** Text frames as they arrive. Completes when the socket closes; throws when it fails. */
  messages: AsyncIterable<string>;
  send(data: string): void;
  close(): void;
}

/** Opens one connection to `url`; resolves once it is open. Aborting `signal` closes it. */
export type SocketConnector = (url: string, signal: AbortSignal) => Promise<SocketConnection>;

/** Node's global WebSocket (Node 22 and later). */
export const webSocketConnector: SocketConnector = (url, signal) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: string[] = [];
    let ended: { error: Error | null } | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const close = () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    };
    signal.addEventListener("abort", close, { once: true });
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      resolve({ messages: frames(), send: (d) => ws.send(d), close });
    });
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") queue.push(ev.data);
      notify();
    });
    ws.addEventListener("error", () => {
      if (!opened) reject(new Error("slack socket: connection failed"));
      ended ??= { error: new Error("slack socket: connection error") };
      notify();
    });
    ws.addEventListener("close", () => {
      if (!opened) reject(new Error("slack socket: closed before it opened"));
      ended ??= { error: null };
      signal.removeEventListener("abort", close);
      notify();
    });

    async function* frames(): AsyncGenerator<string> {
      while (true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) {
          if (ended.error) throw ended.error;
          return;
        }
        await new Promise<void>((r) => (wake = r));
      }
    }
  });
