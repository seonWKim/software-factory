// The Data page's read-only query (design 09-dashboard-app, Ask): the statement checks, then one query in a child
// process on its own read-only connection (readonly-query-worker.ts), with a row cap and a time limit. The checks
// come first and refuse with a reason; the child's connection refuses every write by itself as well.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ReadOnlyQueryOpts, ReadOnlyQueryResult } from "../../../interfaces/factory-store.js";
import type { ReadOnlyJob } from "./readonly-query-worker.js";

/** The most rows one query returns; a larger result is cut and says so. */
export const READ_ONLY_MAX_ROWS = 500;
/** How long one query may run before it is stopped. */
export const READ_ONLY_TIME_LIMIT_MS = 5000;
/** The most answer bytes read back from the child: past it the query is refused, not cut mid-row. */
const MAX_ANSWER_BYTES = 32 * 1024 * 1024;

/** Words that write or change the connection: refused anywhere in the statement. */
const REFUSED_WORDS = new Set([
  "ATTACH", "DETACH", "PRAGMA", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "VACUUM", "REINDEX", "ANALYZE",
  "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE",
]);

/**
 * `sql` with its comments and string literals blanked, and the quotes of quoted names turned to spaces (the names
 * stay, so a check sees `"lease_token"` as lease_token). Statement checks read this, never the raw text.
 */
export function sqlCode(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?|["`[\]]/g, (m) => (m.startsWith("'") ? "''" : " "));
}

/** The words of `sql`'s code (see sqlCode), upper-cased, in order. */
export function sqlWords(sql: string): string[] {
  return sqlCode(sql).toUpperCase().match(/[A-Z_][A-Z0-9_$]*/g) ?? [];
}

/** Why `sql` may not run (one statement that begins with SELECT or WITH and reads only), or null when it may. */
export function statementProblem(sql: string): string | null {
  const code = sqlCode(sql).trim().replace(/;\s*$/, "");
  if (code === "") return "There is no statement to run.";
  if (code.includes(";")) return "Only one statement runs, and this text holds more than one.";
  const words = sqlWords(code);
  const first = words[0] ?? "";
  if (first !== "SELECT" && first !== "WITH") return `Only a SELECT (or WITH … SELECT) runs, and this statement begins with ${first || "no keyword"}.`;
  const refused = words.find((w) => REFUSED_WORDS.has(w));
  if (refused) return `${refused} is not allowed: the query only reads.`;
  if (/\bREPLACE\s+INTO\b/i.test(code)) return "REPLACE INTO is not allowed: the query only reads.";
  if (!words.includes("SELECT")) return "Only a SELECT (or WITH … SELECT) runs, and this statement has no SELECT.";
  return null;
}

/** The child's script: the .ts beside this file when it runs from src/ (tests), else the built .js. */
const WORKER = fileURLToPath(new URL(`./readonly-query-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));

/**
 * One read-only query on the SQLite file at `path`: refused with the reason when statementProblem finds one, else run
 * in a child process on its own read-only connection, stopped at the time limit, with at most `max_rows` rows.
 */
export function readOnlyQuery(path: string, sql: string, opts: ReadOnlyQueryOpts = {}): Promise<ReadOnlyQueryResult> {
  const problem = statementProblem(sql);
  if (problem !== null) return Promise.resolve({ refused: problem });
  if (path === ":memory:") return Promise.resolve({ refused: "An in-memory store has no second connection to read from." });
  const limit = opts.time_limit_ms ?? READ_ONLY_TIME_LIMIT_MS;
  const job: ReadOnlyJob = { path, sql, max_rows: opts.max_rows ?? READ_ONLY_MAX_ROWS, ignore: opts.ignore ?? {} };
  return new Promise((resolve) => {
    // Node kills the child at the time limit (SIGKILL: SQLite cannot be interrupted from JS, a process can).
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", WORKER], { stdio: ["pipe", "pipe", "ignore"], timeout: limit, killSignal: "SIGKILL" });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (r: ReadOnlyQueryResult) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve(r);
    };
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_ANSWER_BYTES) done({ refused: "The result is too large to show: ask for fewer or shorter columns." });
      else chunks.push(c);
    });
    child.on("error", (err) => done({ refused: `The query could not start: ${err.message}.` }));
    child.on("close", (_code, signal) => {
      if (signal === "SIGKILL") return done({ refused: `Stopped: the query ran past the time limit of ${limit / 1000} seconds.` });
      try {
        done(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReadOnlyQueryResult);
      } catch {
        done({ refused: "The query stopped without an answer." });
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(job));
  });
}
