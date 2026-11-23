// The filed patterns' reads and writes (design 07-self-improvement), kept out of sql-factory-store.ts so that file
// stays within its line budget. The claim takes the store's conditional insert (`insertOnce`) as an argument.

import type { FiledPattern, FiledPatternId, ImproveReportId, SourceRef, Timestamp, WorkItem } from "../../../core/types.js";
import type { FactoryStore, NewFiledPattern } from "../../../interfaces/factory-store.js";
import type { Row, SqlDriver, SqlValue } from "../../../state/index.js";
import { newId, rowToWorkItem } from "./rows.js";

/** The row a take updates (`FactoryStore.takeFiledPattern`). */
export type TakeFrom = Parameters<FactoryStore["takeFiledPattern"]>[1];

export async function getFiledPattern(db: SqlDriver, project: string, pattern_key: string): Promise<FiledPattern | null> {
  const [row] = await db.all("SELECT * FROM controller_filed_patterns WHERE project_key = ? AND pattern_key = ?", [project, pattern_key]);
  return row ? rowToFiledPattern(row) : null;
}

/**
 * The store's `takeFiledPattern`: a new row first (an insert that skips a stored key), then, with `from`, one conditional
 * update of the row it names. `taken`: this call inserted or updated the row, so of two callers only one is told to file.
 */
export async function takeFiledPattern(
  db: SqlDriver, insertOnce: (sql: string, params: SqlValue[]) => Promise<boolean>, input: NewFiledPattern, now: Timestamp, from: TakeFrom,
): Promise<{ row: FiledPattern; taken: boolean }> {
  const evidence = input.evidence ?? null;
  let taken = await insertOnce(
    `INSERT INTO controller_filed_patterns (id, project_key, pattern_key, error_code, detail, report_id, filed_ref, created_at, evidence)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [newId("fp"), input.project, input.pattern_key, input.error_code, input.detail, input.report_id, now, evidence],
  );
  const where = "WHERE project_key = ? AND pattern_key = ? AND report_id = ?";
  const at = [input.project, input.pattern_key];
  if (from && "replace" in from && from.replace !== input.report_id) {
    taken = (await db.run(
      `UPDATE controller_filed_patterns SET report_id = ?, filed_ref = NULL, error_code = ?, detail = ?, created_at = ?, outcome = NULL, outcome_at = NULL, evidence = ? ${where}`,
      [input.report_id, input.error_code, input.detail, now, evidence, ...at, from.replace],
    )) === 1 || taken;
  } else if (from && "restart" in from) {
    // A half-done claim taken up again keeps its report (and so its marker); its claim time starts the wait again.
    taken = (await db.run(
      `UPDATE controller_filed_patterns SET created_at = ? ${where} AND created_at = ? AND filed_ref IS NULL`,
      [now, ...at, from.restart.report_id, from.restart.created_at],
    )) === 1;
  }
  return { row: (await getFiledPattern(db, input.project, input.pattern_key))!, taken };
}

/** The oldest item of `project` titled exactly `title` that is not CLOSED, or null. Read-only. */
export async function getOpenWorkItemByTitle(db: SqlDriver, project: string, title: string): Promise<WorkItem | null> {
  const [row] = await db.all(
    `SELECT * FROM controller_work_items WHERE project = ? AND title = ? AND stage <> 'CLOSED' ORDER BY created_at, id LIMIT 1`,
    [project, title],
  );
  return row ? rowToWorkItem(row) : null;
}

export async function setFiledPatternRef(db: SqlDriver, id: FiledPatternId, report_id: ImproveReportId, ref: SourceRef): Promise<void> {
  await db.run("UPDATE controller_filed_patterns SET filed_ref = ? WHERE id = ? AND report_id = ?", [JSON.stringify(ref), id, report_id]);
}

export async function listFiledPatternsSince(db: SqlDriver, since: Timestamp): Promise<FiledPattern[]> {
  const rows = await db.all("SELECT * FROM controller_filed_patterns WHERE filed_ref IS NOT NULL AND created_at >= ? ORDER BY created_at, id", [since]);
  return rows.map(rowToFiledPattern);
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
    evidence: row.evidence === null || row.evidence === undefined ? null : Number(row.evidence),
  };
}
