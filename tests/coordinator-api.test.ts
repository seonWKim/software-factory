// The Coordinator read (design 09-dashboard-system): the switch, the next check and the recent actions, newest first,
// each with the storage key of its transcript. The coordinator store's database is a fake: no model, no remote service.
import { describe, expect, it } from "vitest";
import { DECLARATIONS } from "../src/api/index.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { readCoordinator, transcriptKey } from "../src/ui/coordinator-api.js";
import { newStore } from "./helpers/store.js";

const row = (seq: number, link: string | null) => ({ cycle_id: "cyc_1", seq, work_item_id: seq === 1 ? "wi_1" : null, command: "merge", outcome: "requested", reason: "ok", transcript_link: link, recorded_at: `2026-11-27T09:0${seq}:00.000Z` });

describe("the coordinator.status read", () => {
  it("is declared as a read capability", () => {
    const c = DECLARATIONS.find((d) => d.id === "coordinator.status");
    expect(c).toMatchObject({ permission: "read", method: "GET", path: "/api/v1/coordinator" });
  });

  it("reads the switch, the due time and the actions, with the key of a stored transcript only", async () => {
    const { store, clock } = await newStore(new FakeClock("2026-11-27T09:10:00.000Z"));
    const db = {
      all: async (sql: string) => sql.includes("controller_coordinator_due") ? [{ due_at: "2026-11-27T09:15:00.000Z" }]
        : [row(2, null), row(1, "storage:transcripts/coordinator/cyc_1.json")],
    };
    const v = await readCoordinator({ store, clock }, db);
    expect(v).toMatchObject({ on: false, next_check_at: "2026-11-27T09:15:00.000Z" });
    expect(v.actions.map((a) => [a.seq, a.transcript])).toEqual([[2, null], [1, "transcripts/coordinator/cyc_1.json"]]);
  });

  it("reads a store before its first cycle: no due time, no actions", async () => {
    const { store, clock } = await newStore();
    expect(await readCoordinator({ store, clock })).toMatchObject({ next_check_at: null, actions: [] });
  });

  it("takes only the storage form of a transcript reference", () => {
    expect(transcriptKey("storage:a/b.json")).toBe("a/b.json");
    expect(transcriptKey("storage:")).toBeNull();
    expect(transcriptKey("log:x")).toBeNull();
    expect(transcriptKey(null)).toBeNull();
  });
});
