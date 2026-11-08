import { describe, expect, it } from "vitest";
import merge, { FROM_APPS, FROM_COMMANDS } from "../src/inbound/migrations/20261108T2200-inbound-merge-commands.migration.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { Dialect, MigrationDb, SqlDriver } from "../src/state/index.js";
import { MYSQL_URL, newEmptyMysqlDatabase } from "./helpers/store.js";

// RFC 0015 M4, rule D7: command_inbox and app_command_requests (inbound_commands, inbound_app_requests since M1)
// become one inbound_commands. Every row and key survives, ids are deterministic, both old tables stay as legacy_*,
// and the store reads an app request recorded before the merge by its old seq.

const OLD: Record<Dialect, string[]> = {
  sqlite: [
    `CREATE TABLE inbound_commands (seq INTEGER PRIMARY KEY AUTOINCREMENT, command_key TEXT NOT NULL UNIQUE, actor TEXT NOT NULL,
      command TEXT NOT NULL, args TEXT NOT NULL, created_at TEXT NOT NULL, mirror INTEGER NOT NULL DEFAULT 0, mirrored_at TEXT)`,
    "CREATE INDEX inbound_commands_mirror ON inbound_commands (mirror, mirrored_at, seq)",
    `CREATE TABLE inbound_app_requests (seq INTEGER PRIMARY KEY AUTOINCREMENT, request_key TEXT NOT NULL UNIQUE, actor TEXT NOT NULL,
      command TEXT NOT NULL, args TEXT NOT NULL, created_at TEXT NOT NULL, handled_at TEXT, refusal TEXT)`,
  ],
  mysql: [
    `CREATE TABLE inbound_commands (seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, command_key VARCHAR(255) NOT NULL UNIQUE,
      actor VARCHAR(128) NOT NULL, command VARCHAR(64) NOT NULL, args MEDIUMTEXT NOT NULL, created_at CHAR(24) NOT NULL,
      mirror TINYINT NOT NULL DEFAULT 0, mirrored_at CHAR(24)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE inbound_app_requests (seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, request_key VARCHAR(255) NOT NULL UNIQUE,
      actor VARCHAR(128) NOT NULL, command VARCHAR(64) NOT NULL, args MEDIUMTEXT NOT NULL, created_at CHAR(24) NOT NULL,
      handled_at CHAR(24), refusal MEDIUMTEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  ],
};

const T = "2026-11-08T10:00:00.000Z";

async function seeded(dialect: Dialect, db: SqlDriver): Promise<MigrationDb> {
  const mdb: MigrationDb = { dialect, all: (s, p) => db.all(s, p), run: (s, p) => db.run(s, p) };
  for (const sql of OLD[dialect]) await db.run(sql);
  const cmd = "INSERT INTO inbound_commands (command_key, actor, command, args, created_at, mirror, mirrored_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
  await db.run(cmd, ["cli:a", "local:alice", "approve", JSON.stringify({ item: "wi_1" }), T, 1, null]);
  await db.run(cmd, ["github:77", "github:9", "revise", JSON.stringify({ text: "x" }), T, 0, null]);
  // Two app requests, recorded with a pointer row each (the shape before the merge).
  const app = "INSERT INTO inbound_app_requests (request_key, actor, command, args, created_at, handled_at, refusal) VALUES (?, ?, ?, ?, ?, ?, ?)";
  await db.run(app, ["app:u-1", "local:alice", "approve", JSON.stringify({ work_item_id: "wi_1" }), T, T, null]);
  await db.run(app, ["app:u-2", "local:alice", "merge", JSON.stringify({ work_item_id: "wi_2" }), T, null, null]);
  await db.run(cmd, ["app:1", "local:alice", "approve", JSON.stringify({ app_request: 1 }), T, 0, null]);
  await db.run(cmd, ["app:2", "local:alice", "merge", JSON.stringify({ app_request: 2 }), T, 0, null]);
  return mdb;
}

interface Backend {
  name: Dialect;
  open(): Promise<SqlDriver>;
}

const BACKENDS: Backend[] = [
  { name: "sqlite", open: async () => new SqliteDriver(":memory:") },
  ...(MYSQL_URL
    ? [
        {
          name: "mysql" as const,
          async open() {
            const db = await newEmptyMysqlDatabase();
            const d = new MysqlDriver(db.options);
            db.onCleanup(() => d.close());
            return d;
          },
        },
      ]
    : []),
];

describe.each(BACKENDS)("merge of the command inbox and app requests: $name", ({ name, open }) => {
  it("keeps every row and key, traces each to its source, and verifies", async () => {
    const db = await open();
    const mdb = await seeded(name, db);
    await merge.up(mdb);
    expect(await merge.verify!(mdb)).toEqual([]);
    const rows = await db.all("SELECT seq, id, origin, command_key, legacy_table, legacy_seq, handled_at FROM inbound_commands ORDER BY seq");
    expect(rows.map((r) => [Number(r.seq), r.id, r.origin, r.command_key, r.legacy_table, Number(r.legacy_seq)])).toEqual([
      [1, `cmd_${FROM_COMMANDS}_1`, "cli", "cli:a", FROM_COMMANDS, 1],
      [2, `cmd_${FROM_COMMANDS}_2`, "github", "github:77", FROM_COMMANDS, 2],
      [3, `cmd_${FROM_COMMANDS}_3`, "app", "app:1", FROM_COMMANDS, 3],
      [4, `cmd_${FROM_COMMANDS}_4`, "app", "app:2", FROM_COMMANDS, 4],
      // App requests above every command seq and every old request seq.
      [5, `cmd_${FROM_APPS}_1`, "app", "app:u-1", FROM_APPS, 1],
      [6, `cmd_${FROM_APPS}_2`, "app", "app:u-2", FROM_APPS, 2],
    ]);
    expect((await db.all("SELECT COUNT(*) AS n FROM legacy_inbound_commands"))[0]!.n).toEqual(4);
    expect((await db.all("SELECT COUNT(*) AS n FROM legacy_inbound_app_requests"))[0]!.n).toEqual(2);
    // A rerun changes nothing.
    await merge.up(mdb);
    expect(await db.all("SELECT COUNT(*) AS n FROM inbound_commands")).toEqual([{ n: 6 }]);
  });

  it("stops before copying when a request key is also a command key", async () => {
    const db = await open();
    const mdb = await seeded(name, db);
    await db.run("INSERT INTO inbound_app_requests (request_key, actor, command, args, created_at) VALUES ('cli:a', 'x', 'approve', '{}', ?)", [T]);
    await expect(merge.up(mdb)).rejects.toThrow(/key cli:a is in both/);
    expect(await db.all("SELECT COUNT(*) AS n FROM inbound_app_requests")).toEqual([{ n: 3 }]);
  });
});

describe("the store after the merge", () => {
  it("reads and marks a request recorded before the merge by its old seq, and a new one by its own", async () => {
    const driver = new SqliteDriver(":memory:");
    const store = new SqlFactoryStore(driver, new FakeClock(T));
    await store.migrate();
    const { request } = await store.recordAppCommandRequest({ key: "app:new", actor: "local:alice" as never, command: "approve", args: { work_item_id: "wi_3" } });
    const [row] = await driver.all("SELECT id, origin FROM inbound_commands WHERE command_key = 'app:new'");
    expect(row).toMatchObject({ origin: "app" });
    expect(await store.getAppCommandRequest(request.seq)).toMatchObject({ key: "app:new", handled_at: null });
    expect(await store.getAppCommandRequest("app:new")).toMatchObject({ seq: request.seq });
    expect(await store.markAppCommandRequest(request.seq, "no")).toBe(true);
    expect(await store.getAppCommandRequest(request.seq)).toMatchObject({ refusal: "no" });
    // A migrated request keeps its old seq.
    await driver.run(
      `INSERT INTO inbound_commands (seq, id, origin, command_key, actor, command, args, created_at, legacy_table, legacy_seq)
       VALUES (100, 'cmd_${FROM_APPS}_7', 'app', 'app:old', 'local:alice', 'approve', '{"work_item_id":"wi_1"}', ?, '${FROM_APPS}', 7)`,
      [T],
    );
    expect(await store.getAppCommandRequest(7)).toMatchObject({ seq: 7, key: "app:old" });
    expect(await store.getAppCommandRequest(100)).toBeNull();
    expect((await store.listCliCommandsAfter(0, 10)).map((c) => [c.origin, c.key])).toEqual([["app", "app:new"], ["app", "app:old"]]);
  });
});
