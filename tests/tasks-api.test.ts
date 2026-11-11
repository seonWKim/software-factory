// POST /api/v1/tasks (design 02-tasks and 09-desktop-app): the desktop quick-add box stores a plain task through the
// #606 quick-add parser and task store. Guarded like every write route (Host, Origin, Content-Type, CSRF token, body
// size, JSON), then the body; every refusal stores nothing. The caller chooses the task ID, so a retry stores one task.

import { describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { TASKS_PATH } from "../src/ui/tasks-api.js";
import { newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ORIGIN = `http://${HOST}`;
const ACTOR = "local:owner@example.com" as UserId;

async function setup(opts: { actor?: UserId | null; wired?: boolean } = {}) {
  const clock = new FakeClock(new Date("2026-11-12T09:00:00"));
  const { store } = await newStore(clock);
  const token = newCsrfToken();
  const d: ApiDeps = {
    store,
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: 300_000,
    health: new HealthMonitor(async () => [], clock),
    ...(opts.wired === false ? {} : { commands: { actor: opts.actor === undefined ? ACTOR : opts.actor, source: "environment" as const, token } }),
  };
  const post = (body: unknown, over: Partial<UiRequest> = {}) =>
    respond(d, {
      method: "POST",
      url: TASKS_PATH,
      host: HOST,
      origin: ORIGIN,
      contentType: "application/json",
      csrfToken: token,
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...over,
    });
  const tasks = () => store.listTasks(100);
  return { d, store, token, post, tasks };
}

const ID = "tk_0123456789abcdef";

describe("POST /api/v1/tasks", () => {
  it("stores one task with the parsed fields, created by the page's actor, and returns it", async () => {
    const s = await setup();
    const r = await s.post({ id: ID, words: "pay rent tomorrow 09:30 !1 #home every month" });
    expect(r.status).toBe(200);
    const stored = await s.tasks();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: ID, title: "pay rent", list: "home", priority: 1, due_date: "2026-11-13", due_time: "09:30", recurrence: "month", created_by: ACTOR, done_at: null,
    });
    expect(JSON.parse(r.body)).toMatchObject({ task: { id: ID, title: "pay rent", list: "home", priority: 1, due_date: "2026-11-13" } });
  });

  it("the same task ID sent twice stores one task", async () => {
    const s = await setup();
    const first = await s.post({ id: ID, words: "call the bank" });
    const again = await s.post({ id: ID, words: "call the bank" });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body).task).toEqual(JSON.parse(first.body).task);
    expect((await s.tasks()).map((t) => t.id)).toEqual([ID]);
  });

  it("refuses a request without the CSRF token, with a stale one, or with a foreign Origin, and stores nothing", async () => {
    const s = await setup();
    const body = { id: ID, words: "call the bank" };
    for (const over of [{ csrfToken: undefined }, { csrfToken: "stale" }, { origin: "https://evil.example" }, { origin: undefined }]) {
      const r = await s.post(body, over);
      expect(r.status, JSON.stringify(over)).toBe(403);
    }
    expect((await s.post(body, { contentType: "text/plain" })).status).toBe(415);
    expect((await s.post(body, { host: "evil.example" })).status).toBe(403);
    expect((await s.post(body, { bodyTooLarge: true })).status).toBe(413);
    expect(await s.tasks()).toEqual([]);
  });

  it("refuses a body that is not one task, or words the parser refuses, with the reason, and stores nothing", async () => {
    const s = await setup();
    const cases: [unknown, RegExp][] = [
      ["{", /JSON/],
      [[], /object/],
      [{ words: "x" }, /id/],
      [{ id: "bad id", words: "x" }, /id/],
      [{ id: ID }, /words/],
      [{ id: ID, words: "x", extra: 1 }, /unknown field "extra"/],
      [{ id: ID, words: "every fortnight call mum" }, /unknown recurrence/],
      [{ id: ID, words: "!1 #home" }, /title is empty/],
    ];
    for (const [body, reason] of cases) {
      const r = await s.post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(r.body).error).toMatch(reason);
    }
    expect(await s.tasks()).toEqual([]);
  });

  it("answers 503 with no actor and 405 when the commands route is not wired, storing nothing", async () => {
    const off = await setup({ actor: null });
    expect((await off.post({ id: ID, words: "x" })).status).toBe(503);
    expect(await off.tasks()).toEqual([]);
    const unwired = await setup({ wired: false });
    expect((await unwired.post({ id: ID, words: "x" })).status).toBe(405);
    expect(await unwired.tasks()).toEqual([]);
  });
});
