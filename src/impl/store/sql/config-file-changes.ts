// The file-only key writer's audit rows (design 08-settings), kept out of sql-factory-store.ts for its line budget.
// The insert runs in the item's own transaction (SqlFactoryStore.fileConfigEdit).

import type { ConfigFileChange, NewConfigFileChange } from "../../../core/config-writer.js";
import type { Timestamp, UserId, WorkItemId } from "../../../core/types.js";
import type { Row, SqlExecutor } from "../../../state/index.js";

export async function insertConfigFileChange(tx: SqlExecutor, c: NewConfigFileChange, at: Timestamp): Promise<ConfigFileChange> {
  await tx.run(
    "INSERT INTO runtime_config_file_changes (work_item_id, setting_key, old_value, new_value, branch, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [c.id, c.key, c.old_value, c.new_value, c.branch, c.actor, at],
  );
  return (await configFileChangeOf(tx, c.id))!;
}

export async function configFileChangeOf(db: SqlExecutor, id: WorkItemId): Promise<ConfigFileChange | null> {
  const [row] = await db.all("SELECT * FROM runtime_config_file_changes WHERE work_item_id = ?", [id]);
  return row ? rowToChange(row) : null;
}

export async function listConfigFileChanges(db: SqlExecutor, limit: number): Promise<ConfigFileChange[]> {
  const rows = await db.all(`SELECT * FROM runtime_config_file_changes ORDER BY seq DESC LIMIT ${Math.max(0, Math.floor(limit))}`);
  return rows.map(rowToChange);
}

function rowToChange(r: Row): ConfigFileChange {
  return {
    seq: Number(r.seq), work_item_id: String(r.work_item_id) as WorkItemId, key: String(r.setting_key),
    old_value: r.old_value === null ? null : String(r.old_value), new_value: String(r.new_value), branch: String(r.branch),
    actor: String(r.actor) as UserId, at: String(r.at) as Timestamp,
  };
}
