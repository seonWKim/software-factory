// Stored command proposals (design 04-gate-commands, issue #584): the store methods of CommandProposalStore, kept out
// of sql-factory-store.ts so that file stays within its line budget, and the SQLite migration that creates the table
// (MySQL: migrations/mysql/0044-command-proposals.sql, the same columns). Store data only: no sync plugin.

import type { CommandName } from "../../../core/commands.js";
import type { Timestamp, WorkItemId } from "../../../core/types.js";
import type { CommandProposal, CommandProposalStatus, CommandProposalStore, NewCommandProposal } from "../../../core/interpret.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";

/**
 * SQLite migration 43. One row per proposed command of a plain-language reply, keyed by (proposal_id, idx): `status`
 * is pending, applied, refused or cancelled; `answered_by` the factory user who confirmed or cancelled it, `refusal`
 * why it was refused at confirm time. IDs only, never display names. No backfill. IF NOT EXISTS: safe to run again.
 */
export const COMMAND_PROPOSALS_SQLITE = `
  CREATE TABLE IF NOT EXISTS controller_command_proposals (
    proposal_id   TEXT NOT NULL,
    idx           INTEGER NOT NULL,
    work_item_id  TEXT NOT NULL,
    command       TEXT NOT NULL,
    args          TEXT NOT NULL,
    author_id     TEXT NOT NULL,
    status        TEXT NOT NULL,
    answered_by   TEXT,
    refusal       TEXT,
    created_at    TEXT NOT NULL,
    answered_at   TEXT,
    PRIMARY KEY (proposal_id, idx)
  );
  `;

function rowToProposal(r: Row): CommandProposal {
  return {
    proposal_id: String(r.proposal_id), idx: Number(r.idx), work_item_id: String(r.work_item_id) as WorkItemId,
    command: String(r.command) as CommandName, args: String(r.args), author_id: String(r.author_id),
    status: String(r.status) as CommandProposalStatus, answered_by: r.answered_by == null ? null : String(r.answered_by),
    refusal: r.refusal == null ? null : String(r.refusal), created_at: String(r.created_at) as Timestamp,
    answered_at: r.answered_at == null ? null : (String(r.answered_at) as Timestamp),
  };
}

/** Each row not stored yet, `pending`, in one transaction; a duplicate key (a repeat, another replica) is "already there". */
export function recordCommandProposals(db: SqlDriver, rows: readonly NewCommandProposal[], at: Timestamp): Promise<number> {
  return db.transaction(async (tx) => {
    let n = 0;
    for (const p of rows) {
      try {
        await tx.run(
          `INSERT INTO controller_command_proposals (proposal_id, idx, work_item_id, command, args, author_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [p.proposal_id, p.idx, p.work_item_id, p.command, p.args, p.author_id, at],
        );
        n++;
      } catch (err) {
        if (!db.isDuplicateKey(err)) throw err;
      }
    }
    return n;
  });
}

export async function listCommandProposals(db: SqlExecutor, proposal_id: string): Promise<CommandProposal[]> {
  const rows = await db.all("SELECT * FROM controller_command_proposals WHERE proposal_id = ? ORDER BY idx", [proposal_id]);
  return rows.map(rowToProposal);
}

/** The conditional status move: only a row still in `from` changes. */
export async function answerCommandProposal(db: SqlExecutor, a: Parameters<CommandProposalStore["answerCommandProposal"]>[0], at: Timestamp): Promise<boolean> {
  const n = await db.run(
    `UPDATE controller_command_proposals SET status = ?, answered_by = ?, refusal = ?, answered_at = ?
     WHERE proposal_id = ? AND idx = ? AND status = ?`,
    [a.to, a.answered_by, a.refusal ?? null, at, a.proposal_id, a.idx, a.from],
  );
  return n > 0;
}
