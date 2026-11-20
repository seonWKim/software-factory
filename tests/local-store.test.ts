import { describe, expect, it } from "vitest";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { NewWorkItem } from "../src/interfaces/factory-store.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// Local work items (issue #198, phase 1): the "local" source type, the messages the controller would post as
// comments, and the CLI command log. Types and tables only: nothing outside the store calls these yet.

/** The SQLite migration that add both tables. */
// Never pin a step as the newest (a length, `at(-1)` equal to it, or "pending alone"): a later migration would
// fail these checks from outside its allowed paths. Compare with `>=` or read MIGRATIONS.length.
const STEP = 21;
const COMMANDS_TABLE = "app_command_requests";

function localItem(n: number): NewWorkItem {
  return {
    source: { type: "local", id: `local-${n}`, link: `local:local-${n}` },
    requester_id: "local:owner" as UserId,
    project: PROJECT_KEY,
    problem: `problem ${n}`,
    resources: [],
  };
}

const BACKENDS = [{ name: "sqlite", make: newStore }];

for (const b of BACKENDS) {
  describe(`${b.name}: local work items`, () => {
    it('a work item with source type "local" is found by its source, same type and id', async () => {
      const { store } = await b.make();
      const { item } = await store.createWorkItem(localItem(1), system);
      const found = await store.getWorkItemBySource("local", "local-1");
      expect(found?.id).toBe(item.id);
      expect(found?.source).toMatchObject({ type: "local", id: "local-1" });
      expect(await store.getWorkItemBySource("github_issue", "local-1")).toBeNull();
    });
  });

  describe(`${b.name}: item messages`, () => {
    it("lists an item's messages oldest first, and only that item's", async () => {
      const { store, clock } = await b.make();
      const a = (await store.createWorkItem(localItem(1), system)).item;
      const other = (await store.createWorkItem(issue(2), system)).item;
      const first = await store.recordItemMessage({ work_item_id: a.id, marker: "m1", body: "first" });
      clock.advance(1000);
      await store.recordItemMessage({ work_item_id: other.id, marker: "m1", body: "elsewhere" });
      const second = await store.recordItemMessage({ work_item_id: a.id, marker: "m2", body: "second" });
      expect(first).toMatchObject({ created: true, message: { work_item_id: a.id, marker: "m1", body: "first" } });
      expect(second.created).toBe(true);
      expect(second.message.seq).toBeGreaterThan(first.message.seq);

      const listed = await store.listItemMessages(a.id);
      expect(listed.map((m) => m.body)).toEqual(["first", "second"]);
      expect(listed[0]).toEqual(first.message);
      expect((await store.listItemMessages(other.id)).map((m) => m.body)).toEqual(["elsewhere"]);
      expect(await store.listItemMessages("wi_none" as WorkItemId)).toEqual([]);
    });

    it("the same marker on the same item stores one message; the second call reports created: false", async () => {
      const { store } = await b.make();
      const a = (await store.createWorkItem(localItem(1), system)).item;
      const first = await store.recordItemMessage({ work_item_id: a.id, marker: "m1", body: "first" });
      const again = await store.recordItemMessage({ work_item_id: a.id, marker: "m1", body: "changed" });
      expect(again).toEqual({ created: false, message: first.message });
      expect(await store.listItemMessages(a.id)).toEqual([first.message]);
    });
  });

  describe(`${b.name}: CLI commands`, () => {
    it("append returns each command with an increasing sequence number", async () => {
      const { store } = await b.make();
      const one = await store.appendCliCommand({ key: "k1", actor: "local:owner", command: "approve", args: { item: "wi_1" } });
      const two = await store.appendCliCommand({ key: "k2", actor: "local:owner", command: "reject", args: {} });
      expect(one).toMatchObject({ created: true, command: { key: "k1", actor: "local:owner", command: "approve", args: { item: "wi_1" } } });
      expect(two.created).toBe(true);
      expect(two.command.seq).toBeGreaterThan(one.command.seq);
    });

    it("lists commands after a sequence number, in sequence order, at most limit", async () => {
      const { store } = await b.make();
      const seqs: number[] = [];
      for (let i = 1; i <= 4; i++) {
        seqs.push((await store.appendCliCommand({ key: `k${i}`, actor: "local:owner", command: "c", args: { i } })).command.seq);
      }
      expect((await store.listCliCommandsAfter(0, 10)).map((c) => c.key)).toEqual(["k1", "k2", "k3", "k4"]);
      expect((await store.listCliCommandsAfter(seqs[0]!, 2)).map((c) => c.key)).toEqual(["k2", "k3"]);
      expect((await store.listCliCommandsAfter(seqs[3]!, 10))).toEqual([]);
      const [c3] = await store.listCliCommandsAfter(seqs[1]!, 1);
      expect(c3).toMatchObject({ seq: seqs[2], key: "k3", command: "c", args: { i: 3 } });
    });

    it("appending twice with the same key stores one command", async () => {
      const { store } = await b.make();
      const first = await store.appendCliCommand({ key: "k1", actor: "local:owner", command: "approve", args: {} });
      const again = await store.appendCliCommand({ key: "k1", actor: "local:owner", command: "reject", args: { x: 1 } });
      expect(again).toEqual({ created: false, command: first.command });
      expect(await store.listCliCommandsAfter(0, 10)).toEqual([first.command]);
    });
  });
}

async function sqliteHasCommandsTable(driver: SqliteDriver): Promise<boolean> {
  const rows = await driver.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [COMMANDS_TABLE]);
  return rows.length === 1;
}

describe("SQLite migration 22: app command requests", () => {
  // Later migrations may follow; nothing here pins 22 as the newest (a new migration needs no edit here).
  it("a database recorded at version 21 reaches the latest after migrate() and has the table", async () => {
    const LATEST = MIGRATIONS.length;
    const driver = new SqliteDriver(":memory:", { baselineOnly: true });
    const store = new SqlFactoryStore(driver, new FakeClock());
    await driver.migrate();
    await driver.run(`DROP TABLE ${COMMANDS_TABLE}`);
    await driver.run("DELETE FROM schema_migrations WHERE version > ?", [STEP]);
    expect(await driver.schemaVersion()).toEqual({ applied: STEP, latest: LATEST });
    expect(await sqliteHasCommandsTable(driver)).toBe(false);

    await driver.migrate();
    expect(await driver.schemaVersion()).toEqual({ applied: LATEST, latest: LATEST });
    expect(await sqliteHasCommandsTable(driver)).toBe(true);
    await store.close();
  });
});
