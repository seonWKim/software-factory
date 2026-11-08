// This machine's host id (RFC 0015 M7, M8; design 10-event-driven, Git destinations): the factory repo's git writes
// leave from the machine whose repo holds them, so their destinations name it (`git:<host id>:<branch>`). The id is
// written once to the state dir's `host-id` file and read back by every process on the machine (controller, worker,
// session), so a changed hostname (a laptop on another network, a new pod name) orphans no delivery.

import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const HOST_ID_FILE = "host-id";

/** The state dir's host id, created on first use: the short hostname at that time plus a random suffix. */
export function hostId(stateDir: string): string {
  const file = join(stateDir, HOST_ID_FILE);
  const read = () => {
    try {
      return readFileSync(file, "utf8").trim() || null;
    } catch {
      return null;
    }
  };
  const stored = read();
  if (stored) return stored;
  const name = (hostname().split(".")[0] ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "host";
  const suffix = randomBytes(3).toString("hex");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // Written whole to a temporary file, then linked in place: the link fails if another process starting at the same
  // time linked its id first, and then that id is the one read. No reader ever sees a half-written file.
  const tmp = `${file}.${process.pid}.${suffix}`;
  writeFileSync(tmp, `${name}-${suffix}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    unlinkSync(tmp);
  }
  return read()!;
}

/**
 * The controller's git host: its `id`, and whether it flushes every host's git destinations. A SQLite store is on
 * one machine with one controller (solo), so it flushes all of them, and nothing waits on an older id. Replicas on a
 * shared store (enterprise) flush their own id's only, since only that machine's repo holds the commits.
 */
export function gitHost(stateDir: string, storePlugin: string): { id: string; flush_all: boolean } {
  return { id: hostId(stateDir), flush_all: storePlugin === "sqlite" };
}
