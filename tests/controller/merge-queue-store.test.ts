import { describe, expect, it } from "vitest";
import { MergeQueueStore, queueId } from "../../src/controller/actors/merge-queue/merge-queue.store.js";
import type { SqlDriver } from "../../src/state/index.js";
import { BACKENDS } from "../helpers/store.js";

// The merge queue's snapshots (RFC 0015 M8) on SQLite and MySQL: one queue per project and base, entries in
// order, a replayed entry is the same entry, and every move is conditional on the state it leaves.

const entry = (n: number, item = `wi_${n}`) => ({
  entry_id: `mqe_${n}`, queue_id: queueId("p", "main"), work_item_id: item, entered_by: "local:me", merge_key: `k${n}`, detail: { n },
});

for (const backend of BACKENDS) {
  describe(`merge queue store (${backend.name})`, () => {
    const open = async () => {
      const { store } = await backend.make();
      return new MergeQueueStore((store as unknown as { db: SqlDriver }).db, () => "2026-11-09T00:00:00.000Z");
    };

    it("one idle queue per project and base", async () => {
      const q = await open();
      const a = await q.queue("p", "main");
      expect(a).toMatchObject({ queue_id: "mq:p:main", state: "idle", version: 1 });
      expect(await q.queue("p", "main")).toEqual(a);
      expect(await q.setQueue(a.queue_id, "idle", "checking")).toBe(true);
      // A second decision from the old state loses.
      expect(await q.setQueue(a.queue_id, "idle", "checking")).toBe(false);
      expect(await q.queue("p", "main")).toMatchObject({ state: "checking", version: 2 });
    });

    it("entries keep their order; a replay returns the same entry; a second live entry of an item is refused", async () => {
      const q = await open();
      await q.queue("p", "main");
      const first = await q.enter(entry(1));
      expect(first).toMatchObject({ created: true, entry: { state: "queued", detail: { n: 1 } } });
      expect(await q.enter(entry(1))).toMatchObject({ created: false, entry: { entry_id: "mqe_1" } });
      await q.enter(entry(2));
      expect(await q.enter({ ...entry(3), work_item_id: "wi_1" })).toMatchObject({ refused: { entry_id: "mqe_1" } });
      expect((await q.live(queueId("p", "main"))).map((e) => e.entry_id)).toEqual(["mqe_1", "mqe_2"]);

      expect(await q.move("mqe_1", "queued", "checking", { run_key: "run_1" })).toBe(true);
      expect(await q.move("mqe_1", "queued", "checking", { run_key: "run_2" })).toBe(false);
      expect(await q.byRun("run_1")).toMatchObject({ entry_id: "mqe_1", state: "checking", version: 2 });
      expect(await q.move("mqe_1", "checking", "removed", { reason: "red" })).toBe(true);
      expect((await q.live(queueId("p", "main"))).map((e) => e.entry_id)).toEqual(["mqe_2"]);
      // Removed, the item may enter again under a new id.
      expect(await q.enter({ ...entry(4), work_item_id: "wi_1" })).toMatchObject({ created: true });
      expect((await q.ofItem("wi_1")).map((e) => [e.entry_id, e.state, e.reason])).toEqual([["mqe_1", "removed", "red"], ["mqe_4", "queued", null]]);
    });
  });
}
