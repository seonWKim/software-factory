import { describe, expect, it } from "vitest";
import migration from "../src/state/migrations/20261127T1000-state-coordinator-spend.migration.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver } from "../src/state/index.js";
import type { CoordinatorPorts } from "../src/core/controller-deps.js";
import type { WorkItem, WorkItemId } from "../src/core/types.js";
import { gateAgentWrite } from "../src/controller/units/commands/held-writes.js";
import coordinatorUnit, { type CoordinatorUnit } from "../src/controller/units/coordinator/coordinator.unit.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

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

// The coordinator's merge is an agent write (design 08-permissions, phase 2): after the passport check it passes the
// permission gate, with the mode read from the store at each tick. Held, it is stored once per item: repeated
// coordinator ticks that ask the same merge add no row, and the local merge does not run.
describe("the coordinator's merge through the permission gate", () => {
  async function coordinator(store: FactoryStore) {
    let ports: CoordinatorPorts | null = null;
    const merged: string[] = [];
    const waiting = { id: "wi_1", stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", project: PROJECT_KEY } as WorkItem;
    const ctx = {
      k: {
        d: { coordinator: (p: CoordinatorPorts) => ((ports = p), { tick: async () => ({ kind: "off" as const }) }), store, scanner: new PatternEgressScanner(async () => []), log: silent },
        live: { values: () => ({ coordinator: true, auto_merge_max_tier: 2 }) },
        reader: { listWorkItemsWhere: async () => [waiting], getWorkItem: async (id: string) => (id === "wi_1" ? waiting : null) },
      },
      unit: (name: string): unknown => name === "auth"
        ? { automatic: async () => null }
        : name === "commands"
          ? { gateAgentWrite: (w: Parameters<typeof gateAgentWrite>[1]) => gateAgentWrite(ctx as never, w) }
          : { mergeLocal: async (id: string) => (merged.push(id), null) },
    };
    await (coordinatorUnit.create(ctx as never) as CoordinatorUnit).step();
    return { merge: (key: string) => (ports as unknown as CoordinatorPorts).merge("wi_1" as WorkItemId, key), merged };
  }

  it("holds the merge once with the mode it ran under, however many ticks ask it, and runs nothing", async () => {
    const { store } = await newStore();
    const c = await coordinator(store);
    const first = await c.merge("tick-1");
    expect(first).toMatch(/held under permission_mode ask_irreversible: confirm it with `confirm hw_/);
    expect(await c.merge("tick-2")).toBe(first);
    expect(await c.merge("tick-3")).toBe(first);
    expect((await store.listHeldWrites(10)).filter((h) => h.key === "coordinator:merge:wi_1")).toEqual([
      expect.objectContaining({ command: "merge", args: ["wi_1"], mode: "ask_irreversible", status: "pending" }),
    ]);
    expect(c.merged).toEqual([]);
  });

  it("runs the merge in full permission, read from the store at that tick, and holds nothing", async () => {
    const { store } = await newStore();
    const c = await coordinator(store);
    await store.setSettingOverride({ key: "permission_mode", project: "", value: '"full"', actor: "local:owner" });
    expect(await c.merge("tick-1")).toBeNull();
    expect(c.merged).toEqual(["wi_1"]);
    expect(await store.listHeldWrites(10)).toEqual([]);
  });
});
