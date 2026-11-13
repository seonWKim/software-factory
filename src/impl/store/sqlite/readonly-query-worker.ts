// The child process of readonly-query.ts (design 09-dashboard-app, Data page Ask): one query on its own read-only
// connection to the store file. A process, not a thread: node:sqlite cannot interrupt a running statement, so the
// parent stops a query past its time limit by killing this process. The job comes as JSON on stdin and the answer
// leaves as JSON on stdout. Node built-ins only (and type imports), so Node runs this file as it is from src/ too.
//
// Three locks on writes, each enough alone: the file is opened read-only (SQLITE_OPEN_READONLY), `query_only` is
// on, and, on a Node that has `setAuthorizer` (24.10 and later), the authorizer allows only reads (SELECT, column
// reads, functions, recursive CTEs), so ATTACH, PRAGMA and every write are refused while the statement is prepared,
// and a read of an `ignore` column gives NULL.
//
// On an older Node (22.13 to 24.9) no authorizer runs. Writes stay refused by the first two locks: an ATTACH or a
// `PRAGMA query_only = OFF` runs, but every attached database is opened read-only too (a new file is not created),
// and only the first statement of the text runs on a connection that closes after it. A read of an `ignore` column
// is refused instead of NULL: ignoredReadProblem reads the statement's plan (EXPLAIN) and refuses one that opens an
// `ignore` column's table and reads that column, or opens an index holding it (an index seek compares without a
// column read). The name checks of the caller cannot do this alone: a renamed CTE column reads a column unnamed.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { ReadOnlyQueryResult, TableCell } from "../../../interfaces/factory-store.js";

export interface ReadOnlyJob {
  path: string;
  sql: string;
  max_rows: number;
  /** Columns by table whose reads give NULL. */
  ignore: Readonly<Record<string, readonly string[]>>;
}

/** SQLite's authorizer codes (sqlite3.h): stable, and absent from older Node's constants and types. */
const SQLITE_OK = 0;
const SQLITE_DENY = 1;
const SQLITE_IGNORE = 2;
const SQLITE_READ = 20;
const READS = new Set([SQLITE_READ, 21 /* SQLITE_SELECT */, 31 /* SQLITE_FUNCTION */, 33 /* SQLITE_RECURSIVE */]);

type Authorizer = (action: number, a: string | null, b: string | null) => number;
/** The parts of a newer node:sqlite this file uses when they are there. */
type Newer = { setAuthorizer?: (fn: Authorizer) => void };
type NewerStatement = StatementSync & { setReturnArrays?: (on: boolean) => void; columns?: () => { name: string }[] };

/** Whether this Node's node:sqlite has `setAuthorizer` (24.10 and later). */
export function hasAuthorizer(): boolean {
  return typeof (DatabaseSync.prototype as DatabaseSync & Newer).setAuthorizer === "function";
}

interface PlanOp { opcode: string; p1: number; p2: number; p3: number; p5: number }
interface XColumn { cid: number; name: string; type: string; pk: number; hidden: number }

/**
 * Why `sql`'s plan reads an `ignore` column, or null: a column read (OP_Column) of one on its table's cursor, or any
 * open of a b-tree that holds one where a column number cannot be told apart (an index holding it, a WITHOUT ROWID
 * table, a table with hidden or generated columns, an `ignore` column that is the rowid). Used where no authorizer
 * runs; an EXPLAIN only compiles the statement.
 */
export function ignoredReadProblem(db: DatabaseSync, sql: string, ignore: ReadOnlyJob["ignore"]): string | null {
  /** Root page → the table's ignored column numbers, or "all" when every open of it is refused. */
  const guarded = new Map<number, { table: string; columns: Set<number> | "all" }>();
  for (const [table, names] of Object.entries(ignore)) {
    const schema = db.prepare("SELECT rootpage, sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { rootpage: number; sql: string } | undefined;
    if (!schema) continue;
    const cols = db.prepare("SELECT cid, name, type, pk, hidden FROM pragma_table_xinfo(?)").all(table) as unknown as XColumn[];
    const ignored = cols.filter((c) => names.includes(c.name));
    if (ignored.length === 0) continue;
    const rowidAlias = (c: XColumn) => c.pk === 1 && c.type.toUpperCase() === "INTEGER" && cols.filter((x) => x.pk > 0).length === 1;
    const plain = !/\bWITHOUT\s+ROWID\b/i.test(schema.sql) && cols.every((c) => c.hidden === 0) && !ignored.some(rowidAlias);
    guarded.set(Number(schema.rootpage), { table, columns: plain ? new Set(ignored.map((c) => c.cid)) : "all" });
    const indexes = db.prepare("SELECT s.name, s.rootpage FROM pragma_index_list(?) l JOIN sqlite_schema s ON s.type = 'index' AND s.name = l.name").all(table) as { name: string; rootpage: number }[];
    for (const ix of indexes) {
      const keys = db.prepare("SELECT cid, name FROM pragma_index_xinfo(?)").all(ix.name) as { cid: number; name: string | null }[];
      // cid -2 is an expression, which may read an ignored column.
      if (keys.some((k) => k.cid === -2 || (k.name !== null && names.includes(k.name)))) guarded.set(Number(ix.rootpage), { table, columns: "all" });
    }
  }
  if (guarded.size === 0) return null;
  const ops = db.prepare(`EXPLAIN ${sql}`).all() as unknown as PlanOp[];
  // Two passes: a cursor's open need not come before its reads in address order (coroutines, loops).
  const roots = new Map<number, number[]>();
  for (const op of ops) {
    if (op.opcode !== "OpenRead" && op.opcode !== "ReopenIdx") continue;
    if (op.p5 & 0x10 /* OPFLAG_P2ISREG */) return "The query's plan opens a table chosen at run time, so its reads cannot be checked.";
    if (op.p3 === 0) roots.set(op.p1, [...(roots.get(op.p1) ?? []), op.p2]);
  }
  const why = (table: string) => `The query reads a hidden column of ${table}; without an SQLite authorizer (Node 24.10 and later) such a query is refused.`;
  for (const [, list] of roots) {
    for (const root of list) {
      const g = guarded.get(root);
      if (g?.columns === "all") return why(g.table);
    }
  }
  for (const op of ops) {
    if (op.opcode !== "Column") continue;
    for (const root of roots.get(op.p1) ?? []) {
      const g = guarded.get(root);
      if (g && g.columns !== "all" && g.columns.has(op.p2)) return why(g.table);
    }
  }
  return null;
}

/** A read-only connection to the store file: opened read-only, with `query_only` on. */
export function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  return db;
}

function cell(v: unknown): TableCell {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number") return v ?? null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return String(v);
}

/** Runs `job` and closes the connection: the columns and at most `max_rows` rows, or why SQLite refused it. */
export function runReadOnly(job: ReadOnlyJob): ReadOnlyQueryResult {
  const db = openReadOnly(job.path);
  try {
    if (hasAuthorizer()) {
      (db as DatabaseSync & Newer).setAuthorizer!((action, table, column) => {
        if (!READS.has(action)) return SQLITE_DENY;
        if (action === SQLITE_READ && table !== null && column !== null && job.ignore[table]?.includes(column)) return SQLITE_IGNORE;
        return SQLITE_OK;
      });
    } else {
      const problem = ignoredReadProblem(db, job.sql, job.ignore);
      if (problem !== null) return { refused: problem };
    }
    const stmt = db.prepare(job.sql) as NewerStatement;
    // Rows as arrays keep two result columns of the same name apart; an older Node gives objects, keyed by name.
    const arrays = typeof stmt.setReturnArrays === "function";
    stmt.setReturnArrays?.(true);
    let columns = stmt.columns?.().map((c) => c.name) ?? null;
    const rows: TableCell[][] = [];
    let truncated = false;
    for (const r of stmt.iterate() as Iterable<unknown>) {
      if (rows.length >= job.max_rows) {
        truncated = true;
        break;
      }
      columns ??= Object.keys(r as object);
      rows.push((arrays ? (r as unknown[]) : Object.values(r as object)).map(cell));
    }
    return { columns: columns ?? [], rows, truncated };
  } catch (err) {
    return { refused: `SQLite refused the query: ${err instanceof Error ? err.message.slice(0, 300) : "unknown error"}.` };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  process.stdout.write(JSON.stringify(runReadOnly(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReadOnlyJob)));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
