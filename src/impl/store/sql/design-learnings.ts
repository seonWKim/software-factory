// The design learnings' reads and writes (design 07-design-learnings) over `controller_design_learnings`, as
// SqlDesignLearningStore, which SqlProjectStore extends, so these methods add no line to sql-factory-store.ts's budget.
// Every write is conditional: an insert that skips a stored capture key, and updates that set a column only while it
// is unset, so two replicas or a retry write each value once.

import type { DesignKind, DesignLearning, DesignLearningStore, NewDesignLearning } from "../../../core/design-learnings.js";
import type { Timestamp, WorkItemId } from "../../../core/types.js";
import type { Row, SqlDriver } from "../../../state/index.js";
import { SqlProposalStore } from "./improve-proposals.js";

const COLUMNS = "project_key, work_item_id, capture_key, source, built, words, page, at, supersedes, created_at";

/** `L<n>` as the stored sequence; null for any other text. */
function seqOf(id: string): number | null {
  const m = /^L(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** DesignLearningStore over a SqlDriver; the created time is the store's injected Clock's. */
export class SqlDesignLearningStore extends SqlProposalStore implements DesignLearningStore {
  constructor(
    db: SqlDriver,
    private readonly learningStamp: () => Timestamp,
  ) {
    super(db, learningStamp);
  }

  async recordDesignLearning(input: NewDesignLearning): Promise<{ line: DesignLearning; created: boolean }> {
    const now = this.learningStamp();
    const created = (await this.db.run(
      `INSERT INTO controller_design_learnings (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [input.project, input.work_item_id, input.capture_key, input.source, input.built, input.words, input.page, input.at, input.supersedes, now],
    )) === 1;
    const [row] = await this.db.all("SELECT * FROM controller_design_learnings WHERE capture_key = ?", [input.capture_key]);
    const line = rowToLine(row!);
    // A supersede marks its line every time it is recorded, so a retry after a crash between the two writes finishes it.
    const old = line.supersedes === null ? null : seqOf(line.supersedes);
    if (old !== null) await this.db.run("UPDATE controller_design_learnings SET superseded_by = ? WHERE seq = ? AND superseded_by IS NULL", [line.id, old]);
    return { line, created };
  }

  async listDesignLearnings(project: string): Promise<DesignLearning[]> {
    return (await this.db.all("SELECT * FROM controller_design_learnings WHERE project_key = ? ORDER BY seq", [project])).map(rowToLine);
  }

  async setDesignLearningKind(id: string, kind: DesignKind): Promise<boolean> {
    const seq = seqOf(id);
    return seq !== null && (await this.db.run("UPDATE controller_design_learnings SET kind = ? WHERE seq = ? AND kind IS NULL", [kind, seq])) === 1;
  }

  async markDesignLearningBatch(ids: readonly string[], batch: string): Promise<void> {
    const seqs = ids.map(seqOf).filter((n): n is number => n !== null);
    if (seqs.length === 0) return;
    await this.db.run(`UPDATE controller_design_learnings SET batch = ? WHERE batch IS NULL AND seq IN (${seqs.map(() => "?").join(", ")})`, [batch, ...seqs]);
  }
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function rowToLine(row: Row): DesignLearning {
  return {
    id: `L${Number(row.seq)}`,
    project: String(row.project_key),
    work_item_id: String(row.work_item_id) as WorkItemId,
    capture_key: String(row.capture_key),
    source: String(row.source) as DesignLearning["source"],
    built: String(row.built),
    words: String(row.words),
    page: String(row.page),
    kind: text(row.kind) as DesignKind | null,
    at: String(row.at) as Timestamp,
    supersedes: text(row.supersedes),
    superseded_by: text(row.superseded_by),
    batch: text(row.batch),
  };
}
