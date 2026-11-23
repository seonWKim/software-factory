import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261120T1000-controller-attachments.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { issue, newStore, system } from "./helpers/store.js";

// Attachments (design 02-attachments): `controller_attachments`, keyed by its ID and indexed by work item ID. Additive,
// no backfill (an item stored before has no attachment and no queued context), rerun-safe, and its timestamp is
// unique among every component's migrations.

const ID = "20261120T1000-controller-attachments";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

describe(`${ID} on an existing SQLite database`, () => {
  it("creates the table, keeps every row, backfills nothing and is safe to rerun", async () => {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system);
    const db = store.db;
    await db.run("DROP TABLE controller_attachments");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    const before = await db.all("SELECT * FROM controller_work_items");
    const changes = await db.all("SELECT * FROM controller_state_changes");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive", tables: ["controller_attachments"] });
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_work_items")).toEqual(before);
    expect(await db.all("SELECT * FROM controller_state_changes")).toEqual(changes);
    expect(await store.listAttachments(item.id)).toEqual([]);
    const cols = (await db.all("PRAGMA table_info(controller_attachments)")).map((r) => r.name);
    expect(cols).toEqual(["id", "work_item_id", "kind", "media_type", "data", "size_bytes", "name", "url", "label", "created_by", "created_at"]);
    expect((await db.all("PRAGMA index_list(controller_attachments)")).map((r) => r.name)).toContain("controller_attachments_item");
  });

  it("has a timestamp no other migration uses", () => {
    const src = join(import.meta.dirname, "..", "src");
    const stamps = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".migration.ts"))
      .map((f) => f.split("/").pop()!.slice(0, 13));
    expect(stamps.filter((s) => s === "20261120T1000")).toEqual(["20261120T1000"]);
  });
});
