// The setup step that adds the Daily improve run schedule (design 07-self-improvement, 08-schedules): with
// `improver.daily_trigger` off it adds `improve-daily` once, warns when `plugins.schedule_action` is not routed, and
// adds nothing when the ID is stored or the flag is on. The summary step adds `summary-morning` and `summary-evening`
// (design 08-schedules-actions) through the same helper. A fake store; no model and no remote service.

import { describe, expect, it } from "vitest";
import { addImproveSchedule, addSummarySchedules, type ImproveScheduleDeps } from "../src/cli/handlers/setup/guided.js";
import { improverConfig } from "../src/core/proposals.js";
import type { NewSchedule, Schedule } from "../src/core/schedule.js";
import type { UserId } from "../src/core/types.js";

const ME = "local:owner" as UserId;

/** A fake schedule store: the setup step's reads and its insert. */
function fakeStore(o: { owner?: UserId | null; stored?: string[] } = {}) {
  const rows: Schedule[] = (o.stored ?? []).map((id) => ({ id } as Schedule));
  const store: ImproveScheduleDeps["store"] = {
    getOwner: async () => (o.owner === undefined ? ME : o.owner),
    listSchedules: async () => rows,
    addSchedule: async (s: NewSchedule) => {
      const row = { running_since: null, missed_rule: "catch_up", action: null, token_cap: null, ...s } as Schedule;
      rows.push(row);
      return row;
    },
  };
  return { store, rows };
}

function deps(over: Partial<ImproveScheduleDeps> & { daily_trigger?: boolean | undefined; schedule_action?: string } = {}) {
  const lines: string[] = [];
  const { daily_trigger, schedule_action, ...rest } = over;
  const d: ImproveScheduleDeps = {
    store: fakeStore().store,
    config: { improver: improverConfig(daily_trigger === undefined ? {} : { improver: { daily_trigger } }) },
    plugins: schedule_action === undefined ? {} : { schedule_action },
    zone: "Asia/Seoul",
    now: new Date("2026-11-22T12:00:00.000Z"),
    print: (l) => void lines.push(l),
    ...rest,
  };
  return { d, lines };
}

describe("setup: the Daily improve run schedule", () => {
  it("with the flag off adds improve-daily once: Daily improve run, action improve, daily 09:00 in the machine's zone, by the owner", async () => {
    const { store, rows } = fakeStore();
    const { d } = deps({ store, daily_trigger: false, schedule_action: "routed" });
    expect((await addImproveSchedule(d)).ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "improve-daily", title: "Daily improve run", action: { kind: "improve", settings: {} },
      cadence: { kind: "daily", spec: "09:00" }, zone: "Asia/Seoul", created_by: ME,
    });
    // Run again: the ID is stored, nothing more is added.
    const again = await addImproveSchedule(d);
    expect(again.ok).toBe(true);
    expect(again.line).toMatch(/already stored/);
    expect(rows.map((r) => r.id)).toEqual(["improve-daily"]);
  });

  it("adds nothing when the ID is stored already, or when the flag is on or unset", async () => {
    for (const daily_trigger of [true, undefined]) {
      const { store, rows } = fakeStore();
      expect((await addImproveSchedule(deps({ store, daily_trigger, schedule_action: "routed" }).d)).ok).toBe(true);
      expect(rows, String(daily_trigger)).toEqual([]);
    }
    const { store, rows } = fakeStore({ stored: ["improve-daily"] });
    await addImproveSchedule(deps({ store, daily_trigger: false, schedule_action: "routed" }).d);
    expect(rows.map((r) => r.id)).toEqual(["improve-daily"]);
  });

  it("with plugins.schedule_action not routed, warns naming it and still adds the schedule", async () => {
    const { store, rows } = fakeStore();
    const { d, lines } = deps({ store, daily_trigger: false });
    expect((await addImproveSchedule(d)).ok).toBe(true);
    expect(lines.join("\n")).toMatch(/plugins\.schedule_action/);
    expect(rows.map((r) => r.id)).toEqual(["improve-daily"]);
    // Routed: no warning.
    const routedRun = deps({ store: fakeStore().store, daily_trigger: false, schedule_action: "routed" });
    await addImproveSchedule(routedRun.d);
    expect(routedRun.lines).toEqual([]);
  });
});

describe("setup: the summary schedules", () => {
  it("adds summary-morning and summary-evening once each: action summary, every 15 minutes, the machine's zone, by the owner", async () => {
    const { store, rows } = fakeStore();
    const { d, lines } = deps({ store, schedule_action: "routed" });
    expect((await addSummarySchedules(d)).ok).toBe(true);
    const added = rows.filter((r) => r.id.startsWith("summary-"));
    expect(added.map((r) => r.id)).toEqual(["summary-morning", "summary-evening"]);
    for (const r of added) {
      expect(r).toMatchObject({ action: { kind: "summary", settings: {} }, cadence: { kind: "interval", spec: "15" }, zone: "Asia/Seoul", created_by: ME });
    }
    expect(lines).toEqual([]);
    // Run again: both IDs are stored, nothing more is added.
    const again = await addSummarySchedules(d);
    expect(again.ok).toBe(true);
    expect(again.line).toMatch(/already stored/);
    expect(rows.filter((r) => r.id.startsWith("summary-")).map((r) => r.id)).toEqual(["summary-morning", "summary-evening"]);
  });

  it("adds only the one that is missing, whatever improver.daily_trigger says", async () => {
    for (const daily_trigger of [true, false, undefined]) {
      const { store, rows } = fakeStore({ stored: ["summary-morning"] });
      expect((await addSummarySchedules(deps({ store, daily_trigger, schedule_action: "routed" }).d)).ok).toBe(true);
      expect(rows.map((r) => r.id), String(daily_trigger)).toEqual(["summary-morning", "summary-evening"]);
    }
  });

  it("with no owner adds nothing, and with plugins.schedule_action not routed warns and still adds", async () => {
    const none = fakeStore({ owner: null });
    expect((await addSummarySchedules(deps({ store: none.store, schedule_action: "routed" }).d)).ok).toBe(false);
    expect(none.rows).toEqual([]);
    const { store, rows } = fakeStore();
    const { d, lines } = deps({ store });
    expect((await addSummarySchedules(d)).ok).toBe(true);
    expect(lines.join("\n")).toMatch(/plugins\.schedule_action/);
    expect(rows.map((r) => r.id)).toEqual(["summary-morning", "summary-evening"]);
  });
});
