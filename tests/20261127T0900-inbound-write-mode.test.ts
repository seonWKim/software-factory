// Permission modes, phase 1 (design 08-permissions, 2026-11-27): the migration adds `write_origin` and `permission_mode`
// to `inbound_commands` as nullable TEXT columns, with no backfill; a rerun changes nothing. The store writes
// `write_origin` on an append and reads it back; `permission_mode` stays NULL until the gate phase writes it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import WRITE_MODE from "../src/inbound/migrations/20261127T0900-inbound-write-mode.migration.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { type MigrationDb, applyMigrations, discoverMigrations } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

const ID = "20261127T0900-inbound-write-mode";
const at = "2026-11-27T00:00:00.000Z";
const cols = (db: DatabaseSync) => (db.prepare("PRAGMA table_info(inbound_commands)").all() as { name: string; type: string; notnull: number }[]);

describe("migration 20261127T0900-inbound-write-mode", () => {
  it("is additive and names inbound_commands", () => {
    expect(WRITE_MODE).toMatchObject({ change: "additive", tables: ["inbound_commands"] });
  });

  it("adds both columns as nullable TEXT, keeps an older row with NULL in both, and a rerun changes nothing", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sf-write-mode-")), "factory.db");
    const driver = new SqliteDriver(path, { baselineOnly: true });
    await driver.migrate();
    const db: MigrationDb = { dialect: "sqlite", all: (sql, p) => driver.all(sql, p), run: (sql, p) => driver.run(sql, p) };
    const all = await discoverMigrations();
    expect(all.map((m) => m.id)).toContain(ID);
    await applyMigrations(db, { backupDir: null, now: () => at, migrations: all.filter((m) => m.id < ID) });
    expect(cols(new DatabaseSync(path)).map((c) => c.name)).not.toContain("write_origin");
    await driver.run(
      "INSERT INTO inbound_commands (id, origin, command_key, actor, command, args, created_at, mirror) VALUES ('cmd_old', 'cli', 'cli:old', 'local:owner', 'approve', '{}', ?, 0)",
      [at],
    );
    await applyMigrations(db, { backupDir: null, now: () => at, migrations: all.filter((m) => m.id === ID) });
    await WRITE_MODE.up(db);
    await driver.close();
    const sqlite = new DatabaseSync(path);
    const added = cols(sqlite).filter((c) => c.name === "write_origin" || c.name === "permission_mode");
    expect(added).toEqual([
      expect.objectContaining({ name: "write_origin", type: "TEXT", notnull: 0 }),
      expect.objectContaining({ name: "permission_mode", type: "TEXT", notnull: 0 }),
    ]);
    expect(sqlite.prepare("SELECT write_origin, permission_mode FROM inbound_commands WHERE id = 'cmd_old'").get()).toEqual({ write_origin: null, permission_mode: null });
  });
});

describe("a command row's write_origin", () => {
  it("is human_command or agent, stored on append and read back; absent when the append passes none", async () => {
    const { store } = await newStore();
    for (const write_origin of ["human_command", "agent"] as const) {
      const { command } = await store.appendCliCommand({ key: `cli:${write_origin}`, actor: "local:owner", command: "approve", args: {}, write_origin });
      expect(command.write_origin).toBe(write_origin);
    }
    const { command } = await store.appendCliCommand({ key: "cli:none", actor: "local:owner", command: "approve", args: {} });
    expect(command).not.toHaveProperty("write_origin");
  });
});
