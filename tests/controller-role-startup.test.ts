import { describe, expect, it } from "vitest";
import { ControllerRole, checkDispatch } from "../src/runtime/roles/controller-role.js";
import { Registry } from "../src/runtime/registry/registry.js";
import { defineHandler } from "../src/shared/handler.js";
import { defineTopic } from "../src/shared/topic.js";
import { forgetOnFailure } from "../src/state/index.js";
import type { SqlDriver } from "../src/state/index.js";
import { FakeAuth, cleanScanner, config, silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// The controller role's startup checks and caches (runtime review L2, L3).

describe("a handler no role consumes", () => {
  it("fails the controller role's dispatch check, naming the handler, its file and the consumed components", () => {
    const topic = { file: "worker/topics/x.topic.ts", descriptor: defineTopic({ name: "x.events", owner: "worker", messages: { Happened: "event" }, consumption: "partitioned", retentionDays: 1 }) };
    const handler = (component: string) => ({ file: `${component}/handlers/h/h.handler.ts`, descriptor: defineHandler({ name: "h", accepts: ["Happened"], handle: async () => {} }) });
    expect(() => checkDispatch(new Registry([handler("worker")], [topic]))).toThrow(
      "handler h (worker/handlers/h/h.handler.ts) is in worker, which no role consumes (inbound, controller, outbound)",
    );
    for (const component of ["inbound", "controller", "outbound"]) {
      const ok = new Registry([handler(component)], [topic]);
      expect(checkDispatch(ok)).toBe(ok);
    }
  });
});

describe("a failed build or discovery", () => {
  it("is not cached: the next call tries again", async () => {
    let cached: Promise<number> | null = null;
    let calls = 0;
    const load = () => (cached ??= forgetOnFailure((calls++ === 0 ? Promise.reject(new Error("transient")) : Promise.resolve(7)), () => (cached = null)));
    await expect(load()).rejects.toThrow("transient");
    await expect(load()).resolves.toBe(7);
    expect(calls).toBe(2);
  });

  it("the controller role builds its wiring again after a transient store error", async () => {
    const { store, clock } = await newStore();
    const db = (store as unknown as { db: SqlDriver }).db;
    const all = db.all.bind(db);
    let failures = 1;
    db.all = async (sql, params) => {
      if (failures > 0 && sql.includes("bus_topics")) {
        failures--;
        throw new Error("connection lost");
      }
      return all(sql, params);
    };
    const c = new ControllerRole({ store, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    await expect(c.tickOutbox()).rejects.toThrow("connection lost");
    await expect(c.tickOutbox()).resolves.toBeUndefined();
  });
});
