import { describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { BACKENDS } from "./helpers/store.js";

/** The schema step that adds the standing-approval tables (issue #298): SQLite migration 32. */
const STEP = 32;
const TABLES = ["standing_rules", "standing_proposals"];
/** The same tables under their RFC 0015 names, after the prefix migration. */
const STORE_TABLES = ["controller_standing_rules", "controller_standing_proposals"];
const owner = "github:1" as UserId;

/** Column names per table of `CREATE TABLE` statements, in order. Keys and constraints are left out. */
function columnsOf(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\)/g)) {
    const cols = m[2]!.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^(UNIQUE|KEY|FOREIGN|PRIMARY KEY \()/.test(l));
    out.set(m[1]!, cols.map((l) => l.split(/\s+/)[0]!));
  }
  return out;
}

describe("standing approvals: schema", () => {
  it("SQLite migration 32 creates the rule and proposal tables", () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(STEP);
    expect([...columnsOf(MIGRATIONS[STEP - 1]!).keys()]).toEqual(TABLES);
  });
});

describe.each(BACKENDS)("standing approvals: store methods ($name)", ({ make }) => {
  it("a new store has both tables, empty", async () => {
    const { store } = await make();
    const tables = await store.listTables();
    for (const t of STORE_TABLES) expect(tables.find((x) => x.name === t), t).toMatchObject({ rows: 0 });
    expect(await store.listStandingRules()).toEqual([]);
    expect(await store.listStandingProposals()).toEqual([]);
  });

  it("storing a proposal for a rule and run length writes one row; a second store at that run length writes nothing", async () => {
    const { store } = await make();
    const first = await store.recordStandingProposal({ gate: "spec", tier: 2, run_length: 10, threshold: 10 });
    expect(first).toMatchObject({ created: true, proposal: { gate: "spec", tier: 2, run_length: 10, threshold: 10 } });
    const again = await store.recordStandingProposal({ gate: "spec", tier: 2, run_length: 10, threshold: 10 });
    expect(again).toEqual({ created: false, proposal: first.proposal });
    expect(await store.listStandingProposals()).toEqual([first.proposal]);
    // Another run length or tier is another proposal.
    const longer = await store.recordStandingProposal({ gate: "spec", tier: 2, run_length: 11, threshold: 10 });
    const other = await store.recordStandingProposal({ gate: "spec", tier: 1, run_length: 10, threshold: 10 });
    expect([longer.created, other.created]).toEqual([true, true]);
    expect((await store.listStandingProposals()).map((p) => [p.tier, p.run_length])).toEqual([[1, 10], [2, 10], [2, 11]]);
  });

  it("concurrent stores of one proposal leave one row", async () => {
    const { store } = await make();
    const input = { gate: "spec" as const, tier: 3 as const, run_length: 10, threshold: 10 };
    const results = await Promise.all([store.recordStandingProposal(input), store.recordStandingProposal(input)]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await store.listStandingProposals()).toHaveLength(1);
  });

  it("putStandingRule writes one row per (gate, tier) and updates it in place", async () => {
    const { store, clock } = await make();
    const rule = await store.putStandingRule({ gate: "spec", tier: 2, enabled: true, set_by: owner });
    expect(rule).toMatchObject({ gate: "spec", tier: 2, enabled: true, set_by: owner });
    expect(rule.updated_at).toBe(rule.created_at);
    clock.advance(1000);
    const off = await store.putStandingRule({ gate: "spec", tier: 2, enabled: false, set_by: "github:2" as UserId });
    expect(off).toMatchObject({ enabled: false, set_by: "github:2", created_at: rule.created_at });
    expect(off.updated_at > rule.updated_at).toBe(true);
    await store.putStandingRule({ gate: "spec", tier: 1, enabled: true, set_by: owner });
    expect((await store.listStandingRules()).map((r) => [r.tier, r.enabled])).toEqual([[1, true], [2, false]]);
  });
});
