import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { INLINE_STEPS, MysqlMigrations, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { MYSQL_URL, issue, mysqlStepsUpTo, newEmptyMysqlDatabase, system } from "./helpers/store.js";

// Interactive sessions (design §5, 2026-11-01, issue #112): the run's actor, transcript and token columns.
describe("migration step 18: run session columns", () => {
  it("is the repo's step after 17 on MySQL, and SQLite migration 18, adding the same three columns", () => {
    const step = readSteps(STEPS_DIR, INLINE_STEPS).find((s) => s.name === "run-session")!;
    expect(step).toMatchObject({ number: 18, from: 17, kind: "sql", file: "0018-run-session.sql" });
    for (const sql of [readFileSync(join(STEPS_DIR, step.file), "utf8"), MIGRATIONS[17]!]) {
      for (const col of ["actor_id", "transcript_url", "session_tokens"]) expect(sql).toContain(col);
    }
  });
});

describe.skipIf(!MYSQL_URL)("migration step 18 on MySQL", () => {
  it("a run written before it reads the three fields as null after npm run migrate", async () => {
    const db = await newEmptyMysqlDatabase();
    const c = await db.connect();
    // Every step before 18 applied, and a run written then, as on a database from before it.
    const dir = mysqlStepsUpTo(17);
    await new MysqlMigrations(c, { dir }).apply(() => undefined);
    const before = new SqlFactoryStore(new MysqlDriver({ ...db.options, stepsDir: dir }), new FakeClock());
    db.onCleanup(() => before.close());
    const { item } = await before.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
    const [run] = await before.listRuns(item.id);
    expect((await new MysqlMigrations(c).status()).pending[0]?.label).toBe("0018-run-session.sql");

    await new MysqlMigrations(c).apply(() => undefined);
    const store = new SqlFactoryStore(new MysqlDriver(db.options), new FakeClock());
    db.onCleanup(() => store.close());
    await store.migrate();
    expect(await store.getRun(run!.id)).toMatchObject({ actor_id: null, transcript_url: null, session_tokens: null });
  });
});
