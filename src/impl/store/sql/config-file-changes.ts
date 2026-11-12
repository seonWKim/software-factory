// The file-only key writer's store (design 08-settings): the local item it files and the item's audit row in
// `runtime_config_file_changes`, in one transaction. A store of its own over the store's SQL database (storeSql), as
// the pack approvals are, so the legacy SqlFactoryStore does not grow.

import type { ConfigFileChange, ConfigFileChangeStore, NewConfigFileChange } from "../../../core/config-writer.js";
import { assertProjectKey } from "../../../core/project.js";
import type { StateChangeId, Timestamp, UserId, WorkItem, WorkItemId } from "../../../core/types.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import { placeholders } from "./retention.js";
import { newId, newWorkItem, rowToWorkItem, workItemInsert } from "./rows.js";

export class ConfigFileChangesSql implements ConfigFileChangeStore {
  constructor(
    private readonly db: SqlDriver,
    /** The change's time, ISO (the injected Clock). */
    private readonly now: () => Timestamp,
  ) {}

  /**
   * The item, created waiting for the owner's merge (REVIEW, blocked on human, merge_pending, no change_ref; tier
   * 4, so auto mode never merges it), its `config_file_edit` state change and its audit row, in one transaction.
   */
  async fileConfigEdit(input: NewConfigFileChange): Promise<{ item: WorkItem; change: ConfigFileChange; created: boolean }> {
    assertProjectKey(input.project);
    const source = { type: "local" as const, id: `config-edit-${input.id}`, link: `local:config-edit-${input.id}` };
    const at = this.now();
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.all("SELECT * FROM controller_work_items WHERE id = ?", [input.id]);
      if (existing) return { item: rowToWorkItem(existing), change: (await changeOf(tx, input.id))!, created: false };
      const fresh = newWorkItem(
        { source, title: input.title, requester_id: input.actor, project: input.project, problem: input.problem, resources: [source.link] },
        { change_ref: null, change_url: null }, at,
      );
      const item: WorkItem = {
        ...fresh, id: input.id, stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", tier: 4,
        allowed_paths: [input.path], pr_files: [input.path],
      };
      const { columns, values } = workItemInsert(item);
      await tx.run(`INSERT INTO controller_work_items (${columns}) VALUES (${placeholders(values.length)})`, values);
      const changes = { stage: { from: null, to: "REVIEW" }, blocked_on: { from: "none", to: "human" }, blocked_reason: { from: null, to: "merge_pending" } };
      await tx.run(
        "INSERT INTO controller_state_changes (id, work_item_id, version, at, actor, reason, changes, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [newId("sc") as StateChangeId, item.id, 1, at, JSON.stringify({ kind: "user", id: input.actor }), "config_file_edit", JSON.stringify(changes),
          JSON.stringify({ key: input.key, branch: input.branch })],
      );
      await tx.run(
        "INSERT INTO runtime_config_file_changes (work_item_id, setting_key, old_value, new_value, branch, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [input.id, input.key, input.old_value, input.new_value, input.branch, input.actor, at],
      );
      return { item, change: (await changeOf(tx, input.id))!, created: true };
    });
  }

  async listConfigFileChanges(limit: number): Promise<ConfigFileChange[]> {
    const rows = await this.db.all(`SELECT * FROM runtime_config_file_changes ORDER BY seq DESC LIMIT ${Math.max(0, Math.floor(limit))}`);
    return rows.map(rowToChange);
  }
}

async function changeOf(db: SqlExecutor, id: WorkItemId): Promise<ConfigFileChange | null> {
  const [row] = await db.all("SELECT * FROM runtime_config_file_changes WHERE work_item_id = ?", [id]);
  return row ? rowToChange(row) : null;
}

function rowToChange(r: Row): ConfigFileChange {
  return {
    seq: Number(r.seq), work_item_id: String(r.work_item_id) as WorkItemId, key: String(r.setting_key),
    old_value: r.old_value === null ? null : String(r.old_value), new_value: String(r.new_value), branch: String(r.branch),
    actor: String(r.actor) as UserId, at: String(r.at) as Timestamp,
  };
}
