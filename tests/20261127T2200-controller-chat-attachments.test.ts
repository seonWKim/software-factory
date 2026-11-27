import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import migration from "../src/controller/migrations/20261127T2200-controller-chat-attachments.migration.js";
import type { UserId } from "../src/core/types.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { issue, newStore, system } from "./helpers/store.js";

// Chat images (design 04-chat-agent): `controller_attachments` gains `chat_session_id` and `chat_seq`, so an image
// can belong to a chat turn's user message. Additive, no backfill (an item's attachment keeps both null), rerun-safe.

const ID = "20261127T2200-controller-chat-attachments";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

describe(`${ID} on an existing SQLite database`, () => {
  it("adds the two columns and the index, keeps every attachment as it was, and is safe to rerun", async () => {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system);
    const db = store.db;
    // The table as it was before: an item's image stored, the migration not yet applied.
    await db.run("DROP TABLE controller_attachments");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id IN (?, ?)`, ["20261120T1000-controller-attachments", ID]);
    await store.migrate();
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    await db.run("DROP INDEX controller_attachments_chat");
    await db.run("ALTER TABLE controller_attachments DROP COLUMN chat_seq");
    await db.run("ALTER TABLE controller_attachments DROP COLUMN chat_session_id");
    const at = { id: "at_1", work_item_id: item.id, kind: "image" as const, media_type: "image/png" as const, data: PNG, size_bytes: 8, name: "a.png", url: null, label: null, created_by: "local:owner" as UserId };
    await store.addAttachment(at);
    const before = await store.listAttachments(item.id);

    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive", tables: [] });
    await migration.up(mdb(db));
    const cols = (await db.all("PRAGMA table_info(controller_attachments)")).map((r) => r.name);
    expect(cols.slice(-2)).toEqual(["chat_session_id", "chat_seq"]);
    expect((await db.all("PRAGMA index_list(controller_attachments)")).map((r) => r.name)).toContain("controller_attachments_chat");
    expect(await store.listAttachments(item.id)).toEqual(before);
    expect(await db.all("SELECT chat_session_id, chat_seq FROM controller_attachments")).toEqual([{ chat_session_id: null, chat_seq: null }]);
    expect(await store.getChatImage("at_1")).toBeNull();
  });

  it("has a timestamp no other migration uses", () => {
    const src = join(import.meta.dirname, "..", "src");
    const stamps = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".migration.ts"))
      .map((f) => f.split("/").pop()!.slice(0, 13));
    expect(stamps.filter((s) => s === "20261127T2200")).toEqual(["20261127T2200"]);
  });
});
