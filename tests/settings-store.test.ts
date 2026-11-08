import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { INLINE_STEPS, MysqlMigrations, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import type { SqlDriver, SqlExecutor } from "../src/state/index.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { MYSQL_URL, mysqlStepsUpTo, newEmptyMysqlDatabase, newMysqlDatabase } from "./helpers/store.js";

/** A driver whose transactions fail on any statement that matches `fail`. Everything else is the real driver. */
function failing(inner: SqlDriver, fail: RegExp): SqlDriver {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
          target.transaction((tx) =>
            fn({
              all: (sql, params) => tx.all(sql, params),
              run: (sql, params) => (fail.test(sql) ? Promise.reject(new Error("audit insert failed")) : tx.run(sql, params)),
            }),
          );
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

describe("settings overrides: one transaction with the audit row", () => {
  it("if the audit insert fails, the override is unchanged (set and reset)", async () => {
    const driver = new SqliteDriver(":memory:");
    const clock = new FakeClock();
    const good = new SqlFactoryStore(driver, clock);
    await good.migrate();
    await good.setSettingOverride({ key: "workers", project: "", value: "2", actor: "local:owner" });
    const bad = new SqlFactoryStore(failing(driver, /INSERT INTO runtime_settings_changes/), clock);

    await expect(bad.setSettingOverride({ key: "workers", project: "", value: "3", actor: "local:owner" })).rejects.toThrow("audit insert failed");
    await expect(bad.setSettingOverride({ key: "tick_ms", project: "", value: "500", actor: "local:owner" })).rejects.toThrow("audit insert failed");
    await expect(bad.resetSettingOverride({ key: "workers", project: "", actor: "local:owner" })).rejects.toThrow("audit insert failed");

    expect((await good.listSettingOverrides()).map((o) => [o.key, o.value])).toEqual([["workers", "2"]]);
    expect(await good.listSettingChanges(10)).toHaveLength(1);
    await good.close();
  });
});

describe("migration step 17: settings tables", () => {
  it("is the repo's step after 0014, an inline .sql step that creates both tables", () => {
    const step = readSteps(STEPS_DIR, INLINE_STEPS).find((s) => s.name === "settings-overrides")!;
    expect(step).toMatchObject({ number: 17, from: 16, kind: "sql", file: "0017-settings-overrides.sql" });
    expect(step.sql).toContain("CREATE TABLE IF NOT EXISTS settings_overrides");
    expect(step.sql).toContain("CREATE TABLE IF NOT EXISTS settings_changes");
  });
});

describe.skipIf(!MYSQL_URL)("migration step 17 on MySQL", () => {
  it("pending before npm run migrate: --status lists it and the store refuses to start; after it, both tables exist", async () => {
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    // Every step before 17 applied, as on a database from before it.
    await new MysqlMigrations(c, { dir: mysqlStepsUpTo(16) }).apply(() => undefined);

    const status = await new MysqlMigrations(c).status();
    expect(status.pending[0]?.label).toBe("0017-settings-overrides.sql");
    const store = new SqlFactoryStore(new MysqlDriver(db.options), new FakeClock());
    db.onCleanup(() => store.close());
    await expect(store.migrate()).rejects.toThrow(/schema steps? pending \(state 16, latest \d+\): run `npm run migrate`/);

    await new MysqlMigrations(c).apply(() => undefined);
    const [tables] = await c.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'runtime\\_settings\\_%' ORDER BY 1",
    );
    expect((tables as { name: string }[]).map((t) => t.name)).toEqual(["runtime_settings_changes", "runtime_settings_overrides"]);
    await store.migrate();
    await store.setSettingOverride({ key: "workers", project: "", value: "2", actor: "local:owner" });
    expect(await store.listSettingChanges(5)).toHaveLength(1);
  });

  it("the audit insert failing leaves the override unchanged on MySQL too", async () => {
    const { store } = await newMysqlDatabase();
    await store.setSettingOverride({ key: "workers", project: "", value: "2", actor: "local:owner" });
    const inner = (store as unknown as { db: SqlDriver }).db;
    const bad = new SqlFactoryStore(failing(inner, /INSERT INTO runtime_settings_changes/), new FakeClock());
    await expect(bad.setSettingOverride({ key: "workers", project: "", value: "3", actor: "local:owner" })).rejects.toThrow("audit insert failed");
    expect((await store.listSettingOverrides()).map((o) => o.value)).toEqual(["2"]);
    expect(await store.listSettingChanges(10)).toHaveLength(1);
  });
});
