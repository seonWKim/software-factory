// The runner's local JSON-line socket host, shared by the gate hooks host and the tool bridge host. A Unix socket
// in a fresh private folder (mkdtemp, mode 0700) under the OS temp folder: the harness config dir can be too long
// for the platform's socket path limit. Each caller keeps its own size limit and reply style.

import { mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface JsonLineHost {
  /** The socket path. Not a credential: every request on it goes through the caller's checks. */
  socket: string;
  /** Destroys every open connection, stops the server and removes the socket's folder. */
  close(): Promise<void>;
}

/**
 * Opens a socket under `<tmp>/<prefix>XXXXXX/s`. Every newline-ended line on a connection is parsed as JSON (a
 * malformed line gives `null`) and handed with its connection to `onRequest`, which writes the reply. A connection
 * whose unanswered bytes pass `maxBytes` is destroyed.
 */
export async function startJsonLineHost(
  prefix: string,
  maxBytes: number,
  onRequest: (req: unknown, conn: Socket) => void,
): Promise<JsonLineHost> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const socket = join(dir, "s");
  const conns = new Set<Socket>();
  const server: Server = createServer((conn) => {
    conns.add(conn);
    conn.on("close", () => conns.delete(conn));
    conn.on("error", () => conn.destroy());
    conn.setEncoding("utf8");
    let buf = "";
    conn.on("data", (chunk: Buffer | string) => {
      buf += String(chunk);
      if (buf.length > maxBytes) return void conn.destroy();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req: unknown = null;
        try {
          req = JSON.parse(line);
        } catch {
          // malformed: the caller answers null
        }
        onRequest(req, conn);
      }
    });
  });
  try {
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(socket, () => res());
    });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    socket,
    close: async () => {
      for (const c of conns) c.destroy();
      await new Promise<void>((res) => server.close(() => res()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
