// RFC 0015 M1: every table takes its owner's prefix (§6.3). Breaking: the code switches to the new names in
// the same release. Data is copied and verified, never moved in place, and the old tables stay as
// `legacy_<old>` until a contract migration drops them after the owner confirms (§12).
//
// Two tables merge later, when their code is rebuilt (M4): command_inbox and app_command_requests become one
// inbound_commands. Here each keeps its own table. cli_commands and item_messages have no code left: they
// only go to legacy.

import { renameTablesByCopy, verifyRenamedTables, type Rename } from "../migrate/copy-tables.js";
import { defineMigration } from "../migrate/migration.js";

export const RENAMES: readonly Rename[] = [
  { from: "alert_patterns", to: "controller_alert_patterns" },
  { from: "alerts", to: "controller_alerts" },
  { from: "app_command_requests", to: "inbound_app_requests" },
  { from: "base_pushes", to: "outbound_base_pushes" },
  { from: "budget_checkpoints", to: "controller_budget_checkpoints" },
  { from: "child_restarts", to: "runtime_child_restarts" },
  { from: "claim_decisions", to: "controller_claim_decisions" },
  { from: "claim_locks", to: "worker_claim_locks" },
  { from: "claim_pauses", to: "worker_claim_pauses" },
  { from: "command_inbox", to: "inbound_commands" },
  { from: "cursors", to: "inbound_cursors" },
  { from: "dependency_edges", to: "controller_dependency_edges" },
  { from: "file_conflicts", to: "controller_file_conflicts" },
  { from: "filed_patterns", to: "controller_filed_patterns" },
  { from: "forge_budget", to: "outbound_forge_budget" },
  { from: "handoffs", to: "controller_handoffs" },
  { from: "host_sleeps", to: "worker_host_sleeps" },
  { from: "improve_reports", to: "controller_improve_reports" },
  { from: "item_thread", to: "controller_item_thread" },
  { from: "label_states", to: "outbound_label_states" },
  { from: "link_codes", to: "identity_link_codes" },
  { from: "listener_leases", to: "inbound_listener_leases" },
  { from: "local_users", to: "identity_local_users" },
  { from: "merge_checks", to: "controller_merge_checks" },
  { from: "posted_comments", to: "outbound_deliveries" },
  { from: "run_attempts", to: "worker_run_attempts" },
  { from: "runs", to: "worker_runs" },
  { from: "settings_changes", to: "runtime_settings_changes" },
  { from: "settings_overrides", to: "runtime_settings_overrides" },
  { from: "source_inbox", to: "inbound_raw_records" },
  { from: "standing_proposals", to: "controller_standing_proposals" },
  { from: "standing_rules", to: "controller_standing_rules" },
  { from: "state_changes", to: "controller_state_changes" },
  { from: "sync_leases", to: "inbound_sync_leases" },
  { from: "thread_outbox", to: "outbound_intents" },
  { from: "unreviewed_merges", to: "controller_unreviewed_merges" },
  { from: "user_links", to: "identity_user_links" },
  { from: "verdicts", to: "controller_verdicts" },
  { from: "work_items", to: "controller_work_items" },
];

export const ARCHIVE_ONLY = ["cli_commands", "item_messages"] as const;

export default defineMigration({
  change: "breaking",
  tables: [...RENAMES.map((r) => r.from), ...ARCHIVE_ONLY],
  async up(db) {
    await renameTablesByCopy(db, RENAMES, ARCHIVE_ONLY);
  },
  verify: (db) => verifyRenamedTables(db, RENAMES, ARCHIVE_ONLY),
});
