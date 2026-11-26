import { describe, expect, it } from "vitest";
import migration from "../src/state/migrations/20261127T1000-state-coordinator-spend.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import { newStore } from "./helpers/store.js";

// The coordinator spend kind (design 06-spend): controller_chat_spend gains `kind`, `chat` or `coordinator`, default
// `chat`. Additive: a stored row reads `chat` through the default, nothing else changes, and a rerun changes nothing.
// The chat totals (listChatSpendBetween) read only `chat` rows.

const ID = "20261127T1000-state-coordinator-spend";
const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
const ROW = (turn: string, kind?: string) =>
  kind === undefined
    ? `INSERT INTO controller_chat_spend (turn_id, session_id, day, cost_usd, tokens, created_at) VALUES ('${turn}', 'ses_1', '2026-11-27', 0.5, 100, '2026-11-27T09:00:00.000Z')`
    : `INSERT INTO controller_chat_spend (turn_id, session_id, day, cost_usd, tokens, created_at, kind) VALUES ('${turn}', 'ses_1', '2026-11-27', 0.5, 100, '2026-11-27T09:00:00.000Z', '${kind}')`;

describe(ID, () => {
  it("a fresh store has the kind column and the migration recorded", async () => {
    const { store } = await newStore();
    const cols = (await store.db.all("SELECT name FROM pragma_table_info('controller_chat_spend')")).map((r) => r.name);
    expect(cols).toContain("kind");
    expect(await store.db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(migration).toMatchObject({ change: "additive" });
  });

  it("accepts kind coordinator and chat, and refuses any other kind", async () => {
    const { store } = await newStore();
    await store.db.run(ROW("t_coord", "coordinator"));
    await store.db.run(ROW("t_chat", "chat"));
    await expect(store.db.run(ROW("t_bad", "worker"))).rejects.toThrow(/CHECK/i);
    expect(await store.db.all("SELECT turn_id, kind FROM controller_chat_spend ORDER BY turn_id")).toEqual([
      { turn_id: "t_chat", kind: "chat" }, { turn_id: "t_coord", kind: "coordinator" },
    ]);
  });

  it("adds the column with default chat, keeps every row as it was, and a rerun changes nothing", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("ALTER TABLE controller_chat_spend DROP COLUMN kind");
    await db.run(ROW("t_old"));
    const before = await db.all("SELECT * FROM controller_chat_spend");
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_chat_spend")).toEqual(before.map((r) => ({ ...r, kind: "chat" })));
    const after = await db.all("SELECT * FROM controller_chat_spend");
    await migration.up(mdb(db));
    expect(await db.all("SELECT * FROM controller_chat_spend")).toEqual(after);
  });

  it("chat turns recorded by the store read as chat, and the chat totals leave coordinator rows out", async () => {
    const { store } = await newStore();
    expect(await store.recordChatSpend({ turn_id: "t_chat", session_id: "ses_1", day: "2026-11-27", cost_usd: 0.25, tokens: 10 })).toBe(true);
    await store.db.run(ROW("t_coord", "coordinator"));
    expect(await store.db.all("SELECT kind FROM controller_chat_spend WHERE turn_id = 't_chat'")).toEqual([{ kind: "chat" }]);
    expect((await store.listChatSpendBetween("2026-11-27", "2026-11-27")).map((s) => s.turn_id)).toEqual(["t_chat"]);
  });
});
