import { describe, expect, it } from "vitest";
import type { UserId } from "../../src/core/types.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { MysqlDriver } from "../../src/impl/store/mysql/mysql-driver.js";
import { SqlFactoryStore } from "../../src/impl/store/sql/sql-factory-store.js";
import { commandsAfter } from "../../src/inbound/records.js";
import { pauseFirstTransaction } from "../helpers/paused-driver.js";
import { MYSQL_URL, newMigratedMysqlDatabase, newStore } from "../helpers/store.js";

// Inbound relays `inbound_commands` through a seq cursor (`seq > cursor`). MySQL assigns AUTO_INCREMENT at insert,
// not at commit, so every writer takes the `commands` lock row first and their inserts commit in seq order.

const command = (key: string) => ({ key, actor: "local:owner", command: "approve", args: {} });

describe("inbound_commands sequence", () => {
  it("every writer takes the commands lock row (SQLite: the row the migration seeds)", async () => {
    const { store } = await newStore();
    await store.appendCliCommand(command("k1"));
    await store.db.run("DELETE FROM inbound_sequence_locks");
    await expect(store.appendCliCommand(command("k2"))).rejects.toThrow("inbound_sequence_locks has no commands row");
    await expect(store.recordAppCommandRequest({ key: "app:1", actor: "local:u" as UserId, command: "approve", args: {} })).rejects.toThrow(
      "inbound_sequence_locks has no commands row",
    );
  });

  it.runIf(MYSQL_URL)("a cursor never passes a command whose transaction commits after a later one's (MySQL)", async () => {
    const db = await newMigratedMysqlDatabase();
    const clock = new FakeClock();
    const reader = new MysqlDriver(db.options);
    const slowDriver = new MysqlDriver(db.options);
    const fastDriver = new MysqlDriver(db.options);
    db.onCleanup(async () => {
      await Promise.all([reader.close(), slowDriver.close(), fastDriver.close()]);
    });
    // The first writer stops after its insert, before its commit.
    const paused = pauseFirstTransaction(slowDriver, /^INSERT INTO inbound_commands/);
    const slow = new SqlFactoryStore(paused.driver, clock);
    const fast = new SqlFactoryStore(fastDriver, clock);
    const first = slow.appendCliCommand(command("slow"));
    await paused.reached;
    // Unserialized, this insert takes the next seq and commits while the first is still open.
    const second = fast.recordAppCommandRequest({ key: "app:fast", actor: "local:u" as UserId, command: "approve", args: {} });
    await new Promise((r) => setTimeout(r, 300));
    let cursor = 0;
    const seen: string[] = [];
    const relay = async () => {
      for (const c of await commandsAfter(reader, cursor, 100)) {
        seen.push(c.key);
        cursor = c.seq;
      }
    };
    await relay();
    paused.release();
    await Promise.all([first, second]);
    await relay();
    expect(seen).toEqual(["slow", "app:fast"]);
  });
});
