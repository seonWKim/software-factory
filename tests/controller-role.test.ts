// The controller role's `cleanup` tick (design 08-cleanup): each tick runs the close callback, and the daily sweep
// once per UTC day under this host's store lease and day mark. A real SQLite store; a fake cleanup.

import { describe, expect, it } from "vitest";
import { CLEANUP } from "../src/controller/units/cleanup/cleanup.unit.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

function fakeCleanup(enabled = true) {
  const calls: string[] = [];
  return {
    calls,
    port: { host: "h1", enabled: () => enabled, closeStep: async () => void calls.push("close"), sweep: async () => void calls.push("sweep") },
  };
}

describe("controller role: cleanup tick", () => {
  it("runs the close callback each tick and the sweep once a day, marking the day in this host's cursor", async () => {
    const { store, clock } = await newStore();
    const c = fakeCleanup();
    const role = new ControllerRole({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, cleanup: c.port });
    await role.tickCleanup();
    await role.tickCleanup();
    expect(c.calls.filter((x) => x === "close")).toEqual(["close", "close"]);
    expect(c.calls.filter((x) => x === "sweep")).toEqual(["sweep"]);
    expect(await store.getCursor(`${CLEANUP}:h1`)).toBe(clock.now().toISOString().slice(0, 10));
  });

  it("does nothing when cleanup is off, or when compose gave the role no cleanup", async () => {
    const { store, clock } = await newStore();
    const off = fakeCleanup(false);
    await new ControllerRole({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, cleanup: off.port }).tickCleanup();
    expect(off.calls).toEqual([]);
    expect(await store.getCursor(`${CLEANUP}:h1`)).toBeNull();
    await expect(new ControllerRole({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner }).tickCleanup()).resolves.toBeUndefined();
  });
});
