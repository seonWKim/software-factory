import { describe, expect, it } from "vitest";
import type { RunId } from "../src/core/types.js";
import setting, { testSlotCap } from "../src/worker/settings/test-slots.setting.js";
import { newStore } from "./helpers/store.js";

// Host test slots (phase 1 of 3 of local-28caa30d): one worker_test_slots row per full test run in progress on the
// host, its holder's run ID and lease expiry. A take runs under the claim lock, deletes expired rows, and inserts one
// only while the live count is below the cap; a release deletes the asking holder's row only.

const run = (n: number) => `run_${n}` as RunId;
const LEASE = 60_000;

async function rows(store: Awaited<ReturnType<typeof newStore>>["store"]): Promise<{ holder: string }[]> {
  return (await store.db.all("SELECT holder FROM worker_test_slots ORDER BY holder")) as { holder: string }[];
}

describe("test slots: take", () => {
  it("inserts one row with the holder and its lease expiry while the live count is below the cap", async () => {
    const { store, clock } = await newStore();
    expect(await store.takeTestSlot({ holder: run(1), cap: 2, lease_ms: LEASE })).toBe(true);
    const expires = new Date(clock.now().getTime() + LEASE).toISOString();
    expect(await store.db.all("SELECT holder, expires_at FROM worker_test_slots")).toEqual([{ holder: run(1), expires_at: expires }]);
    expect(await store.takeTestSlot({ holder: run(2), cap: 2, lease_ms: LEASE })).toBe(true);
    expect(await rows(store)).toEqual([{ holder: run(1) }, { holder: run(2) }]);
  });

  it("on a full host returns false and writes nothing; a take succeeds again after a release frees a slot", async () => {
    const { store } = await newStore();
    expect(await store.takeTestSlot({ holder: run(1), cap: 1, lease_ms: LEASE })).toBe(true);
    const before = await store.db.all("SELECT * FROM worker_test_slots");
    expect(await store.takeTestSlot({ holder: run(2), cap: 1, lease_ms: LEASE })).toBe(false);
    expect(await store.db.all("SELECT * FROM worker_test_slots")).toEqual(before);
    expect(await store.releaseTestSlot(run(1))).toBe(true);
    expect(await store.takeTestSlot({ holder: run(2), cap: 1, lease_ms: LEASE })).toBe(true);
    expect(await rows(store)).toEqual([{ holder: run(2) }]);
  });

  it("a holder that already holds a live slot takes no second one", async () => {
    const { store } = await newStore();
    expect(await store.takeTestSlot({ holder: run(1), cap: 2, lease_ms: LEASE })).toBe(true);
    expect(await store.takeTestSlot({ holder: run(1), cap: 2, lease_ms: LEASE })).toBe(true);
    expect(await rows(store)).toEqual([{ holder: run(1) }]);
  });

  it("a take by a holder of a live slot extends only that holder's own lease (the heartbeat renewal)", async () => {
    const { store, clock } = await newStore();
    expect(await store.takeTestSlot({ holder: run(1), cap: 2, lease_ms: LEASE })).toBe(true);
    expect(await store.takeTestSlot({ holder: run(2), cap: 2, lease_ms: LEASE })).toBe(true);
    const other = await store.db.all("SELECT expires_at FROM worker_test_slots WHERE holder = ?", [run(2)]);
    clock.advance(LEASE / 2);
    expect(await store.takeTestSlot({ holder: run(1), cap: 2, lease_ms: LEASE })).toBe(true);
    const renewed = new Date(clock.now().getTime() + LEASE).toISOString();
    expect(await store.db.all("SELECT expires_at FROM worker_test_slots WHERE holder = ?", [run(1)])).toEqual([{ expires_at: renewed }]);
    expect(await store.db.all("SELECT expires_at FROM worker_test_slots WHERE holder = ?", [run(2)])).toEqual(other);
    // Past the first lease, the renewed slot still counts against the cap; the other one has expired.
    clock.advance(LEASE / 2);
    expect(await store.takeTestSlot({ holder: run(3), cap: 1, lease_ms: LEASE })).toBe(false);
    expect(await rows(store)).toEqual([{ holder: run(1) }]);
  });

  it("runs under the claim lock: with no claim lock row to read, the take fails and writes nothing", async () => {
    const { store } = await newStore();
    await store.db.run("ALTER TABLE worker_claim_locks RENAME TO moved_claim_locks");
    await expect(store.takeTestSlot({ holder: run(1), cap: 2, lease_ms: LEASE })).rejects.toThrow(/worker_claim_locks/);
    expect(await rows(store)).toEqual([]);
  });

  it("deletes a slot whose lease has passed, so it no longer counts against the cap", async () => {
    const { store, clock } = await newStore();
    expect(await store.takeTestSlot({ holder: run(1), cap: 1, lease_ms: LEASE })).toBe(true);
    clock.advance(LEASE - 1);
    expect(await store.takeTestSlot({ holder: run(2), cap: 1, lease_ms: LEASE })).toBe(false);
    clock.advance(1);
    expect(await store.takeTestSlot({ holder: run(2), cap: 1, lease_ms: LEASE })).toBe(true);
    expect(await rows(store)).toEqual([{ holder: run(2) }]);
  });
});

describe("test slots: release", () => {
  it("deletes only the asking holder's slot; any other holder's release returns false and changes nothing", async () => {
    const { store } = await newStore();
    await store.takeTestSlot({ holder: run(1), cap: 3, lease_ms: LEASE });
    await store.takeTestSlot({ holder: run(2), cap: 3, lease_ms: LEASE });
    const before = await store.db.all("SELECT * FROM worker_test_slots ORDER BY holder");
    expect(await store.releaseTestSlot(run(3))).toBe(false);
    expect(await store.db.all("SELECT * FROM worker_test_slots ORDER BY holder")).toEqual(before);
    expect(await store.releaseTestSlot(run(1))).toBe(true);
    expect(await rows(store)).toEqual([{ holder: run(2) }]);
    expect(await store.releaseTestSlot(run(1))).toBe(false);
  });
});

describe("test_slots setting", () => {
  it("is a global runtime integer of the worker with no fixed default", () => {
    expect(setting).toMatchObject({ key: "test_slots", owner: "worker", type: "integer", changed_by: "runtime", scope: "global", default: null });
  });

  it("absent, the cap is max(1, floor(cpus / 4)) for the cpus passed in; a set value is used as given", () => {
    expect(testSlotCap(null, 16)).toBe(4);
    expect(testSlotCap(null, 10)).toBe(2);
    expect(testSlotCap(null, 4)).toBe(1);
    expect(testSlotCap(null, 3)).toBe(1);
    expect(testSlotCap(null, 1)).toBe(1);
    expect(testSlotCap(undefined, 8)).toBe(2);
    expect(testSlotCap(7, 16)).toBe(7);
    expect(testSlotCap(1, 64)).toBe(1);
  });
});
