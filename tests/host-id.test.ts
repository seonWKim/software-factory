import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOST_ID_FILE, gitHost, hostId } from "../src/runtime/host-id.js";

// Git destinations name the machine by the state dir's host id (design 10-event-driven, Git destinations): every
// process reads the one written first, so a restart, a second process or a changed hostname keeps the destination.

describe("host id", () => {
  it("is created once in the state dir and read back by every later call", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-host-"));
    const id = hostId(dir);
    expect(id).toMatch(/^[A-Za-z0-9_-]+-[0-9a-f]{6}$/);
    expect(hostId(dir)).toBe(id);
    expect(readFileSync(join(dir, HOST_ID_FILE), "utf8").trim()).toBe(id);
  });

  it("a SQLite store's controller flushes every host's git destinations; a shared store's only its own", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-host-"));
    expect(gitHost(dir, "sqlite")).toEqual({ id: hostId(dir), flush_all: true });
    expect(gitHost(dir, "mysql")).toEqual({ id: hostId(dir), flush_all: false });
  });
});
