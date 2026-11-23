// Improve reports (design §7): the store methods over `controller_improve_reports`, kept out of sql-factory-store.ts
// so that file stays within its line budget. A report is keyed by its run, so recording one twice stores one row.

import type { ImproveReport, ImproveReportId, RunId, Timestamp } from "../../../core/types.js";
import type { NewImproveReport } from "../../../interfaces/factory-store.js";
import type { Row, SqlDriver } from "../../../state/index.js";
import { newId } from "./rows.js";
import { type StoreTime, insertOnce } from "./store-steps.js";

export async function recordImproveReport(db: SqlDriver, time: StoreTime, input: NewImproveReport): Promise<{ report: ImproveReport; created: boolean }> {
  const report: ImproveReport = { ...input, id: newId("ir") as ImproveReportId, created_at: time.now() };
  const created = await insertOnce(
    db, db,
    `INSERT INTO controller_improve_reports (id, run_id, project_key, window_start, window_end, failure_groups, patterns, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      report.id, report.run_id, report.project, report.window_start, report.window_end,
      JSON.stringify(report.groups), JSON.stringify(report.patterns), report.created_at,
    ],
  );
  return created ? { report, created } : { report: (await getImproveReport(db, input.run_id))!, created };
}

export async function getImproveReport(db: SqlDriver, run_id: RunId): Promise<ImproveReport | null> {
  const [row] = await db.all("SELECT * FROM controller_improve_reports WHERE run_id = ?", [run_id]);
  return row ? rowToImproveReport(row) : null;
}

export async function getLatestImproveReport(db: SqlDriver, project?: string): Promise<ImproveReport | null> {
  const where = project === undefined ? "" : "WHERE project_key = ? ";
  const [row] = await db.all(
    `SELECT * FROM controller_improve_reports ${where}ORDER BY created_at DESC, id DESC LIMIT 1`,
    project === undefined ? [] : [project],
  );
  return row ? rowToImproveReport(row) : null;
}

export async function listImproveReports(db: SqlDriver, project: string, since: Timestamp): Promise<ImproveReport[]> {
  const rows = await db.all(
    "SELECT * FROM controller_improve_reports WHERE project_key = ? AND created_at >= ? ORDER BY created_at, id",
    [project, since],
  );
  return rows.map(rowToImproveReport);
}

export async function setImproveGroups(db: SqlDriver, id: ImproveReportId, groups: ImproveReport["groups"], patterns?: ImproveReport["patterns"]): Promise<void> {
  await db.run(`UPDATE controller_improve_reports SET failure_groups = ?${patterns ? ", patterns = ?" : ""} WHERE id = ?`, [JSON.stringify(groups), ...(patterns ? [JSON.stringify(patterns)] : []), id]);
}

function rowToImproveReport(row: Row): ImproveReport {
  return {
    id: row.id as ImproveReportId,
    run_id: row.run_id as RunId,
    project: row.project_key as string,
    window_start: row.window_start as Timestamp,
    window_end: row.window_end as Timestamp,
    groups: JSON.parse(row.failure_groups as string) as ImproveReport["groups"],
    patterns: JSON.parse(row.patterns as string) as ImproveReport["patterns"],
    created_at: row.created_at as Timestamp,
  };
}
