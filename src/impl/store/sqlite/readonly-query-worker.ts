// The child process of readonly-query.ts (design 09-dashboard-app, Data page Ask): one query on its own read-only
// connection to the store file. A process, not a thread: node:sqlite cannot interrupt a running statement, so the
// parent stops a query past its time limit by killing this process. The job comes as JSON on stdin and the answer
// leaves as JSON on stdout. Node built-ins only (and type imports), so Node runs this file as it is from src/ too.
//
// Three locks on writes, each enough alone: the file is opened read-only (SQLITE_OPEN_READONLY), `query_only` is
// on, and, on a Node that has `setAuthorizer` (24.10 and later), the authorizer allows only reads (SELECT, column
// reads, functions, recursive CTEs), so ATTACH, PRAGMA and every write are refused while the statement is prepared,
// and a read of an `ignore` column gives NULL.

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
    (db as DatabaseSync & Newer).setAuthorizer?.((action, table, column) => {
      if (!READS.has(action)) return SQLITE_DENY;
      if (action === SQLITE_READ && table !== null && column !== null && job.ignore[table]?.includes(column)) return SQLITE_IGNORE;
      return SQLITE_OK;
    });
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
