// Settings SQL kept out of sql-factory-store.ts so that file stays within its line budget: the overrides' row
// mappers, and the learned settings' reads and writes (design 08-settings, issue #497). Each learned write and its
// audit row commit in one transaction.

import type { LearnedSetting, LearnedSettingChange, SetLearnedSettingInput } from "../../../core/learned-settings.js";
import type { RunId, Timestamp } from "../../../core/types.js";
import type { ResetSettingInput, SettingChange, SettingOverride } from "../../../interfaces/factory-store.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";

export async function getLearnedSetting(db: SqlDriver, project: string, key: string): Promise<LearnedSetting | null> {
  const [row] = await db.all("SELECT * FROM runtime_learned_settings WHERE project_key = ? AND setting_key = ?", [project, key]);
  return row ? rowToLearned(row) : null;
}

export async function listLearnedSettings(db: SqlDriver): Promise<LearnedSetting[]> {
  return (await db.all("SELECT * FROM runtime_learned_settings ORDER BY project_key, setting_key")).map(rowToLearned);
}

export async function listLearnedSettingChanges(db: SqlDriver, limit: number): Promise<LearnedSettingChange[]> {
  const rows = await db.all(`SELECT * FROM runtime_learned_setting_changes ORDER BY seq DESC LIMIT ${Math.max(0, Math.floor(limit))}`);
  return rows.map(rowToChange);
}

/** Conditional on the stored value being `expected` and on no audit row for the window: else nothing is written. */
export async function setLearnedSetting(db: SqlDriver, input: SetLearnedSettingInput, at: Timestamp): Promise<LearnedSettingChange | null> {
  return db.transaction(async (tx) => {
    const old = await selectForUpdate(db, tx, input.project, input.key);
    if ((old?.value ?? null) !== input.expected) return null;
    const [seen] = await tx.all("SELECT seq FROM runtime_learned_setting_changes WHERE project_key = ? AND setting_key = ? AND window_end = ?", [
      input.project, input.key, input.window_end,
    ]);
    if (seen) return null;
    try {
      await insertChange(tx, input.project, input.key, input.expected, input.value, input.evidence_run_ids, input.window_end, input.actor, at);
    } catch (err) {
      // A second worker on the same window committed first: the unique key keeps its row.
      if (db.isDuplicateKey(err)) return null;
      throw err;
    }
    if (old) {
      await tx.run("UPDATE runtime_learned_settings SET value_json = ?, updated_at = ? WHERE project_key = ? AND setting_key = ?", [
        input.value, at, input.project, input.key,
      ]);
    } else {
      await tx.run("INSERT INTO runtime_learned_settings (project_key, setting_key, value_json, updated_at) VALUES (?, ?, ?, ?)", [
        input.project, input.key, input.value, at,
      ]);
    }
    return lastChange(tx, input.project, input.key);
  });
}

export async function resetLearnedSetting(db: SqlDriver, input: ResetSettingInput, at: Timestamp): Promise<LearnedSettingChange | null> {
  return db.transaction(async (tx) => {
    const old = await selectForUpdate(db, tx, input.project, input.key);
    if (!old) return null;
    if ((await tx.run("DELETE FROM runtime_learned_settings WHERE project_key = ? AND setting_key = ?", [input.project, input.key])) === 0) return null;
    await insertChange(tx, input.project, input.key, old.value, null, [], null, input.actor, at);
    return lastChange(tx, input.project, input.key);
  });
}

async function selectForUpdate(db: SqlDriver, tx: SqlExecutor, project: string, key: string): Promise<LearnedSetting | null> {
  const [row] = await tx.all(`SELECT * FROM runtime_learned_settings WHERE project_key = ? AND setting_key = ?${db.dialect.forUpdate}`, [project, key]);
  return row ? rowToLearned(row) : null;
}

async function insertChange(
  tx: SqlExecutor, project: string, key: string, old_value: string | null, new_value: string | null, evidence: RunId[], window_end: Timestamp | null,
  actor: string, at: Timestamp,
): Promise<void> {
  await tx.run(
    "INSERT INTO runtime_learned_setting_changes (project_key, setting_key, old_value, new_value, evidence_run_ids, window_end, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [project, key, old_value, new_value, JSON.stringify(evidence), window_end, actor, at],
  );
}

async function lastChange(tx: SqlExecutor, project: string, key: string): Promise<LearnedSettingChange> {
  const [row] = await tx.all("SELECT * FROM runtime_learned_setting_changes WHERE project_key = ? AND setting_key = ? ORDER BY seq DESC LIMIT 1", [project, key]);
  return rowToChange(row!);
}

export function rowToOverride(row: Row): SettingOverride {
  return {
    key: String(row.setting_key),
    project: String(row.project_key),
    value: String(row.value_json),
    set_by: String(row.set_by),
    set_at: String(row.set_at) as Timestamp,
  };
}

export function rowToSettingChange(row: Row): SettingChange {
  return {
    seq: Number(row.seq),
    key: String(row.setting_key),
    project: String(row.project_key),
    old_value: text(row.old_value),
    new_value: text(row.new_value),
    actor: String(row.actor),
    at: String(row.at) as Timestamp,
  };
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function rowToLearned(row: Row): LearnedSetting {
  return { project: String(row.project_key), key: String(row.setting_key), value: String(row.value_json), updated_at: String(row.updated_at) as Timestamp };
}

function rowToChange(row: Row): LearnedSettingChange {
  return {
    seq: Number(row.seq),
    project: String(row.project_key),
    key: String(row.setting_key),
    old_value: text(row.old_value),
    new_value: text(row.new_value),
    evidence_run_ids: JSON.parse(String(row.evidence_run_ids)) as RunId[],
    window_end: text(row.window_end) as Timestamp | null,
    actor: String(row.actor),
    at: String(row.at) as Timestamp,
  };
}
