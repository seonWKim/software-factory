// The project-key data step (design 2026-11-01, "Projects are keyed by the forge's repository ID"): rewrites
// every legacy `owner/name` project value to its key, `github:<host>:<repo node id>`, in every table that has
// a project column, and stores each project's label. Run by `npm run migrate` on SQLite and MySQL alike, over
// plain SQL (SqlExecutor), so one code path serves both.
//
// Rules: every distinct `owner/name` is resolved through GitHub before anything is written; if one cannot
// be resolved the step stops with an error naming it and writes nothing. A key never contains '/', and an
// `owner/name` never contains ':', so a second run finds nothing to change.

import { type ProjectRef, isLegacyProject, projectLabelCursor } from "../../core/project.js";
import type { Row, SqlExecutor } from "./sql/driver.js";

/** Every table with a project column. A new one must be added here (tests/project-migration.test.ts checks). */
export const PROJECT_TABLES = ["work_items", "unreviewed_merges"] as const;
export type ProjectTable = (typeof PROJECT_TABLES)[number];

/** A project value that is not a key: `owner/name` before this step. Keys always contain ':'. */
const LEGACY_WHERE = "project NOT LIKE '%:%'";

/** One row the step would change. */
export interface ProjectKeyChange {
  table: ProjectTable;
  id: string;
  from: string;
  to: string;
}

export interface ProjectKeyPlan {
  changes: ProjectKeyChange[];
  /** The resolved project of each `owner/name` found, whose label the step stores. */
  projects: ProjectRef[];
}

/** Resolves an `owner/name` to its project through GitHub. Throws when GitHub cannot. */
export type ResolveRepo = (ownerName: string) => Promise<ProjectRef>;

/** A database the step can change in one transaction (SqlDriver satisfies it). */
export interface ProjectKeyDb extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Rows that still hold a legacy project value, over every project table. Read-only, no GitHub call. */
export async function countLegacyProjectRows(db: SqlExecutor): Promise<number> {
  let n = 0;
  for (const t of PROJECT_TABLES) {
    const [row] = await db.all(`SELECT COUNT(*) AS n FROM ${t} WHERE ${LEGACY_WHERE}`);
    n += Number(row?.n ?? 0);
  }
  return n;
}

/** The message a store refuses to open with while legacy rows remain. */
export function legacyRowsMessage(n: number): string {
  return `${n} row${n === 1 ? "" : "s"} still hold an owner/name project value: run \`npm run migrate\` (project keys, design 2026-11-01)`;
}

/**
 * The rows the step would change, with each `owner/name` resolved. Read-only. Throws, naming the repo and
 * the reason, when GitHub cannot resolve one, or when a project value is neither a key nor `owner/name`.
 */
export async function planProjectKeys(db: SqlExecutor, resolve: ResolveRepo): Promise<ProjectKeyPlan> {
  const rows: { table: ProjectTable; row: Row }[] = [];
  for (const table of PROJECT_TABLES) {
    for (const row of await db.all(`SELECT id, project FROM ${table} WHERE ${LEGACY_WHERE} ORDER BY id`)) rows.push({ table, row });
  }
  const resolved = new Map<string, ProjectRef>();
  for (const { table, row } of rows) {
    const value = String(row.project);
    if (resolved.has(value)) continue;
    if (!isLegacyProject(value)) {
      throw new Error(`${table} ${String(row.id)}: project ${JSON.stringify(value.slice(0, 80))} is neither a project key nor owner/name; nothing was changed`);
    }
    try {
      resolved.set(value, await resolve(value));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot resolve ${value} to its GitHub repository ID: ${reason}. No rows were changed`);
    }
  }
  const changes = rows.map(({ table, row }) => ({ table, id: String(row.id), from: String(row.project), to: resolved.get(String(row.project))!.key }));
  return { changes, projects: [...resolved.values()] };
}

/**
 * Applies `plan` in one transaction: each table's `owner/name` values become the key, and each project's label
 * is stored. Only rows still holding the old value change, so it is safe to run twice. Returns the rows changed.
 */
export async function applyProjectKeys(db: ProjectKeyDb, plan: ProjectKeyPlan): Promise<number> {
  const byValue = new Map<string, string>();
  for (const c of plan.changes) byValue.set(`${c.table}\u0000${c.from}`, c.to);
  return db.transaction(async (tx) => {
    let changed = 0;
    for (const [k, to] of byValue) {
      const [table, from] = k.split("\u0000") as [ProjectTable, string];
      changed += await tx.run(`UPDATE ${table} SET project = ? WHERE project = ?`, [to, from]);
    }
    for (const p of plan.projects) {
      const name = projectLabelCursor(p.key);
      if ((await tx.run("UPDATE cursors SET value = ? WHERE name = ?", [p.label, name])) === 0) {
        await tx.run("INSERT INTO cursors (name, value) VALUES (?, ?)", [name, p.label]);
      }
    }
    return changed;
  });
}

export type ProjectKeyMode = "status" | "dry-run" | "apply";

/**
 * The step as `npm run migrate` runs it. `status`: counts the rows left (no GitHub call). `dry-run`: resolves
 * and prints each row it would change, writes nothing. `apply`: resolves, then changes them. GitHub is asked
 * only when legacy rows exist. Returns the exit code; prints instead of throwing.
 */
export async function runProjectKeyStep(
  db: ProjectKeyDb,
  resolve: () => Promise<ResolveRepo>,
  mode: ProjectKeyMode,
  print: (line: string) => void,
): Promise<number> {
  try {
    const left = await countLegacyProjectRows(db);
    if (mode === "status") {
      print(`project keys: ${left === 0 ? "done (no owner/name project values left)" : `${left} row${left === 1 ? "" : "s"} to rewrite`}`);
      return 0;
    }
    if (left === 0) {
      print("project keys: nothing to rewrite");
      return 0;
    }
    const plan = await planProjectKeys(db, await resolve());
    if (mode === "dry-run") {
      print(`-- project keys: ${plan.changes.length} row${plan.changes.length === 1 ? "" : "s"} would change`);
      for (const c of plan.changes) print(`--   ${JSON.stringify(c)}`);
      print("dry run: nothing was changed");
      return 0;
    }
    const changed = await applyProjectKeys(db, plan);
    print(`project keys: rewrote ${changed} row${changed === 1 ? "" : "s"} (${plan.projects.map((p) => p.label).join(", ")})`);
    return 0;
  } catch (err) {
    print(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
