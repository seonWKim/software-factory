// The filed patterns' reads and writes (design 07-self-improvement), kept out of sql-factory-store.ts so that file
// stays within its line budget. The claim stays there: it uses the store's conditional insert.

import type { FiledPattern, FiledPatternId, ImproveReportId, SourceRef, Timestamp } from "../../../core/types.js";
import type { Row, SqlDriver } from "../../../state/index.js";

export async function getFiledPattern(db: SqlDriver, project: string, pattern_key: string): Promise<FiledPattern | null> {
  const [row] = await db.all("SELECT * FROM controller_filed_patterns WHERE project_key = ? AND pattern_key = ?", [project, pattern_key]);
  return row ? rowToFiledPattern(row) : null;
}

export async function setFiledPatternRef(db: SqlDriver, id: FiledPatternId, report_id: ImproveReportId, ref: SourceRef): Promise<void> {
  await db.run("UPDATE controller_filed_patterns SET filed_ref = ? WHERE id = ? AND report_id = ?", [JSON.stringify(ref), id, report_id]);
}

export async function listFiledPatternsWithoutOutcome(db: SqlDriver, project: string): Promise<FiledPattern[]> {
  const rows = await db.all(
    "SELECT * FROM controller_filed_patterns WHERE project_key = ? AND filed_ref IS NOT NULL AND outcome IS NULL ORDER BY created_at, id",
    [project],
  );
  return rows.map(rowToFiledPattern);
}

/** Writes only where no outcome is set: true when this call wrote it. */
export async function setFiledPatternOutcome(db: SqlDriver, id: FiledPatternId, outcome: NonNullable<FiledPattern["outcome"]>, at: Timestamp): Promise<boolean> {
  return (await db.run("UPDATE controller_filed_patterns SET outcome = ?, outcome_at = ? WHERE id = ? AND outcome IS NULL", [outcome, at, id])) === 1;
}

function rowToFiledPattern(row: Row): FiledPattern {
  return {
    id: row.id as FiledPatternId,
    project: row.project_key as string,
    pattern_key: row.pattern_key as string,
    error_code: row.error_code as string,
    detail: row.detail as string,
    report_id: row.report_id as ImproveReportId,
    filed_ref: row.filed_ref === null || row.filed_ref === undefined ? null : (JSON.parse(row.filed_ref as string) as SourceRef),
    created_at: row.created_at as Timestamp,
    outcome: (row.outcome ?? null) as FiledPattern["outcome"],
    outcome_at: (row.outcome_at ?? null) as Timestamp | null,
  };
}
