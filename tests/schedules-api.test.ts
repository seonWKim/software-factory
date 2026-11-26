import { describe, expect, it } from "vitest";
import type { Timestamp, UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { readScheduleRuns } from "../src/ui/schedules-api.js";
import { newStore } from "./helpers/store.js";

// The schedules runs read over the real store (design 09-dashboard-schedules): each run carries `transcript`, the
// href of its claim's stored Activity ref when that ref is a run's transcript, else null.

const DUE = "2026-11-23T09:00:00.000Z" as Timestamp;

describe("GET /api/v1/schedules/runs transcript", () => {
  it("matches a run to its own claim's Activity row, and is null while the claim's ref is the run list", async () => {
    const { store } = await newStore(new FakeClock("2026-11-23T09:00:01.000Z"));
    await store.addSchedule({ id: "sch_1", title: "Daily", cadence: { kind: "daily", spec: "09:00" }, zone: "UTC", created_by: "local:owner" as UserId, created_at: "2026-11-22T12:00:00.000Z" as Timestamp, next_due_at: DUE });
    expect(await store.claimScheduleOccurrence({ schedule_id: "sch_1", occurrence_at: DUE, next_due_at: "2026-11-24T09:00:00.000Z" as Timestamp, outcome: "fired" })).not.toBeNull();
    const read = async () => ((await readScheduleRuns({ store }, "sch_1")).value as { runs: { transcript: string | null; recorded_at: string }[] }).runs;
    const [run] = await read();
    expect(run!.transcript).toBeNull();
    // The claim's row is the one with the schedule as subject at the run's recorded time: a transcript ref on it gives the link.
    const [claim] = await store.listActivity({ kind: "schedule_run" });
    expect(String(claim!.at)).toBe(run!.recorded_at);
    await store.db.run("UPDATE controller_activity SET ref = ? WHERE seq = ?", ["/api/v1/items/wi_1/runs/run_1/transcript", claim!.seq]);
    expect((await read())[0]!.transcript).toBe("/app/items/wi_1/runs/run_1");
  });
});
