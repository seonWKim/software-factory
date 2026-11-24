// Routines over HTTP (src/ui/routines-api.ts, design 08-routines): GET /api/v1/routines and
// /api/v1/routines/suggestions, and POST /api/v1/routines/add, /edit, /pause, /resume, /delete and /run, through the
// request shell (server.ts respond) and the route tables (read-routes.ts, write-routes.ts). A bad body is a 400
// before any store call; anyone but the owner a 403; a refusal of the core a 409 with its reason. Run now only moves
// next_due_at, and the kernel's existing due path fires it on the next tick.

import { describe, expect, it } from "vitest";
import { NO_NEXT_SLOT, carrierSource, queueRoutineRun } from "../src/core/routines.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { tickAt } from "../src/shared/ticks/tick-generator.js";
import { scheduledAction } from "../src/core/controller-deps.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { PauseDeps, UiPauses } from "../src/ui/pause-api.js";
import { type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { POST_ONLY } from "../src/ui/write-routes.js";
import { config, silent } from "./helpers/fakes/config.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { newStore } from "./helpers/store.js";

const OWNER = "local:owner@example.com" as UserId;
const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const NOW = "2026-11-23T10:00:00.000Z";
const FIRST = "2026-11-24T09:00:00.000Z";
const ADD = { id: "rt_1", name: "License", instruction: "Check the license.", schedule: { kind: "daily", spec: "09:00" }, zone: "UTC" };
const TRIGGER = { id: "rt_m", name: "Merged", instruction: "Read the merge.", schedule: null, trigger: "merge" };

async function setup(principal: UserId = OWNER) {
  const clock = new FakeClock(NOW);
  const { store } = await newStore(clock);
  await store.claimOwner(OWNER);
  /** Every store method the routes called, by name. */
  const calls: string[] = [];
  const watched = new Proxy(store, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      return typeof v === "function" ? (...a: unknown[]) => (calls.push(String(k)), (v as (...x: unknown[]) => unknown).apply(t, a)) : v;
    },
  }) as FactoryStore;
  const pauses: UiPauses = { principal: async () => principal, authorize: async () => ({ allow: true }), csrfToken: newCsrfToken(), log: silent };
  const d: PauseDeps = { store: watched, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses };
  const send = async (verb: string, body: unknown, over: Partial<UiRequest> = {}) => {
    const r = await respond(d, {
      method: "POST", url: `/api/v1/routines/${verb}`, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: pauses.csrfToken, body: JSON.stringify(body), ...over,
    });
    return { status: r.status, value: JSON.parse(r.body) };
  };
  const get = async (url: string) => {
    const r = await respond(d, { method: "GET", url, host: HOST });
    return { status: r.status, value: JSON.parse(r.body) };
  };
  return { clock, store, calls, send, get };
}

describe("GET /api/v1/routines and /api/v1/routines/suggestions", () => {
  it("lists every routine oldest first, and one routine's suggestions; suggestions needs ?routine and a known ID", async () => {
    const { clock, store, send, get } = await setup();
    expect(await get("/api/v1/routines")).toEqual({ status: 200, value: { routines: [] } });
    await send("add", { ...ADD, id: "rt_b" });
    clock.advance(60_000);
    await send("add", { ...ADD, id: "rt_a" });
    expect((await get("/api/v1/routines")).value.routines.map((r: { id: string }) => r.id)).toEqual(["rt_b", "rt_a"]);
    expect(await get("/api/v1/routines/suggestions?routine=rt_a")).toEqual({ status: 200, value: { suggestions: [] } });
    await store.addRoutineSuggestions("rt_a", "run_1", [{ fingerprint: "f1", text: "one" }, { fingerprint: "f2", text: "two" }]);
    await store.addRoutineSuggestions("rt_b", "run_2", [{ fingerprint: "f3", text: "other" }]);
    const listed = await get("/api/v1/routines/suggestions?routine=rt_a");
    expect(listed.status).toBe(200);
    expect(listed.value.suggestions.map((s: { text: string; state: string }) => [s.text, s.state])).toEqual([["one", "pending"], ["two", "pending"]]);
    expect((await get("/api/v1/routines/suggestions")).status).toBe(400);
    expect((await get("/api/v1/routines/suggestions?routine=")).status).toBe(400);
    expect((await get("/api/v1/routines/suggestions?routine=nope")).status).toBe(404);
  });
});

describe("POST /api/v1/routines/…", () => {
  it("add, edit, pause, resume, run and delete each answer the routine", async () => {
    const { clock, store, send } = await setup();
    expect(await send("add", { ...ADD, url: "https://example.com/", run_cap_usd: 0.5 })).toMatchObject({
      status: 200, value: { routine: { id: "rt_1", created_by: OWNER, next_due_at: FIRST, url: "https://example.com/", run_cap_usd: 0.5, daily_cap_usd: null, paused: false } },
    });
    expect(await send("edit", { id: "rt_1", name: "Licence" })).toMatchObject({ status: 200, value: { routine: { name: "Licence", next_due_at: FIRST } } });
    expect(await send("pause", { id: "rt_1" })).toMatchObject({ status: 200, value: { routine: { paused: true } } });
    clock.advance(24 * 3_600_000);
    expect(await send("resume", { id: "rt_1" })).toMatchObject({ status: 200, value: { routine: { paused: false, next_due_at: "2026-11-25T09:00:00.000Z" } } });
    expect(await send("run", { id: "rt_1" })).toMatchObject({ status: 200, value: { routine: { next_due_at: clock.now().toISOString() } } });
    expect(await store.getRoutine("rt_1")).toMatchObject({ name: "Licence", paused: false, next_due_at: clock.now().toISOString() });
    expect(await send("delete", { id: "rt_1" })).toMatchObject({ status: 200, value: { routine: { id: "rt_1" } } });
    expect(await store.listRoutines()).toEqual([]);
  });

  it("an edit of the cadence or zone moves an unpaused routine's slot to its first after now; a paused routine stays paused", async () => {
    const { store, send } = await setup();
    await send("add", ADD);
    expect(await send("edit", { id: "rt_1", zone: "Asia/Seoul" })).toMatchObject({ status: 200, value: { routine: { zone: "Asia/Seoul", next_due_at: "2026-11-24T00:00:00.000Z" } } });
    expect(await send("edit", { id: "rt_1", schedule: { kind: "daily", spec: "20:00" } })).toMatchObject({ status: 200, value: { routine: { next_due_at: "2026-11-23T11:00:00.000Z" } } });
    await send("pause", { id: "rt_1" });
    expect(await send("edit", { id: "rt_1", schedule: { kind: "daily", spec: "21:00" } })).toMatchObject({ status: 200, value: { routine: { paused: true, next_due_at: "2026-11-23T11:00:00.000Z" } } });
    expect(await store.getRoutine("rt_1")).toMatchObject({ paused: true, schedule: { kind: "daily", spec: "21:00" }, next_due_at: "2026-11-23T11:00:00.000Z" });
  });

  it("Run now on an active routine sets next_due_at to now, and the schedule pass fires it on the next tick", async () => {
    const { clock, store, send } = await setup();
    const controller = new ControllerRole({ store, sources: [new LocalSource(store)], auth: new FakeAuth(), clock, config, log: silent, scanner: new PatternEgressScanner(async () => []) , schedule_action: scheduledAction(store, { run: async (s, at) => void (await queueRoutineRun(store, config.project.key, s.id, at)) }, silent, config.project.key) });
    const tick = async () => {
      await (await controller.unit("schedule")).scheduleStep(tickAt("tick", 1, clock.now().getTime()));
    };
    await send("add", ADD);
    await tick();
    expect(await store.getWorkItemBySource("local", carrierSource("rt_1").id)).toBeNull();
    expect((await send("run", { id: "rt_1" })).status).toBe(200);
    expect(await store.getRoutine("rt_1")).toMatchObject({ next_due_at: NOW, last_run_at: null });
    await tick();
    const carrier = (await store.getWorkItemBySource("local", carrierSource("rt_1").id))!;
    expect((await store.listRuns(carrier.id)).filter((r) => r.kind === "routine")).toHaveLength(1);
    // afterSlot moved the regular slot on after the run.
    expect(await store.getRoutine("rt_1")).toMatchObject({ next_due_at: FIRST, last_run_at: NOW });
  });

  it("Run now on a paused routine is a 409 and writes nothing; on a trigger routine a 409: it has no next slot", async () => {
    const { store, send } = await setup();
    await send("add", ADD);
    await send("pause", { id: "rt_1" });
    const before = await store.getRoutine("rt_1");
    expect(await send("run", { id: "rt_1" })).toEqual({ status: 409, value: { error: "paused" } });
    expect(await store.getRoutine("rt_1")).toEqual(before);
    await send("add", TRIGGER);
    expect(await send("run", { id: "rt_m" })).toEqual({ status: 409, value: { error: NO_NEXT_SLOT } });
    expect(await store.getRoutine("rt_m")).toMatchObject({ next_due_at: null, last_run_at: null });
  });

  it("a refusal of the core is a 409 with its reason, and stores nothing", async () => {
    const { store, send } = await setup();
    await send("add", ADD);
    await send("add", TRIGGER);
    const before = await store.listRoutines();
    for (const [verb, body, error] of [
      ["add", { ...ADD, name: "Other" }, "routine rt_1 is already stored"],
      ["add", { ...ADD, id: "x", zone: "Nowhere" }, '"Nowhere" is not a time zone'],
      ["add", { ...ADD, id: "x", trigger: "merge" }, "a routine runs on a schedule or on a trigger, not both"],
      ["edit", { id: "rt_1" }, "nothing to change: give at least one field"],
      ["edit", { id: "rt_1", trigger: "merge" }, "a routine runs on a schedule or on a trigger, not both"],
      ["edit", { id: "rt_1", name: " " }, "a routine needs a name"],
      ["edit", { id: "rt_1", daily_cap_usd: 0 }, "a cap is a positive dollar amount, or none"],
      ["resume", { id: "rt_1" }, "not paused"],
      ["edit", { id: "nope", name: "x" }, "no routine nope"],
      ["pause", { id: "nope" }, "no routine nope"],
      ["resume", { id: "nope" }, "no routine nope"],
      ["run", { id: "nope" }, "no routine nope"],
      ["delete", { id: "nope" }, "no routine nope"],
    ] as [string, unknown, string][]) {
      expect({ verb, body, r: await send(verb, body) }).toEqual({ verb, body, r: { status: 409, value: { error } } });
    }
    expect(await store.listRoutines()).toEqual(before);
    await send("pause", { id: "rt_1" });
    expect(await send("pause", { id: "rt_1" })).toEqual({ status: 409, value: { error: "already paused" } });
  });

  it("a body that is not an object, or has an unknown, missing or wrongly typed field, is a 400 before any store call", async () => {
    const { calls, send } = await setup();
    for (const [verb, body] of [
      ["add", null], ["add", [ADD]], ["add", "rt_1"], ["add", { ...ADD, id: undefined }], ["add", { ...ADD, id: 7 }], ["add", { ...ADD, name: 3 }],
      ["add", { ...ADD, schedule: "daily" }], ["add", { ...ADD, schedule: { kind: "daily" } }], ["add", { ...ADD, schedule: { kind: "daily", spec: "09:00", at: 1 } }],
      ["add", { ...ADD, run_cap_usd: "1" }], ["add", { ...ADD, url: 5 }], ["add", { ...ADD, owner: OWNER }], ["edit", { id: "rt_1", trigger: ["merge"] }],
      ["pause", { id: "rt_1", name: "x" }], ["resume", {}], ["delete", { id: " " }], ["run", { id: "rt_1", schedule: null }],
    ] as [string, unknown][]) {
      const r = await send(verb, body);
      expect({ verb, body, status: r.status }).toEqual({ verb, body, status: 400 });
    }
    expect(calls).toEqual([]);
  });

  it("is the owner's only: anyone else gets a 403 and nothing is stored", async () => {
    const { store, send } = await setup("local:guest@example.com" as UserId);
    for (const verb of ["add", "edit", "pause", "resume", "delete", "run"]) {
      const r = await send(verb, verb === "add" ? ADD : { id: "rt_1", ...(verb === "edit" ? { name: "x" } : {}) });
      expect({ verb, r }).toMatchObject({ verb, r: { status: 403, value: { error: expect.stringContaining("Only the owner manages routines") } } });
    }
    expect(await store.listRoutines()).toEqual([]);
  });

  it("is routed by the route tables after the write guards: a wrong CSRF token is refused, and POST_ONLY names the routine routes", async () => {
    const { store, send, get } = await setup();
    expect((await send("add", ADD, { csrfToken: "wrong" })).status).toBe(403);
    expect(await store.listRoutines()).toEqual([]);
    expect(POST_ONLY).toContain("routine");
    expect((await send("snooze", { id: "rt_1" })).status).toBe(405);
    expect((await get("/api/v1/routines")).status).toBe(200);
  });
});
