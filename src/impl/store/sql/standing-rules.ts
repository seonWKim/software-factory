// Standing-approval rules and their change records (design 05-standing-approvals): the rule row of each (gate, tier)
// in `controller_standing_rules`, and one `controller_standing_rule_changes` row per change, written in the same
// transaction as the rule write, so `/standing`, the turn-off and the Rules page all leave one record per change.

import type { NewStandingRuleChange, StandingChangeAction, StandingChangeValue, StandingRuleChange } from "../../../core/standing.js";
import type { StandingGate, StandingRule, Tier, Timestamp, UserId } from "../../../core/types.js";
import type { NewStandingRule } from "../../../interfaces/factory-store.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";

const RULE_BY_KEY = "SELECT * FROM controller_standing_rules WHERE gate = ? AND tier = ?";

/**
 * Writes the rule of (gate, tier), a new row or the stored row's `enabled` and `set_by` with a new `updated_at`, and
 * its change record (`add` when on, `pause` when off; `set_by` is the actor), in one transaction.
 */
export function putStandingRule(db: SqlDriver, now: Timestamp, input: NewStandingRule): Promise<StandingRule> {
  return db.transaction(async (tx) => {
    const [before] = await tx.all(RULE_BY_KEY, [input.gate, input.tier]);
    const enabled = input.enabled ? 1 : 0;
    if (before) {
      await tx.run("UPDATE controller_standing_rules SET enabled = ?, set_by = ?, updated_at = ? WHERE gate = ? AND tier = ?", [
        enabled, input.set_by, now, input.gate, input.tier,
      ]);
    } else {
      // Another writer's insert since the read is a duplicate key: the update then wins, as an update would have.
      await tx.run(
        "INSERT INTO controller_standing_rules (gate, tier, enabled, set_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (gate, tier) DO UPDATE SET enabled = excluded.enabled, set_by = excluded.set_by, updated_at = excluded.updated_at",
        [input.gate, input.tier, enabled, input.set_by, now, now],
      );
    }
    await insertChange(tx, now, {
      gate: input.gate, tier: input.tier, action: input.enabled ? "add" : "pause",
      before: before ? { enabled: Number(before.enabled) === 1 } : null, after: { enabled: input.enabled }, actor: input.set_by,
    });
    const [row] = await tx.all(RULE_BY_KEY, [input.gate, input.tier]);
    return rowToStandingRule(row!);
  });
}

export async function listStandingRules(db: SqlExecutor): Promise<StandingRule[]> {
  return (await db.all("SELECT * FROM controller_standing_rules ORDER BY gate, tier")).map(rowToStandingRule);
}

/** Deletes the rule row and records `remove`, in one transaction; false, with nothing written, when there is no row. */
export function deleteStandingRule(db: SqlDriver, now: Timestamp, input: { gate: StandingGate; tier: Tier; actor: UserId }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [before] = await tx.all(RULE_BY_KEY, [input.gate, input.tier]);
    if (!before) return false;
    await tx.run("DELETE FROM controller_standing_rules WHERE gate = ? AND tier = ?", [input.gate, input.tier]);
    await insertChange(tx, now, { gate: input.gate, tier: input.tier, action: "remove", before: { enabled: Number(before.enabled) === 1 }, after: null, actor: input.actor });
    return true;
  });
}

export function recordStandingRuleChange(db: SqlExecutor, now: Timestamp, input: NewStandingRuleChange): Promise<StandingRuleChange> {
  return insertChange(db, now, input);
}

export async function listStandingRuleChanges(db: SqlExecutor): Promise<StandingRuleChange[]> {
  return (await db.all("SELECT * FROM controller_standing_rule_changes ORDER BY seq")).map(rowToChange);
}

async function insertChange(db: SqlExecutor, now: Timestamp, c: NewStandingRuleChange): Promise<StandingRuleChange> {
  const json = (v: StandingChangeValue | null) => (v === null ? null : JSON.stringify(v));
  const [row] = await db.all(
    "INSERT INTO controller_standing_rule_changes (gate, tier, action, before_value, after_value, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
    [c.gate, c.tier, c.action, json(c.before), json(c.after), c.actor, now],
  );
  return rowToChange(row!);
}

function rowToStandingRule(row: Row): StandingRule {
  return {
    gate: row.gate as StandingGate,
    tier: Number(row.tier) as Tier,
    enabled: Number(row.enabled) === 1,
    set_by: row.set_by as UserId,
    created_at: row.created_at as Timestamp,
    updated_at: row.updated_at as Timestamp,
  };
}

function rowToChange(row: Row): StandingRuleChange {
  const value = (v: unknown) => (v === null ? null : (JSON.parse(String(v)) as StandingChangeValue));
  return {
    seq: Number(row.seq),
    gate: row.gate as StandingGate,
    tier: Number(row.tier) as Tier,
    action: row.action as StandingChangeAction,
    before: value(row.before_value),
    after: value(row.after_value),
    actor: row.actor as UserId,
    at: row.at as Timestamp,
  };
}
