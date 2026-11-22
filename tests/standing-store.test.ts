import { describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { BACKENDS } from "./helpers/store.js";

/** The schema step that adds the standing-approval tables (issue #298): SQLite migration 32. */
const STEP = 32;
const TABLES = ["standing_rules", "standing_proposals"];
/** The same tables under their RFC 0015 names, after the prefix migration. */
const STORE_TABLES = ["controller_standing_rules", "controller_standing_proposals", "controller_standing_rule_changes"];
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

  it("putStandingRule records each write: add with no row before, then pause, with the actor's user ID", async () => {
    const { store } = await make();
    await store.putStandingRule({ gate: "spec", tier: 1, enabled: true, set_by: owner });
    await store.putStandingRule({ gate: "spec", tier: 1, enabled: false, set_by: "github:2" as UserId });
    const changes = await store.listStandingRuleChanges();
    expect(changes.map(({ action, before, after, actor }) => ({ action, before, after, actor }))).toEqual([
      { action: "add", before: null, after: { enabled: true }, actor: owner },
      { action: "pause", before: { enabled: true }, after: { enabled: false }, actor: "github:2" },
    ]);
    expect(changes[0]!.seq < changes[1]!.seq).toBe(true);
  });

  it("deleteStandingRule deletes the row and records remove; with no row it writes nothing and answers false", async () => {
    const { store } = await make();
    expect(await store.deleteStandingRule({ gate: "spec", tier: 1, actor: owner })).toBe(false);
    expect(await store.listStandingRuleChanges()).toEqual([]);
    await store.putStandingRule({ gate: "spec", tier: 1, enabled: true, set_by: owner });
    expect(await store.deleteStandingRule({ gate: "spec", tier: 1, actor: owner })).toBe(true);
    expect(await store.listStandingRules()).toEqual([]);
    expect((await store.listStandingRuleChanges()).at(-1)).toMatchObject({ action: "remove", before: { enabled: true }, after: null, actor: owner });
    // A second remove finds no row.
    expect(await store.deleteStandingRule({ gate: "spec", tier: 1, actor: owner })).toBe(false);
    expect((await store.listStandingRuleChanges()).filter((c) => c.action === "remove")).toHaveLength(1);
  });

  it("recordStandingRuleChange stores an edit with its before and after values", async () => {
    const { store } = await make();
    const c = await store.recordStandingRuleChange({ gate: "spec", tier: 1, action: "edit", before: { threshold: 10 }, after: { threshold: 6 }, actor: owner });
    expect(c).toMatchObject({ action: "edit", before: { threshold: 10 }, after: { threshold: 6 }, actor: owner });
    expect(await store.listStandingRuleChanges()).toContainEqual(c);
  });
});
