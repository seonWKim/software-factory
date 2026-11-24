// Schedules over HTTP (design 08-schedules): GET /api/v1/schedules and /api/v1/schedules/runs, and POST
// /api/v1/schedules/add, /edit, /pause, /resume and /run, through the request shell (server.ts respond), do what the
// CLI does through the same core functions. A bad body is a 400 before any store call; anyone but the owner a 403; a
// refusal of the core a 409 with its reason.

import { describe, expect, it } from "vitest";
import { runDueSchedules } from "../src/core/schedule.js";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { PauseDeps, UiPauses } from "../src/ui/pause-api.js";
import { type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { POST_ONLY } from "../src/ui/write-routes.js";
import { silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

const OWNER = "local:owner@example.com" as UserId;
const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const HOUR = 3_600_000;
const FIRST = "2026-11-23T00:00:00.000Z";
const ADD = { id: "sch_fb", title: "Feedback", cadence: "daily", spec: "09:00", zone: "Asia/Seoul", action: "build" };

async function setup(principal: UserId = OWNER, llm?: LLMProvider | null) {
  const clock = new FakeClock("2026-11-22T12:00:00.000Z");
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
  const d: PauseDeps = { store: watched, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses, ...(llm !== undefined ? { llm } : {}) };
  const send = async (verb: string, body: unknown, over: Partial<UiRequest> = {}) => {
    const r = await respond(d, {
      method: "POST", url: `/api/v1/schedules/${verb}`, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: pauses.csrfToken, body: JSON.stringify(body), ...over,
    });
    return { status: r.status, value: JSON.parse(r.body) };
  };
  const get = async (url: string) => {
    const r = await respond(d, { method: "GET", url, host: HOST });
    return { status: r.status, value: JSON.parse(r.body) };
  };
  return { clock, store, calls, send, get };
}

describe("GET /api/v1/schedules and /api/v1/schedules/runs", () => {
  it("lists the schedules, and one schedule's runs; runs needs ?schedule and a known ID", async () => {
    const { clock, store, send, get } = await setup();
    expect(await get("/api/v1/schedules")).toEqual({ status: 200, value: { schedules: [] } });
    await send("add", ADD);
    expect((await get("/api/v1/schedules")).value.schedules).toMatchObject([{ id: "sch_fb", next_due_at: FIRST, created_by: OWNER }]);
    expect(await get("/api/v1/schedules/runs?schedule=sch_fb")).toEqual({ status: 200, value: { runs: [] } });
    clock.advance(12 * HOUR);
    await runDueSchedules(store, clock.now());
    expect((await get("/api/v1/schedules/runs?schedule=sch_fb")).value.runs).toMatchObject([{ occurrence_at: FIRST, outcome: "fired" }]);
    expect((await get("/api/v1/schedules/runs")).status).toBe(400);
    expect((await get("/api/v1/schedules/runs?schedule=nope")).status).toBe(404);
  });
});

describe("POST /api/v1/schedules/…", () => {
  it("add, edit, pause, resume and run store what the CLI stores, each answering the schedule", async () => {
    const { clock, store, send } = await setup();
    const added = await send("add", { ...ADD, body: "Look", skip_when_busy: true, token_cap: 900 });
    expect(added).toMatchObject({ status: 200, value: { schedule: { id: "sch_fb", created_by: OWNER, next_due_at: FIRST, action: { kind: "build", settings: { body: "Look" } }, skip_when_busy: true, token_cap: 900 } } });
    expect(await send("edit", { id: "sch_fb", zone: "UTC" })).toMatchObject({ status: 200, value: { schedule: { zone: "UTC", next_due_at: "2026-11-23T09:00:00.000Z" } } });
    expect(await send("pause", { id: "sch_fb" })).toMatchObject({ status: 200, value: { schedule: { next_due_at: null } } });
    clock.advance(HOUR);
    expect(await send("resume", { id: "sch_fb" })).toMatchObject({ status: 200, value: { schedule: { next_due_at: "2026-11-23T09:00:00.000Z" } } });
    expect(await send("run", { id: "sch_fb" })).toMatchObject({ status: 200, value: { schedule: { next_due_at: clock.now().toISOString() } } });
    expect((await runDueSchedules(store, clock.now())).fired).toHaveLength(1);
  });

  it("a refusal of the core is a 409 with its reason, and stores nothing", async () => {
    const { store, send } = await setup();
    await send("add", ADD);
    await send("pause", { id: "sch_fb" });
    const before = await store.listSchedules();
    for (const [verb, body, error] of [
      ["add", ADD, "schedule sch_fb is already stored"],
      ["add", { ...ADD, id: "x", zone: "Nowhere" }, '"Nowhere" is not a time zone'],
      ["add", { ...ADD, id: "x", action: "agent" }, "an agent action needs a body (--body): its prompt"],
      ["edit", { id: "sch_fb" }, "nothing to change: give at least one field"],
      ["edit", { id: "sch_fb", token_cap: 0 }, "the token cap must be a whole number of tokens of at least 1"],
      ["pause", { id: "sch_fb" }, "already paused"],
      ["run", { id: "sch_fb" }, "paused"],
      ["resume", { id: "nope" }, "no schedule nope"],
    ] as [string, unknown, string][]) {
      expect({ verb, body, r: await send(verb, body) }).toEqual({ verb, body, r: { status: 409, value: { error } } });
    }
    expect(await store.listSchedules()).toEqual(before);
  });

  it("a body that is not an object, or has an unknown, missing or wrongly typed field, is a 400 before any store call", async () => {
    const { calls, send } = await setup();
    for (const [verb, body] of [
      ["add", null], ["add", [ADD]], ["add", "sch_fb"], ["add", { ...ADD, id: undefined }], ["add", { ...ADD, id: 7 }], ["add", { ...ADD, title: 3 }],
      ["add", { ...ADD, skip_when_busy: "on" }], ["add", { ...ADD, token_cap: "100" }], ["add", { ...ADD, owner: OWNER }],
      ["edit", { id: "sch_fb", cadence: ["daily"] }], ["pause", { id: "sch_fb", title: "x" }], ["run", {}], ["resume", { id: " " }],
    ] as [string, unknown][]) {
      const r = await send(verb, body);
      expect({ verb, body, status: r.status }).toEqual({ verb, body, status: 400 });
    }
    expect(calls).toEqual([]);
  });

  it("is the owner's only: anyone else gets a 403 and nothing is stored", async () => {
    const { store, send } = await setup("local:guest@example.com" as UserId);
    for (const verb of ["add", "edit", "pause", "resume", "run"]) {
      const r = await send(verb, verb === "add" ? ADD : { id: "sch_fb", ...(verb === "edit" ? { title: "x" } : {}) });
      expect({ verb, r }).toMatchObject({ verb, r: { status: 403, value: { error: expect.stringContaining("Only the owner manages schedules") } } });
    }
    expect(await store.listSchedules()).toEqual([]);
  });

  it("passes the write guards first: a missing CSRF token is refused, and POST_ONLY names the schedule routes", async () => {
    const { store, send } = await setup();
    expect((await send("add", ADD, { csrfToken: "wrong" })).status).toBe(403);
    expect(await store.listSchedules()).toEqual([]);
    expect(POST_ONLY).toContain("schedule");
    expect((await send("remove", { id: "sch_fb" })).status).toBe(405);
  });

  it("delete goes through the same guards: a wrong CSRF token or anyone but the owner is refused and the schedule stays", async () => {
    const { store, send } = await setup();
    await send("add", ADD);
    expect((await send("delete", { id: "sch_fb" }, { csrfToken: "wrong" })).status).toBe(403);
    expect((await send("delete", { id: "sch_fb", title: "x" })).status).toBe(400);
    expect((await store.listSchedules()).map((s) => s.id)).toEqual(["sch_fb"]);
    const guest = await setup("local:guest@example.com" as UserId);
    await guest.store.addSchedule({ id: "sch_fb", title: "F", cadence: { kind: "daily", spec: "09:00" }, zone: "UTC", created_by: OWNER, created_at: "2026-11-22T12:00:00.000Z" as never, next_due_at: FIRST as never });
    expect(await guest.send("delete", { id: "sch_fb" })).toMatchObject({ status: 403, value: { error: expect.stringContaining("Only the owner manages schedules") } });
    expect(await guest.store.listSchedules()).toHaveLength(1);
  });

  it("delete removes the schedule and answers it as it was; its runs stay readable; an unknown ID is a 404", async () => {
    const { clock, store, send, get } = await setup();
    await send("add", ADD);
    clock.advance(12 * HOUR);
    await runDueSchedules(store, clock.now());
    expect(await send("delete", { id: "sch_fb" })).toMatchObject({ status: 200, value: { schedule: { id: "sch_fb", title: "Feedback" } } });
    expect((await get("/api/v1/schedules")).value.schedules).toEqual([]);
    expect(await store.listScheduleRuns("sch_fb")).toMatchObject([{ occurrence_at: FIRST, outcome: "fired" }]);
    expect(await send("delete", { id: "sch_fb" })).toEqual({ status: 404, value: { error: "no schedule sch_fb" } });
  });
});

// POST /api/v1/schedules/draft and /improve (src/core/schedule-draft.ts): a fake model, never a live one.
const WORDS = "review the design of software-factory every day at 9am";
const DRAFTED = { title: "Design review", cadence: "daily", spec: "09:00", zone: "", action: "feedback", text: "Read design-system/ and file a task per gap." };

/** A fake model that answers every call with `answer` and records the calls. */
function fakeModel(answer: Record<string, unknown>): LLMProvider & { calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  return {
    calls,
    async complete(req): Promise<LLMResponse> {
      calls.push(req);
      return { text: JSON.stringify(answer), parsed: answer, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
    },
  };
}

describe("POST /api/v1/schedules/draft and /improve", () => {
  it("draft answers the proposal with 200 and stores nothing", async () => {
    const llm = fakeModel(DRAFTED);
    const { store, send } = await setup(OWNER, llm);
    const r = await send("draft", { words: WORDS });
    expect(r.status).toBe(200);
    expect(r.value.proposal).toMatchObject({ id: expect.stringMatching(/^sch_/), fields: { cadence: "daily", spec: "09:00", action: "feedback", body: DRAFTED.text } });
    expect(r.value.proposal.fields.body).toContain("design-system/");
    expect(await store.listSchedules()).toEqual([]);
  });

  it("improve answers the old and new text with 200 and stores nothing", async () => {
    const llm = fakeModel({ text: "Read design-system/ closely." });
    const { store, send } = await setup(OWNER, llm);
    await send("add", { ...ADD, body: "Look" });
    const before = await store.listSchedules();
    expect(await send("improve", { id: "sch_fb" })).toEqual({ status: 200, value: { proposal: { id: "sch_fb", old: "Look", new: "Read design-system/ closely." } } });
    expect(await store.listSchedules()).toEqual(before);
  });

  it("anyone but the owner gets a 403 before any model call", async () => {
    const llm = fakeModel(DRAFTED);
    const { send } = await setup("local:guest@example.com" as UserId, llm);
    for (const [verb, body] of [["draft", { words: WORDS }], ["improve", { id: "sch_fb" }]] as const) {
      expect({ verb, r: await send(verb, body) }).toMatchObject({ r: { status: 403, value: { error: expect.stringContaining("Only the owner manages schedules") } } });
    }
    expect(llm.calls).toEqual([]);
  });

  it("a bad body is a 400 and a wrong CSRF token a 403, before any model call; a GET is not served", async () => {
    const llm = fakeModel(DRAFTED);
    const { store, send } = await setup(OWNER, llm);
    for (const [verb, body] of [["draft", null], ["draft", {}], ["draft", { words: " " }], ["draft", { words: WORDS, id: "x" }], ["improve", { id: 3 }], ["improve", { words: WORDS }]] as [string, unknown][]) {
      expect({ verb, body, status: (await send(verb, body)).status }).toEqual({ verb, body, status: 400 });
    }
    expect((await send("draft", { words: WORDS }, { csrfToken: "wrong" })).status).toBe(403);
    expect([404, 405]).toContain((await send("draft", { words: WORDS }, { method: "GET" })).status);
    expect(llm.calls).toEqual([]);
    expect(await store.listSchedules()).toEqual([]);
  });

  it("with no model, or a refusal of the core, answers its reason and stores nothing", async () => {
    const off = await setup(OWNER, null);
    expect(await off.send("draft", { words: WORDS })).toMatchObject({ status: 503, value: { error: expect.stringContaining("no model is configured") } });
    const bad = await setup(OWNER, fakeModel({ ...DRAFTED, cadence: "hourly" }));
    expect(await bad.send("draft", { words: WORDS })).toMatchObject({ status: 409, value: { error: expect.stringContaining('"hourly" is not a cadence') } });
    expect(await bad.send("improve", { id: "nope" })).toEqual({ status: 409, value: { error: "no schedule nope" } });
    expect(await bad.store.listSchedules()).toEqual([]);
  });
});
