import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CaffeinateKeepAwake,
  type AwakeChild,
  type AwakeLauncher,
  requireExecutable,
} from "../src/impl/awake/caffeinate-keep-awake.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { recordingLog } from "./helpers/fakes.js";

class FakeChild implements AwakeChild {
  killed = 0;
  private readonly handlers: Record<string, ((err: Error) => void)[]> = {};
  on(event: "error", fn: (err: Error) => void): this;
  on(event: "exit", fn: () => void): this;
  on(event: string, fn: (err: Error) => void): this {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  emit(event: "error" | "exit", err: Error = new Error(event)): void {
    for (const fn of this.handlers[event] ?? []) fn(err);
  }
  kill(): boolean {
    this.killed++;
    return true;
  }
}

function fakeLauncher(opts: { throws?: boolean } = {}) {
  const spawned: { cmd: string; args: readonly string[]; child: FakeChild }[] = [];
  const launch: AwakeLauncher = (cmd, args) => {
    if (opts.throws) throw new Error("spawn EACCES");
    const child = new FakeChild();
    spawned.push({ cmd, args, child });
    return child;
  };
  return { launch, spawned };
}

describe("CaffeinateKeepAwake", () => {
  it("the first hold spawns caffeinate -i -s -w <pid> once; a second hold spawns nothing", async () => {
    const l = fakeLauncher();
    const awake = new CaffeinateKeepAwake({ launch: l.launch, log: recordingLog(), pid: 4242 });
    await awake.hold();
    expect(l.spawned.map((s) => [s.cmd, ...s.args])).toEqual([["caffeinate", "-i", "-s", "-w", "4242"]]);
    await awake.hold();
    expect(l.spawned).toHaveLength(1);
  });

  it("release kills the child; a later hold spawns a new one", async () => {
    const l = fakeLauncher();
    const awake = new CaffeinateKeepAwake({ launch: l.launch, log: recordingLog(), pid: 1 });
    await awake.hold();
    await awake.release();
    expect(l.spawned[0]!.child.killed).toBe(1);
    await awake.release();
    expect(l.spawned[0]!.child.killed).toBe(1);
    await awake.hold();
    expect(l.spawned).toHaveLength(2);
  });

  it("release when not held is a no-op", async () => {
    const l = fakeLauncher();
    const log = recordingLog();
    const awake = new CaffeinateKeepAwake({ launch: l.launch, log, pid: 1 });
    await expect(awake.release()).resolves.toBeUndefined();
    expect(l.spawned).toHaveLength(0);
    expect(log.lines).toEqual([]);
  });

  it("a spawn that throws is logged as a warning and does not throw out of hold", async () => {
    const l = fakeLauncher({ throws: true });
    const log = recordingLog();
    const awake = new CaffeinateKeepAwake({ launch: l.launch, log, pid: 1 });
    await expect(awake.hold()).resolves.toBeUndefined();
    expect(log.lines).toEqual([expect.objectContaining({ level: "warn", msg: "keep-awake: caffeinate failed to start" })]);
    await expect(awake.release()).resolves.toBeUndefined();
  });

  it("an async error event is logged as a warning, and the next hold tries again", async () => {
    const l = fakeLauncher();
    const log = recordingLog();
    const awake = new CaffeinateKeepAwake({ launch: l.launch, log, pid: 1 });
    await awake.hold();
    l.spawned[0]!.child.emit("error", new Error("spawn caffeinate ENOENT"));
    expect(log.lines).toEqual([expect.objectContaining({ level: "warn", msg: "keep-awake: caffeinate failed to start" })]);
    await awake.release();
    expect(l.spawned[0]!.child.killed).toBe(0);
    await awake.hold();
    expect(l.spawned).toHaveLength(2);
  });

  it("a child that exits on its own is forgotten, so the next hold spawns again", async () => {
    const l = fakeLauncher();
    const awake = new CaffeinateKeepAwake({ launch: l.launch, log: recordingLog(), pid: 1 });
    await awake.hold();
    l.spawned[0]!.child.emit("exit");
    await awake.hold();
    expect(l.spawned).toHaveLength(2);
  });
});

describe("NoKeepAwake", () => {
  it("hold and release do nothing and never throw", async () => {
    const awake = new NoKeepAwake();
    await expect(awake.hold()).resolves.toBeUndefined();
    await expect(awake.release()).resolves.toBeUndefined();
    await expect(awake.release()).resolves.toBeUndefined();
  });
});

describe("requireExecutable", () => {
  const dirWith = (name?: string, mode = 0o755): string => {
    const dir = mkdtempSync(join(tmpdir(), "sf-awake-"));
    if (name) {
      writeFileSync(join(dir, name), "#!/bin/sh\n");
      chmodSync(join(dir, name), mode);
    }
    return dir;
  };

  it("finds an executable in any PATH entry", () => {
    expect(() => requireExecutable("caffeinate", [dirWith(), dirWith("caffeinate")].join(delimiter))).not.toThrow();
  });

  it("fails without one, or when the file is not executable, or with no PATH", () => {
    expect(() => requireExecutable("caffeinate", dirWith())).toThrow(/caffeinate/);
    expect(() => requireExecutable("caffeinate", dirWith("caffeinate", 0o644))).toThrow(/caffeinate/);
    expect(() => requireExecutable("caffeinate", undefined)).toThrow(/caffeinate/);
  });
});
