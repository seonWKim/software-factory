import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261112T0900-controller-notices.migration.js";
import { Router, type ControllerUnits } from "../src/controller/index.js";
import { Kernel } from "../src/controller/units/kernel.js";
import notificationsUnit from "../src/controller/units/notifications/notifications.unit.js";
import type { ControllerDeps } from "../src/core/controller-deps.js";
import {
  FINISHED_CUTOVER, NOTICE_KINDS, type Notice, type NoticeSettings, SUMMARY_ITEM, WAIT_KINDS, type WaitKind, type WaitingItem, decideNotices, noticeKind,
  parseNoticeKinds, parseQuietHours, quietUntil,
} from "../src/core/notifications.js";
import { SETTABLE_DEFAULTS, parseSettable, resolveSettings } from "../src/core/settings.js";
import type { StateChange, StateChangeId, Timestamp, WorkItem, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SourceAdapter, SourceNotice } from "../src/interfaces/source-adapter.js";
import { recordAction } from "../src/outbound/index.js";
import { tickAt } from "../src/shared/ticks/tick-generator.js";
import { MIGRATIONS_TABLE } from "../src/state/index.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { cleanScanner, config, silent } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// Design 09-notifications: one notice per wait on the owner and per close (`finished`), quiet hours and their summary,
// kinds turned off, the backfill of items already waiting, the local GET route, and (design 12-notification-channels)
// one outbox intent per notice for each `notify_channels` adapter that has notifyOwner.

type Live = NoticeSettings & { notify_channels: string[] };
const ALL: Live = { notice_kinds: [...NOTICE_KINDS], quiet_hours: "", notify_channels: [] };
const MIGRATION_ID = "20261112T0900-controller-notices";

/** A local-time instant on 2026-11-12, so the quiet-hours tests hold in any time zone. */
const local = (h: number, m = 0, day = 12) => new Date(2026, 10, day, h, m);

/** The settings the unit reads (`live.values()`), changeable between passes. */
function liveSettings(s: Partial<Live> = {}) {
  const values = { ...ALL, ...s };
  return { values: () => values, set: (n: Partial<Live>) => Object.assign(values, n) };
}

/** A kernel and router over `store` with only the notifications unit: a fresh writer, as a new process or replica builds it. */
function writer(store: FactoryStore, clock: FakeClock, live = liveSettings(), sources: SourceAdapter[] = []) {
  const deps = { store, clock, config, scanner: cleanScanner, log: silent, auth: {}, settings: live, sources } as unknown as ControllerDeps;
  const none = async () => { throw new Error("notifications write no message"); };
  const record = (a: Parameters<typeof recordAction>[1], now: string) => recordAction((store as SqlFactoryStore).db, a, now);
  const k = new Kernel(deps, { record, announce: none, emit: none, actions: none, byKey: none }, { beforeMerge: none });
  const r = new Router([notificationsUnit] as unknown as ControllerUnits, k, {
    kinds: [], messages: [], guard: async (_w, fn) => fn(), reader: k.reader, commit: (d) => k.commit(d), now: () => tickAt("event", 1, clock.now().getTime()),
  });
  return { live, pass: () => r.step("notifications", tickAt("poll", 1, clock.now().getTime())) };
}

async function rows(store: SqlFactoryStore) {
  return store.db.all("SELECT work_item_id, wait_key, kind, held_until, delivered_at, count FROM controller_notices ORDER BY created_at, work_item_id");
}

async function block(store: FactoryStore, clock: FakeClock, it: WorkItem, blocked_on: WorkItem["blocked_on"], blocked_reason: string | null) {
  clock.advance(1000);
  const r = await store.transition({ id: it.id, expected_version: it.version, patch: { blocked_on, blocked_reason }, actor: system, reason: `test_${blocked_on}` });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

/** A wait as the decision sees it: the item, and the state change that set blocked_on human. */
function waiting(id: string, blocked_reason: string | null, change = `sc_${id}`): WaitingItem {
  const changes = [{ id: change as StateChangeId, changes: { blocked_on: { from: "none", to: "human" } } } as Pick<StateChange, "id" | "changes">];
  return { item: { id: id as WorkItemId, blocked_on: "human", blocked_reason }, changes };
}

const asNotices = (n: ReturnType<typeof decideNotices>): Notice[] => n.map((x) => ({ ...x, delivered_at: null }));

describe("one notice per wait (fake clock)", () => {
  it("an item whose blocked_on becomes human gets exactly one notice; a running item gets none", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-12T03:00:00.000Z"));
    const waits = (await store.createWorkItem(issue(1), system)).item;
    const runs = (await store.createWorkItem(issue(2), system)).item;
    await store.transition({ id: runs.id, expected_version: runs.version, patch: {}, actor: system, reason: "test_enqueue", enqueue: { kind: "triage", idempotency_key: "r" } });
    const blocked = await block(store, clock, waits, "human", "spec_pending");
    const w = writer(store, clock);
    await w.pass();
    await w.pass();
    const change = (await store.listStateChanges(waits.id)).find((c) => c.version === blocked.version)!;
    expect(await rows(store)).toEqual([{ work_item_id: waits.id, wait_key: change.id, kind: "spec", held_until: null, delivered_at: null, count: 1 }]);
  });

  it("the same item gets no second notice until it leaves needs-you and re-enters it", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-12T03:00:00.000Z"));
    let it = (await store.createWorkItem(issue(1), system)).item;
    const w = writer(store, clock);
    it = await block(store, clock, it, "human", "spec_pending");
    await w.pass();
    // Still waiting, another reason: the same wait.
    it = await block(store, clock, it, "human", "merge_pending");
    await w.pass();
    expect(await rows(store)).toHaveLength(1);
    it = await block(store, clock, it, "none", null);
    await w.pass();
    expect(await rows(store)).toHaveLength(1);
    await block(store, clock, it, "human", "merge_pending");
    await w.pass();
    const kinds = (await rows(store)).map((r) => r.kind);
    expect(kinds).toEqual(["spec", "merge"]);
  });

  it("after the SQLite store is closed and reopened, a repeated pass writes no notice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-notices-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "factory.db");
    const clock = new FakeClock("2026-11-12T03:00:00.000Z");
    const first = new SqlFactoryStore(new SqliteDriver(file), clock);
    await first.migrate();
    const it = (await first.createWorkItem(issue(1), system)).item;
    await block(first, clock, it, "human", "max_attempts");
    await writer(first, clock).pass();
    const before = await rows(first);
    expect(before).toHaveLength(1);
    await first.close();

    const again = new SqlFactoryStore(new SqliteDriver(file), clock);
    await again.migrate();
    clock.advance(60_000);
    await writer(again, clock).pass();
    expect(await rows(again)).toEqual(before);
    await again.close();
  });
});

/** Closes `it` with `close_reason`, one second on. */
async function close(store: FactoryStore, clock: FakeClock, it: WorkItem, close_reason: NonNullable<WorkItem["close_reason"]>) {
  clock.advance(1000);
  const r = await store.transition({ id: it.id, expected_version: it.version, patch: { stage: "CLOSED", close_reason }, actor: system, reason: `test_${close_reason}` });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

/** A source adapter for the fan-out: `notify` true gives it notifyOwner (recording its calls), false leaves it out. */
function adapter(type: string, notify: boolean): SourceAdapter & { calls: SourceNotice[][] } {
  const calls: SourceNotice[][] = [];
  const base = {
    type, intake: "poll" as const, calls, poll: async () => ({ events: [], next_cursor: "" }), postComment: async () => ({ url: null }),
    markSeen: async () => {}, setStatus: async () => {}, closeIssue: async () => {},
  };
  return notify ? { ...base, notifyOwner: async (n: readonly SourceNotice[]) => void calls.push([...n]) } : base;
}

async function intents(store: SqlFactoryStore) {
  const rows = await store.db.all("SELECT action, source_type, target, intent_key, args FROM outbound_actions ORDER BY seq");
  return rows.map((r) => ({ ...r, target: JSON.parse(String(r.target)), args: JSON.parse(String(r.args)) }));
}

describe("finished notices (fake clock)", () => {
  it("a close writes one finished notice keyed on its close state change; a second pass writes nothing more", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-12T03:00:00.000Z"));
    const open = (await store.createWorkItem({ ...issue(1), title: "Add dark mode" }, system)).item;
    const closed = await close(store, clock, open, "completed");
    const w = writer(store, clock);
    await w.pass();
    clock.advance(60_000);
    await w.pass();
    const change = (await store.listStateChanges(closed.id)).find((c) => c.version === closed.version)!;
    expect(await rows(store)).toEqual([{ work_item_id: closed.id, wait_key: change.id, kind: "finished", held_until: null, delivered_at: null, count: 1 }]);
  });

  it("a close before the cutover, or older than the 7-day lookback, writes no finished notice", async () => {
    const before = new FakeClock(new Date(Date.parse(FINISHED_CUTOVER) - 3_600_000));
    const early = await newStore(before);
    await close(early.store, before, (await early.store.createWorkItem(issue(1), system)).item, "completed");
    await writer(early.store, before).pass();
    expect(await rows(early.store)).toEqual([]);

    const clock = new FakeClock("2026-11-13T00:00:00.000Z");
    const { store } = await newStore(clock);
    await close(store, clock, (await store.createWorkItem(issue(2), system)).item, "rejected");
    clock.advance(8 * 86_400_000);
    await writer(store, clock).pass();
    expect(await rows(store)).toEqual([]);
  });

  it("finished turned off writes nothing for a close", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-12T03:00:00.000Z"));
    await close(store, clock, (await store.createWorkItem(issue(1), system)).item, "completed");
    await writer(store, clock, liveSettings({ notice_kinds: [...WAIT_KINDS] })).pass();
    expect(await rows(store)).toEqual([]);
  });

  it("quiet hours hold a finished notice as a needs-you one, and one summary covers both kinds", async () => {
    const clock = new FakeClock(local(23, 0));
    const { store } = await newStore(clock);
    const waits = (await store.createWorkItem(issue(1), system)).item;
    await block(store, clock, waits, "human", "spec_pending");
    await close(store, clock, (await store.createWorkItem(issue(2), system)).item, "completed");
    const slack = adapter("slack_thread", true);
    const w = writer(store, clock, liveSettings({ quiet_hours: "22:00-07:00", notify_channels: ["slack"] }), [slack]);
    await w.pass();
    expect((await store.listHeldNotices()).map((n) => n.kind).sort()).toEqual(["finished", "spec"]);
    expect(await store.listPendingNotices()).toEqual([]);
    expect(await intents(store)).toEqual([]);
    clock.advance(8 * 3_600_000);
    await w.pass();
    await w.pass();
    expect((await store.listPendingNotices()).map((n) => [n.work_item_id, n.kind, n.count])).toEqual([[SUMMARY_ITEM, "summary", 2]]);
    expect((await intents(store)).map((i) => [i.args.kind, i.args.count, i.args.work_item_id])).toEqual([["summary", 2, null]]);
  });
});

describe("notify_channels fan-out (fake adapters)", () => {
  async function scene(notify_channels: string[], sources: SourceAdapter[]) {
    const { store, clock } = await newStore(new FakeClock("2026-11-12T03:00:00.000Z"));
    const waits = (await store.createWorkItem({ ...issue(1), title: "Spec for search" }, system)).item;
    await block(store, clock, waits, "human", "spec_pending");
    const done = await close(store, clock, (await store.createWorkItem({ ...issue(2), title: "Add dark mode" }, system)).item, "completed");
    const w = writer(store, clock, liveSettings({ notify_channels }), sources);
    await w.pass();
    await w.pass();
    return { store, waits, done };
  }

  it("with notify_channels [] no outbox row is written for any notice", async () => {
    const { store } = await scene([], [adapter("slack_thread", true)]);
    expect(await rows(store)).toHaveLength(2);
    expect(await intents(store)).toEqual([]);
  });

  it("each notice gets one row per listed channel whose adapter has notifyOwner; a listed adapter without it gets none", async () => {
    const { store, waits, done } = await scene(["slack", "plain"], [adapter("slack_thread", true), adapter("plain", false)]);
    const notices = await rows(store);
    const key = (id: string) => notices.find((n) => n.work_item_id === id)!.wait_key;
    expect(await intents(store)).toEqual([
      {
        action: "notify", source_type: "slack_thread", target: { type: "slack_thread", id: "notify", link: "" }, intent_key: `notify:${waits.id}:${key(waits.id)}:slack`,
        args: {
          kind: "needs_you", work_item_id: waits.id, title: "Spec for search", reason: "spec to approve", close_reason: null, source_type: "github_issue",
          thread_url: "https://github.com/o/r/issues/1", count: 1,
        },
      },
      {
        action: "notify", source_type: "slack_thread", target: { type: "slack_thread", id: "notify", link: "" }, intent_key: `notify:${done.id}:${key(done.id)}:slack`,
        args: {
          kind: "finished", work_item_id: done.id, title: "Add dark mode", reason: "merged", close_reason: "completed", source_type: "github_issue",
          thread_url: "https://github.com/o/r/issues/2", count: 1,
        },
      },
    ]);
  });

  it("a channel no configured adapter answers to gets no row", async () => {
    const { store } = await scene(["slack"], [adapter("plain", true)]);
    expect(await intents(store)).toEqual([]);
  });

  it("the close reason reads merged, rejected or dropped", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-12T03:00:00.000Z"));
    const reasons = ["completed", "rejected", "wont_do", "duplicate", "failed"] as const;
    for (const [n, reason] of reasons.entries()) await close(store, clock, (await store.createWorkItem(issue(n + 1), system)).item, reason);
    await writer(store, clock, liveSettings({ notify_channels: ["slack"] }), [adapter("slack_thread", true)]).pass();
    const by = Object.fromEntries((await intents(store)).map((i) => [i.args.close_reason, i.args.reason]));
    expect(by).toEqual({ completed: "merged", rejected: "rejected", wont_do: "dropped", duplicate: "dropped", failed: "dropped" });
  });
});

describe("the migration marks items already waiting as notified", () => {
  it("stores each waiting item's wait as delivered, so no notice follows; a later wait is noticed", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-12T03:00:00.000Z"));
    let a = (await store.createWorkItem(issue(1), system)).item;
    const b = (await store.createWorkItem(issue(2), system)).item;
    a = await block(store, clock, a, "human", "spec_pending");
    await store.db.run("DROP TABLE controller_notices");
    await store.db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [MIGRATION_ID]);
    await store.migrate();
    const change = (await store.listStateChanges(a.id)).find((c) => c.version === a.version)!;
    expect(await rows(store)).toEqual([{ work_item_id: a.id, wait_key: change.id, kind: "backfill", held_until: null, delivered_at: change.at, count: 1 }]);
    // A rerun writes nothing more.
    await migration.up({ dialect: "sqlite", all: (s, p) => store.db.all(s, p), run: (s, p) => store.db.run(s, p) });
    expect(await rows(store)).toHaveLength(1);

    const w = writer(store, clock);
    await w.pass();
    expect(await rows(store)).toHaveLength(1);
    expect(await store.listPendingNotices()).toEqual([]);
    await block(store, clock, b, "human", "merge_pending");
    await w.pass();
    expect((await store.listPendingNotices()).map((n) => [n.work_item_id, n.kind])).toEqual([[b.id, "merge"]]);
  });
});

describe("quiet hours (fake clock)", () => {
  it("parses HH:MM-HH:MM, empty as off, and refuses anything else", () => {
    expect(parseQuietHours("")).toBeNull();
    expect(parseQuietHours("22:00-07:30")).toEqual({ start: 22 * 60, end: 7 * 60 + 30 });
    for (const bad of ["22-07", "24:00-07:00", "07:00-07:00", 7, null]) expect(() => parseQuietHours(bad), String(bad)).toThrow(/quiet_hours/);
    expect(parseSettable("quiet_hours", "22:00-07:00")).toBe("22:00-07:00");
    expect(() => parseSettable("quiet_hours", "late")).toThrow(/quiet_hours/);
    expect(SETTABLE_DEFAULTS.quiet_hours).toBe("");
  });

  it("finds the end of the window now is in, across midnight and within one day", () => {
    expect(quietUntil("22:00-07:00", local(23, 15))).toEqual(local(7, 0, 13));
    expect(quietUntil("22:00-07:00", local(3, 0))).toEqual(local(7, 0));
    expect(quietUntil("22:00-07:00", local(7, 0))).toBeNull();
    expect(quietUntil("12:00-13:00", local(12, 30))).toEqual(local(13, 0));
    expect(quietUntil("12:00-13:00", local(13, 30))).toBeNull();
    expect(quietUntil("", local(3, 0))).toBeNull();
  });

  it("holds each notice in the window; when it ends, one summary covers the held notices", () => {
    const clock = new FakeClock(local(23, 0));
    const settings = { ...ALL, quiet_hours: "22:00-07:00" };
    const held = decideNotices({ waiting: [waiting("wi_a", "spec_pending"), waiting("wi_b", "merge_pending")], stored: [], now: clock.now(), settings });
    const end = local(7, 0, 13).toISOString();
    expect(held.map((n) => [n.work_item_id, n.held_until])).toEqual([["wi_a", end], ["wi_b", end]]);

    clock.advance(4 * 3_600_000); // 03:00, still quiet: no summary yet
    const stored = asNotices(held);
    expect(decideNotices({ waiting: [], stored, now: clock.now(), settings })).toEqual([]);
    clock.advance(4 * 3_600_000); // 07:00, the window ended
    const summary = decideNotices({ waiting: [waiting("wi_a", "spec_pending"), waiting("wi_b", "merge_pending")], stored, now: clock.now(), settings });
    expect(summary).toEqual([
      { work_item_id: SUMMARY_ITEM, wait_key: `quiet:${end}`, kind: "summary", created_at: clock.now().toISOString(), held_until: null, count: 2 },
    ]);
    clock.advance(60_000);
    expect(decideNotices({ waiting: [], stored: [...stored, ...asNotices(summary)], now: clock.now(), settings })).toEqual([]);
  });

  it("through the unit: a held notice is not pending, and the summary is once the window ends", async () => {
    const clock = new FakeClock(local(23, 0));
    const { store } = await newStore(clock);
    const it = (await store.createWorkItem(issue(1), system)).item;
    await block(store, clock, it, "human", "spec_pending");
    const w = writer(store, clock, liveSettings({ quiet_hours: "22:00-07:00" }));
    await w.pass();
    expect(await store.listHeldNotices()).toHaveLength(1);
    expect(await store.listPendingNotices()).toEqual([]);
    clock.advance(8 * 3_600_000);
    await w.pass();
    await w.pass();
    expect((await store.listPendingNotices()).map((n) => [n.work_item_id, n.kind, n.count])).toEqual([[SUMMARY_ITEM, "summary", 1]]);
  });
});

describe("notice kinds", () => {
  const reasons: Record<WaitKind, string> = { spec: "spec_pending", merge: "merge_pending", failure: "run_failed:implement:timeout", other: "needs_input" };

  it("classifies each blocked_reason, and parses the setting", () => {
    for (const [kind, reason] of Object.entries(reasons)) expect(noticeKind(reason)).toBe(kind);
    expect(noticeKind("max_attempts")).toBe("failure");
    expect(noticeKind(null)).toBe("other");
    expect(parseNoticeKinds(["merge", "spec"])).toEqual(["merge", "spec"]);
    for (const bad of [["spec", "spec"], ["summary"], "spec"]) expect(() => parseNoticeKinds(bad)).toThrow(/notice_kinds/);
    expect(SETTABLE_DEFAULTS.notice_kinds).toEqual([...NOTICE_KINDS]);
  });

  it("accepts finished, includes it by default, and a stored override keeps its own list", () => {
    expect(parseNoticeKinds(["finished", "spec"])).toEqual(["finished", "spec"]);
    expect(SETTABLE_DEFAULTS.notice_kinds).toContain("finished");
    const r = resolveSettings({ file: {}, layers: config.settings }, [{ key: "notice_kinds", project: "", value: JSON.stringify(["spec", "merge"]) }]);
    expect(r.values.notice_kinds).toEqual(["spec", "merge"]);
  });

  for (const kind of WAIT_KINDS) {
    it(`${kind} turned off never produces a notice; the other kinds still do`, () => {
      const settings = { ...ALL, notice_kinds: WAIT_KINDS.filter((k) => k !== kind) };
      const items = WAIT_KINDS.map((k) => waiting(`wi_${k}`, reasons[k]));
      const now = new FakeClock("2026-11-12T03:00:00.000Z").now();
      expect(decideNotices({ waiting: items, stored: [], now, settings }).map((n) => n.kind)).toEqual(settings.notice_kinds);
      const quiet = { ...settings, quiet_hours: "00:00-23:59" };
      expect(decideNotices({ waiting: items, stored: [], now: local(12), settings: quiet }).some((n) => n.kind === kind)).toBe(false);
    });
  }

  it("through the unit: a kind turned off writes nothing while it is off", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-12T03:00:00.000Z"));
    const it = (await store.createWorkItem(issue(1), system)).item;
    await block(store, clock, it, "human", "merge_pending");
    const w = writer(store, clock, liveSettings({ notice_kinds: ["spec"] }));
    await w.pass();
    expect(await rows(store)).toEqual([]);
  });
});

describe("GET /api/v1/notices", () => {
  it("lists finished notices too (owner decision 2026-11-12: the shell shows them)", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-12T03:00:00.000Z"));
    const done = await close(store, clock, (await store.createWorkItem(issue(1), system)).item, "completed");
    await writer(store, clock).pass();
    const r = await respond({ store, clock } as unknown as ApiDeps, { method: "GET", url: "/api/v1/notices", host: "127.0.0.1" });
    const body = JSON.parse(r.body) as { notices: { work_item_id: string; kind: string }[] };
    expect(body.notices.map((n) => [n.work_item_id, n.kind])).toEqual([[done.id, "finished"]]);
  });

  it("returns the pending notices as JSON; other methods keep the existing 405", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-12T03:00:00.000Z"));
    const it = (await store.createWorkItem(issue(1), system)).item;
    await block(store, clock, it, "human", "spec_pending");
    await writer(store, clock).pass();
    const d = { store, clock } as unknown as ApiDeps;
    const r = await respond(d, { method: "GET", url: "/api/v1/notices", host: "127.0.0.1" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    const body = JSON.parse(r.body) as { notices: { work_item_id: string; kind: string; count: number }[] };
    expect(body.notices.map((n) => [n.work_item_id, n.kind, n.count])).toEqual([[it.id, "spec", 1]]);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const refused = await respond(d, { method, url: "/api/v1/notices", host: "127.0.0.1" });
      expect(refused.status, method).toBe(405);
      expect(refused.headers["content-type"], method).toMatch(/application\/json/);
    }
  });
});
