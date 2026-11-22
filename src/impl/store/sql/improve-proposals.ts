// The improve run's entity proposals (design 07-self-improvement, issue #496): the store methods of ProposalStore and the
// SQLite migration that creates their table. SQLite only: no MySQL store exists. SqlProjectStore extends this class, so
// these methods add no line to sql-factory-store.ts's budget.

import { createHash } from "node:crypto";
import type { GoldenEvidence, Proposal, ProposalState, ProposalStore, ProposalVerdict } from "../../../core/proposals.js";
import type { SourceRef, Timestamp, UserId } from "../../../core/types.js";
import type { Row, SqlDriver, SqlValue } from "../../../state/index.js";
import { SqlGoldenStore } from "./golden-fingerprints.js";

/** The state each verdict sets; the conditional update in decideProposal allows it only from `pending` (or `held`). */
const VERDICT_STATE: Readonly<Record<ProposalVerdict, ProposalState>> = { promote: "promoted", reject: "rejected", hold: "held" };
/** The proposal ID of (report, pattern key): the same in every retry, so a retried run stores nothing twice. */
const proposalId = (report_id: string, pattern_key: string) => `prop_${createHash("sha256").update(`${report_id}\n${pattern_key}`).digest("hex").slice(0, 16)}`;

/**
 * SQLite migration 45. One row per (improve report, pattern key): its state (watching, skipped, withheld, pending, held,
 * promoted, rejected) and skip reason, the drafted diff and the model's reason, the golden evidence before and after
 * (JSON), a withheld row's G5 rules (JSON), whether it needs a human merge, the verdict's user ID and time, and the filed
 * item (a claim time, then its source ref as JSON). IDs only, never display names. No backfill. IF NOT EXISTS: safe to run again.
 */
export const IMPROVE_PROPOSALS_SQLITE = `
  CREATE TABLE IF NOT EXISTS controller_improve_proposals (
    id                 TEXT PRIMARY KEY,
    project            TEXT NOT NULL,
    report_id          TEXT NOT NULL,
    pattern_key        TEXT NOT NULL,
    error_code         TEXT NOT NULL,
    run_count          INTEGER NOT NULL,
    file               TEXT NOT NULL,
    state              TEXT NOT NULL,
    reason             TEXT,
    why                TEXT,
    diff               TEXT,
    evidence           TEXT,
    rules              TEXT,
    needs_human_merge  INTEGER NOT NULL,
    decided_by         TEXT,
    decided_at         TEXT,
    filing_at          TEXT,
    filed_ref          TEXT,
    created_at         TEXT NOT NULL,
    UNIQUE (report_id, pattern_key)
  );
  CREATE INDEX IF NOT EXISTS controller_improve_proposals_project ON controller_improve_proposals (project, created_at);
  `;

const text = (v: unknown) => (v == null ? null : String(v));
const json = <T>(v: unknown): T | null => (v == null ? null : (JSON.parse(String(v)) as T));

function rowToProposal(r: Row): Proposal {
  const evidence = json<{ before: GoldenEvidence; after: GoldenEvidence }>(r.evidence);
  return {
    id: String(r.id), project: String(r.project), report_id: String(r.report_id), pattern_key: String(r.pattern_key), error_code: String(r.error_code),
    run_count: Number(r.run_count), file: String(r.file), state: String(r.state) as ProposalState, reason: text(r.reason), why: text(r.why), diff: text(r.diff),
    before: evidence?.before ?? null, after: evidence?.after ?? null, rules: json<string[]>(r.rules), needs_human_merge: Number(r.needs_human_merge) === 1,
    decided_by: text(r.decided_by) as UserId | null, decided_at: text(r.decided_at) as Timestamp | null, filed_ref: json<SourceRef>(r.filed_ref),
    created_at: String(r.created_at) as Timestamp,
  };
}

/** ProposalStore over a SqlDriver; `proposalStamp` is the store's injected Clock's time. */
export class SqlProposalStore extends SqlGoldenStore implements ProposalStore {
  constructor(db: SqlDriver, private readonly proposalStamp: () => Timestamp) {
    super(db, proposalStamp);
  }

  async recordProposal(p: Parameters<ProposalStore["recordProposal"]>[0]): Promise<{ proposal: Proposal; created: boolean }> {
    const id = proposalId(p.report_id, p.pattern_key);
    const evidence = p.before && p.after ? JSON.stringify({ before: p.before, after: p.after }) : null;
    const n = await this.db.run(
      `INSERT INTO controller_improve_proposals (id, project, report_id, pattern_key, error_code, run_count, file, state, reason, why, diff, evidence, rules, needs_human_merge, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [id, p.project, p.report_id, p.pattern_key, p.error_code, p.run_count, p.file, p.state, p.reason ?? null, p.why ?? null, p.diff ?? null, evidence,
        p.rules ? JSON.stringify(p.rules) : null, p.needs_human_merge ? 1 : 0, this.proposalStamp()],
    );
    return { proposal: (await this.getProposal(id))!, created: n === 1 };
  }

  async getProposal(id: string): Promise<Proposal | null> {
    const [row] = await this.db.all("SELECT * FROM controller_improve_proposals WHERE id = ?", [id]);
    return row ? rowToProposal(row) : null;
  }

  async listProposals(q: Parameters<ProposalStore["listProposals"]>[0]): Promise<Proposal[]> {
    const where: string[] = [], args: SqlValue[] = [];
    for (const k of ["project", "report_id", "state"] as const) {
      if (q[k] !== undefined) {
        where.push(`${k} = ?`);
        args.push(q[k]);
      }
    }
    if (q.unfiled) where.push("filed_ref IS NULL");
    const rows = await this.db.all(
      `SELECT * FROM controller_improve_proposals${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id LIMIT ?`,
      [...args, q.limit ?? 200],
    );
    return rows.map(rowToProposal);
  }

  /** Only from `pending`, or from `held` to another verdict: a decided proposal, or a second hold, changes nothing. */
  async decideProposal(id: string, verdict: ProposalVerdict, by: UserId): Promise<boolean> {
    const to = VERDICT_STATE[verdict];
    const n = await this.db.run(
      `UPDATE controller_improve_proposals SET state = ?, decided_by = ?, decided_at = ?
       WHERE id = ? AND (state = 'pending' OR (state = 'held' AND ? <> 'held'))`,
      [to, by, this.proposalStamp(), id, to],
    );
    return n === 1;
  }

  async claimProposalFiling(id: string, wait_ms: number): Promise<boolean> {
    const now = this.proposalStamp(), stale = new Date(Date.parse(now) - wait_ms).toISOString();
    const n = await this.db.run(
      `UPDATE controller_improve_proposals SET filing_at = ?
       WHERE id = ? AND state = 'promoted' AND filed_ref IS NULL AND (filing_at IS NULL OR filing_at < ?)`,
      [now, id, stale],
    );
    return n === 1;
  }

  async setProposalFiledRef(id: string, ref: SourceRef): Promise<void> {
    await this.db.run("UPDATE controller_improve_proposals SET filed_ref = ? WHERE id = ? AND filed_ref IS NULL", [JSON.stringify(ref), id]);
  }
}
