// The owner's summary (design 08-schedules-actions): the summary action posts one fixed-wording summary per slot,
// built from the dashboard's store reads, scanned before it is posted, keyed on its slot. A real in-memory store; the
// owner's chat is a fake (wi_805e builds the real one) and no model is ever called. Times are the machine's zone.

import { describe, expect, it } from "vitest";
import type { ActionPorts, ActionSchedule, SummaryButton } from "../src/controller/units/schedule/plugins/ports.js";
import { nextSummaryAt, summaryAction, summaryKey } from "../src/controller/units/schedule/plugins/summary/summary-action.js";
import { addSchedule, runDueSchedules, writeSchedule } from "../src/core/schedule.js";
import { type SummaryReads, summaryDeps } from "../src/core/summary.js";
import { parseSettable } from "../src/core/settings.js";
import type { RunKind, UserId, WorkItemId, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { issue, system } from "./helpers/store.js";

const ME = "local:owner" as UserId;
const local = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m);
const TIMES = { summary_morning_time: "08:30", summary_evening_time: "22:00" };
/** The store reads the dashboard makes that a summary may use (src/ui/list.ts, needs-you.ts, graph.ts, schedules-api.ts, api.ts). */
const DASHBOARD_READS = ["listWorkItemsWhere", "listRunsFinishedSince", "getWorkItem", "listSchedules", "listScheduleRuns"];

async function newStore() {
  const clock = new FakeClock(local(25, 23).toISOString());
  const store = new SqlFactoryStore(new SqliteDriver(":memory:"), clock);
  await store.migrate();
  return { clock, store };
}

let n = 0;
async function item(store: FactoryStore, title: string, patch: Parameters<FactoryStore["transition"]>[0]["patch"], enqueue?: RunKind) {
  const i = ++n;
  const { item } = await store.createWorkItem({ ...issue(i), title, source: { type: "local", id: `local-${i}`, link: "" } }, system, enqueue ? { enqueue: { kind: enqueue, idempotency_key: `k${i}` } } : undefined);
  if (enqueue) {
    const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: [enqueue], lease_ms: 60_000 }))!;
    await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "checks_failed", detail: "failed", infra: false });
  }
  const now = (await store.getWorkItem(item.id))!;
  const r = await store.transition({ id: item.id, expected_version: now.version, actor: system, reason: "test_setup", patch });
  if (!r.ok) throw new Error(r.reason);
  return item.id as WorkItemId;
}

/** A day with a merge, a waiting spec, a failure waiting for /retry and a paused and a skipped schedule. */
async function seedDay(store: SqlFactoryStore) {
  const merged = await item(store, "Add the export button", { stage: "CLOSED", close_reason: "completed", merge_sha: "abc123", blocked_on: "none", blocked_reason: null });
  const spec = await item(store, "Rename the settings page", { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
  const failed = await item(store, "Fix the login redirect", { stage: "RUNNING", blocked_on: "human", blocked_reason: "run_failed:implement:checks_failed" }, "implement");
  await addSchedule(store, { id: "page", title: "Check the home page", cadence: { kind: "daily", spec: "09:00" }, zone: "UTC", created_by: ME, action: { kind: "build", settings: {} } }, local(25, 23));
  const page = (await store.listSchedules()).find((s) => s.id === "page")!;
  await store.updateSchedule("page", page.next_due_at, { paused: true }); // as a run over its run cap pauses it
  return { merged, spec, failed };
}

/** The owner's chat as a fake: one post per key, or down. */
function chat(down = false) {
  const posts = new Map<string, { text: string; buttons: readonly SummaryButton[] }>();
  return {
    posts,
    post: async (d: { key: string; text: string; buttons: readonly SummaryButton[] }) => {
      if (down) throw new Error("chat down");
      if (posts.has(d.key)) return { created: false };
      posts.set(d.key, { text: d.text, buttons: d.buttons });
      return { created: true };
    },
  };
}

/** The ports a route gets; `ask` (the model) fails the test if called. */
function ports() {
  const outputs: string[] = [];
  const p: ActionPorts = {
    occurrence_id: "schedule-summary",
    fileItem: async () => { throw new Error("a summary files no item"); },
    ask: async () => { throw new Error("a summary calls no model"); },
    record: async (r) => void outputs.push(r.output),
  };
  return { outputs, p };
}

/** `store` with each method a summary calls counted. */
function counted(store: SqlFactoryStore) {
  const calls = new Set<string>();
  const reads = new Proxy(store, { get: (t, k) => { const v = Reflect.get(t, k, t); if (typeof v !== "function") return v; calls.add(String(k)); return v.bind(t); } }) as unknown as SummaryReads;
  return { calls, reads };
}

const SCHEDULE: ActionSchedule = { id: "summary", title: "Owner summary", settings: {} };
const route = (store: SummaryReads, c: ReturnType<typeof chat>, scanner = new PatternEgressScanner(async () => []), times = () => TIMES) =>
  summaryAction(summaryDeps({ store, scanner, times, post: c.post }));

describe("the summary action", () => {
  it("a seeded day gives one summary listing the merges, each waiting decision with its button and the failures with their retries", async () => {
    const { store } = await newStore();
    const ids = await seedDay(store);
    const c = chat(), { outputs, p } = ports();
    await route(store, c)(SCHEDULE, local(26, 8, 30).toISOString(), p);
    expect([...c.posts.keys()]).toEqual([summaryKey({ name: "morning", date: "2026-11-26" })]);
    const { text, buttons } = c.posts.get("summary:2026-11-26:morning")!;
    expect(text).toContain(`Merged (1)\n- Add the export button (${ids.merged})`);
    expect(text).toContain(`Waiting for your decision (1)\n- Rename the settings page (${ids.spec}): /approve`);
    expect(text).toContain(`Failed (1)\n- Fix the login redirect (${ids.failed}): its implement run failed (attempt 1); it waits for /retry.`);
    expect(buttons).toEqual([
      { work_item_id: ids.spec, label: "/approve", command: "/approve" },
      { work_item_id: ids.failed, label: "/retry", command: "/retry" },
    ]);
    expect(outputs).toEqual([text]);
    await store.close();
  });

  it("an unusual item (a schedule paused by its run cap, a slot skipped or refused) is listed", async () => {
    const { store, clock } = await newStore();
    await seedDay(store);
    await addSchedule(store, { id: "busy", title: "Nightly build", cadence: { kind: "daily", spec: "01:00" }, zone: "UTC", created_by: ME, action: { kind: "build", settings: {} }, missed_rule: "skip" }, local(25, 23));
    const due = (await store.listSchedules()).find((s) => s.id === "busy")!.next_due_at!;
    clock.set(new Date(new Date(due).getTime() + 3_600_000).toISOString());
    await runDueSchedules(store, clock.now(), { tick_ms: 2_000 });
    const runs = await store.listScheduleRuns("busy");
    expect(runs.map((r) => r.outcome)).toEqual(["skipped"]);
    const c = chat();
    // The slot after the skip: its window holds the skipped run's row.
    await route(store, c)(SCHEDULE, nextSummaryAt(clock.now(), { morning: "08:30", evening: "22:00" }).at.toISOString(), ports().p);
    const text = [...c.posts.values()][0]!.text;
    expect(text).toContain('Schedule "Check the home page" is paused: a run went over its run cap.');
    expect(text).toMatch(/Schedule "Nightly build" skipped its \d\d:\d\d slot: the factory was busy\./);
    await store.close();
  });

  it("a day with nothing to report posts nothing", async () => {
    const { store } = await newStore();
    const c = chat(), { outputs, p } = ports();
    await route(store, c)(SCHEDULE, local(26, 8, 30).toISOString(), p);
    expect(c.posts.size).toBe(0);
    expect(outputs[0]).toMatch(/^nothing to report/);
    await store.close();
  });

  it("is built only from store reads the dashboard makes, in fixed wording, with no model call", async () => {
    const { store } = await newStore();
    await seedDay(store);
    const { calls, reads } = counted(store);
    const c1 = chat(), c2 = chat();
    await route(reads, c1)(SCHEDULE, local(26, 8, 30).toISOString(), ports().p);
    await route(reads, c2)(SCHEDULE, local(26, 8, 30).toISOString(), ports().p);
    expect(DASHBOARD_READS).toEqual(expect.arrayContaining([...calls]));
    expect([...c1.posts.values()][0]!.text).toBe([...c2.posts.values()][0]!.text);
    expect([...c1.posts.values()][0]!.text.split("\n")[0]).toMatch(/^The factory's morning summary, 22:00 to 08:30$/);
    await store.close();
  });

  it("every summary passes the egress scanner first: a finding posts nothing and stores nothing", async () => {
    const { store } = await newStore();
    await item(store, "Leak sk-SECRET-123 here", { stage: "CLOSED", close_reason: "completed", merge_sha: "s1", blocked_on: "none", blocked_reason: null });
    const c = chat(), { outputs, p } = ports();
    const scanner = new PatternEgressScanner(async () => ["sk-SECRET-123"]);
    await expect(route(store, c, scanner)(SCHEDULE, local(26, 8, 30).toISOString(), p)).rejects.toThrow(/leak scanner/);
    expect(c.posts.size).toBe(0);
    expect(outputs).toEqual([]);
    await store.close();
  });

  it("is keyed on its slot: a second run of the same slot posts nothing new", async () => {
    const { store } = await newStore();
    await seedDay(store);
    const c = chat(), { outputs, p } = ports();
    await route(store, c)(SCHEDULE, local(26, 8, 30).toISOString(), p);
    await route(store, c)(SCHEDULE, local(26, 9, 0).toISOString(), p);
    expect(c.posts.size).toBe(1);
    expect(outputs[1]).toMatch(/^already posted the morning summary of 2026-11-26/);
    await store.close();
  });

  it("with the chat channel down, the run still stores its summary and ends normally", async () => {
    const { store } = await newStore();
    await seedDay(store);
    const { outputs, p } = ports();
    await expect(route(store, chat(true))(SCHEDULE, local(26, 8, 30).toISOString(), p)).resolves.toBeUndefined();
    expect(outputs[0]).toContain("Merged (1)");
    expect(outputs[0]).toContain("not posted yet");
    await store.close();
  });

  it("changing the morning or evening time setting moves the next post to the new time", async () => {
    const now = local(26, 7, 0);
    expect(nextSummaryAt(now, { morning: "08:30", evening: "22:00" }).at).toEqual(local(26, 8, 30));
    expect(nextSummaryAt(now, { morning: "07:15", evening: "22:00" }).at).toEqual(local(26, 7, 15));
    expect(nextSummaryAt(local(26, 9, 0), { morning: "08:30", evening: "20:45" }).at).toEqual(local(26, 20, 45));
    // The route reads the settings on each run: a moved morning time makes 07:20 the morning slot's post.
    const { store } = await newStore();
    await seedDay(store);
    let times = TIMES;
    const c = chat();
    const r = route(store, c, undefined, () => times);
    times = { ...TIMES, summary_morning_time: "07:15" };
    await r(SCHEDULE, local(26, 7, 20).toISOString(), ports().p);
    expect([...c.posts.keys()]).toEqual(["summary:2026-11-26:morning"]);
    expect(c.posts.get("summary:2026-11-26:morning")!.text.split("\n")[0]).toBe("The factory's morning summary, 22:00 to 07:15");
    expect(parseSettable("summary_morning_time", "07:15")).toBe("07:15");
    expect(() => parseSettable("summary_evening_time", "25:00")).toThrow(/HH:MM/);
    await store.close();
  });
});

describe("schedule add and schedule edit refuse the summary kind", () => {
  const fields = { title: "t", cadence: "daily", spec: "09:00", zone: "UTC" };
  it("add refuses it, and edit refuses changing an action to it", async () => {
    const { store } = await newStore();
    const now = local(25, 23);
    expect(await writeSchedule(store, "add", "s-summary", { ...fields, action: "summary" }, ME, now)).toEqual({ ok: false, problem: expect.stringMatching(/summary.*setup/) });
    expect((await store.listSchedules()).map((s) => s.id)).not.toContain("s-summary");
    await writeSchedule(store, "add", "s-build", { ...fields, action: "build" }, ME, now);
    expect(await writeSchedule(store, "edit", "s-build", { action: "summary" }, ME, now)).toEqual({ ok: false, problem: expect.stringMatching(/summary.*setup/) });
    expect((await store.listSchedules()).find((s) => s.id === "s-build")!.action!.kind).toBe("build");
    await store.close();
  });
});
