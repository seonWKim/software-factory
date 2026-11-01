// MySQL schema steps: one numbered file per step in migrations/mysql/, run only by `npm run migrate`.
// The schema state is one number in `schema_state`. Step NNNN moves the state from NNNN-1 to NNNN.
// State 11 is the frozen baseline (BASELINE in schema.ts): it builds an empty database, and an existing
// database (legacy `schema_migrations` at 11) is only stamped 11. Nothing here runs when the store opens;
// the driver only calls `pendingError` (a read) and refuses to start while steps are pending.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASELINE, TABLE } from "./schema.js";

/** The state the frozen baseline brings a database to. The first step file is BASELINE_STATE + 1. */
export const BASELINE_STATE = BASELINE.length;

const HERE = fileURLToPath(import.meta.url);
/** The code root: src/impl/store/mysql (tests) or dist/impl/store/mysql (built) is four levels down. */
const CODE_ROOT = resolve(dirname(HERE), "..", "..", "..", "..");
export const STEPS_DIR = join(CODE_ROOT, "migrations", "mysql");

const STEP_FILE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.(sql|ts)$/;
const IGNORED = new Set(["README.md"]);
const LOCK = "software_factory_migrate";

export type Row = Record<string, unknown>;
export type Value = string | number | null;

/** What a `.ts` step gets: plain statements on the migration connection. Same shape as migrations/step.d.ts. */
export interface StepDb {
  all(sql: string, params?: readonly Value[]): Promise<Row[]>;
  run(sql: string, params?: readonly Value[]): Promise<number>;
}

/** The default export of a `.ts` step. */
export interface DataStep {
  /** The rows `apply` would change. Read-only: runs inside a READ ONLY transaction that is rolled back. */
  plan(db: StepDb): Promise<Row[]>;
  /** Changes the data. Runs in one transaction together with the state update. */
  apply(db: StepDb): Promise<void>;
}

export interface StepFile {
  number: number;
  /** The state this step starts from (number - 1). */
  from: number;
  name: string;
  file: string;
  kind: "sql" | "ts";
}

export interface PendingStep {
  number: number;
  label: string;
  /** "baseline": bring the database to state 11 (build on empty, stamp on existing). */
  kind: "baseline" | "sql" | "ts";
  step?: StepFile;
  /** Baseline only: the frozen statements it runs (none when it only records state 11). */
  statements?: readonly string[];
}

export interface MigrationStatus {
  /** The recorded state; null when `schema_state` has no row yet. */
  state: number | null;
  /** The newest state the step files reach. */
  latest: number;
  pending: PendingStep[];
  /** Why `apply` refuses (and changes nothing); null when it can run. */
  refusal: string | null;
}

/** A query surface both a mysql2 Pool and a PoolConnection/Connection satisfy. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}

/** Problems with a list of step file names (README.md excluded). Empty when valid. */
export function stepProblems(files: readonly string[]): string[] {
  const problems: string[] = [];
  const byNumber = new Map<number, string[]>();
  for (const f of files) {
    if (IGNORED.has(f)) continue;
    const m = STEP_FILE.exec(f);
    if (!m) {
      problems.push(`${f}: name must be NNNN-<name>.sql or NNNN-<name>.ts (lowercase letters, digits, dashes)`);
      continue;
    }
    const n = Number(m[1]);
    if (n <= BASELINE_STATE) {
      problems.push(`${f}: steps 1 to ${BASELINE_STATE} are the frozen baseline; the first step file is ${pad(BASELINE_STATE + 1)}`);
      continue;
    }
    byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
  }
  for (const [n, names] of byNumber) {
    if (names.length > 1) problems.push(`${names.join(", ")} share number ${pad(n)}`);
  }
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  let expected = BASELINE_STATE + 1;
  for (const n of numbers) {
    if (n !== expected) {
      problems.push(`gap: expected step ${pad(expected)}, found ${pad(n)} (numbers are contiguous from ${pad(BASELINE_STATE + 1)})`);
      break;
    }
    expected++;
  }
  return problems;
}

/** The step files in `dir`, in number order. Throws when the names are invalid. */
export function readSteps(dir: string = STEPS_DIR): StepFile[] {
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const problems = stepProblems(files);
  if (problems.length > 0) throw new Error(`invalid step files in ${dir}:\n  ${problems.join("\n  ")}`);
  return files
    .filter((f) => !IGNORED.has(f))
    .map((file) => {
      const m = STEP_FILE.exec(file)!;
      const number = Number(m[1]);
      return { number, from: number - 1, name: m[2]!, file, kind: m[3] as "sql" | "ts" };
    })
    .sort((a, b) => a.number - b.number);
}

/**
 * Statements of a `.sql` step: split at a `;` that ends a line. Chunks that hold only comments or
 * whitespace are dropped. A `;` inside a line (e.g. in a string) does not split.
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    const meaningful = text.split("\n").some((l) => l.trim() !== "" && !l.trim().startsWith("--"));
    if (meaningful) out.push(text);
  };
  for (const line of sql.split(/\r?\n/)) {
    const t = line.trimEnd();
    if (t.endsWith(";")) {
      buf.push(t.slice(0, -1));
      flush();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** Where `npm run build` (tsconfig.migrations.json) puts a compiled `.ts` step: <root>/dist/migrations/mysql/. */
export function compiledStepPath(dir: string, file: string): string {
  return join(dir, "..", "..", "dist", "migrations", "mysql", file.replace(/\.ts$/, ".js"));
}

export function isDataStep(v: unknown): v is DataStep {
  return typeof v === "object" && v !== null && typeof (v as DataStep).plan === "function" && typeof (v as DataStep).apply === "function";
}

/** Loads a `.ts` step: the compiled file under dist/; from the source only when this module runs as TypeScript (tests). */
async function loadDataStep(dir: string, step: StepFile): Promise<DataStep> {
  const compiled = compiledStepPath(dir, step.file);
  let url: string;
  if (existsSync(compiled)) url = pathToFileURL(compiled).href;
  else if (HERE.endsWith(".ts")) url = pathToFileURL(join(dir, step.file)).href;
  else throw new Error(`${step.file} is not compiled (${compiled} missing): run \`npm run build\``);
  const mod = (await import(url)) as { default?: unknown };
  if (!isDataStep(mod.default)) throw new Error(`${step.file}: the default export must be { plan(db), apply(db) }`);
  return mod.default;
}

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

/** The message every refusing command and doctor print while steps are pending. Under 120 characters. */
export function pendingMessage(s: MigrationStatus): string {
  const n = s.pending.length;
  return `${n} schema step${n === 1 ? "" : "s"} pending (state ${s.state ?? "none"}, latest ${s.latest}): run \`npm run migrate\``;
}

export class MysqlMigrations {
  private readonly dir: string;

  constructor(
    private readonly db: Queryable,
    opts: { dir?: string } = {},
  ) {
    this.dir = opts.dir ?? STEPS_DIR;
  }

  private async all(sql: string, params: readonly Value[] = []): Promise<Row[]> {
    const [rows] = await this.db.query(sql, [...params]);
    return rows as Row[];
  }

  private async run(sql: string, params: readonly Value[] = []): Promise<number> {
    const [result] = await this.db.query(sql, [...params]);
    return (result as { affectedRows?: number }).affectedRows ?? 0;
  }

  private stepDb(): StepDb {
    return { all: (sql, params) => this.all(sql, params), run: (sql, params) => this.run(sql, params) };
  }

  /** Read-only: one look at the tables and the recorded state. Creates nothing. */
  async status(): Promise<MigrationStatus> {
    const steps = readSteps(this.dir);
    const latest = steps.at(-1)?.number ?? BASELINE_STATE;
    const tables = new Set(
      (await this.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()")).map((r) => String(r.name)),
    );
    let state: number | null = null;
    if (tables.has("schema_state")) {
      const [row] = await this.all("SELECT state FROM schema_state WHERE id = 1");
      if (row) state = Number(row.state);
    }
    const fileSteps = (after: number): PendingStep[] =>
      steps.filter((s) => s.number > after).map((s) => ({ number: s.number, label: s.file, kind: s.kind, step: s }));

    if (state === null) {
      const legacy = tables.has("schema_migrations")
        ? Number((await this.all("SELECT MAX(version) AS v FROM schema_migrations"))[0]?.v ?? 0)
        : null;
      const others = [...tables].filter((t) => t !== "schema_state" && t !== "schema_migrations");
      let label: string;
      const statements = BASELINE.slice(legacy ?? 0).flat();
      if (legacy === null && others.length === 0) label = `baseline: build the state-${BASELINE_STATE} schema on an empty database`;
      else if (legacy === null)
        return { state, latest, pending: [], refusal: `the database has tables (${others.slice(0, 3).join(", ")}…) but no schema_state or schema_migrations: not a factory database` };
      else if (legacy > BASELINE_STATE)
        return { state, latest, pending: [], refusal: `schema_migrations is at ${legacy}, past the frozen baseline ${BASELINE_STATE}: unknown database` };
      else if (legacy === BASELINE_STATE) label = `baseline: record state ${BASELINE_STATE} on the existing schema (no statements)`;
      else label = `baseline: apply legacy steps ${legacy + 1} to ${BASELINE_STATE}, then record state ${BASELINE_STATE}`;
      return { state, latest, pending: [{ number: BASELINE_STATE, label, kind: "baseline", statements }, ...fileSteps(BASELINE_STATE)], refusal: null };
    }
    if (state > latest)
      return { state, latest, pending: [], refusal: `recorded state ${state} is ahead of the newest step file (${pad(latest)}): update the factory` };
    if (state < BASELINE_STATE)
      return { state, latest, pending: [], refusal: `recorded state ${state} is below the baseline ${BASELINE_STATE}: no step starts there` };
    return { state, latest, pending: fileSteps(state), refusal: null };
  }

  /**
   * Prints what `apply` would do: the SQL of `.sql` steps, the rows a `.ts` step would change. Changes
   * nothing. `db` must be one connection (not a pool): a `.ts` plan runs in a READ ONLY transaction.
   */
  async dryRun(print: (line: string) => void): Promise<MigrationStatus> {
    const s = await this.status();
    if (s.refusal) return s;
    let blocked = false; // an earlier pending step changes the schema a later plan may read
    for (const p of s.pending) {
      print(`-- ${pad(p.number)}: ${p.label}`);
      if (p.kind === "baseline") {
        for (const st of p.statements ?? []) print(`${st};`);
        print(`-- records state ${BASELINE_STATE}`);
        blocked = (p.statements ?? []).length > 0;
      } else if (p.kind === "sql") {
        for (const st of splitSql(readFileSync(join(this.dir, p.step!.file), "utf8"))) print(`${st};`);
        print(`-- records state ${p.number}`);
        blocked = true;
      } else {
        const step = await loadDataStep(this.dir, p.step!);
        try {
          const rows = await this.readOnly(() => step.plan(this.stepDb()));
          print(`-- ${rows.length} row${rows.length === 1 ? "" : "s"} would change`);
          for (const r of rows) print(`--   ${JSON.stringify(r)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          print(`-- could not list the rows: ${msg}${blocked ? " (an earlier pending step must run first)" : ""}`);
        }
        print(`-- records state ${p.number}`);
      }
    }
    return s;
  }

  /**
   * Applies every pending step in number order, recording the state after each one. Refuses (and
   * changes nothing) when `status().refusal` is set. Serialized across processes by a named lock.
   * `db` must be one connection (not a pool) so the lock and transactions hold.
   */
  async apply(print: (line: string) => void): Promise<MigrationStatus> {
    const [got] = await this.all("SELECT GET_LOCK(?, 60) AS ok", [LOCK]);
    if (Number(got?.ok) !== 1) throw new Error("another `npm run migrate` holds the migration lock; try again when it is done");
    try {
      const s = await this.status();
      if (s.refusal) throw new Error(`refusing to migrate: ${s.refusal}`);
      for (const p of s.pending) {
        print(`applying ${pad(p.number)}: ${p.label}`);
        if (p.kind === "baseline") await this.baseline();
        else if (p.kind === "sql") {
          for (const st of splitSql(readFileSync(join(this.dir, p.step!.file), "utf8"))) await this.run(st);
          await this.record(p.number);
        } else {
          const step = await loadDataStep(this.dir, p.step!);
          await this.run("START TRANSACTION");
          try {
            await step.apply(this.stepDb());
            await this.record(p.number);
            await this.run("COMMIT");
          } catch (err) {
            await this.run("ROLLBACK").catch(() => undefined);
            throw err;
          }
        }
        print(`state ${p.number}`);
      }
      return s;
    } finally {
      await this.all("SELECT RELEASE_LOCK(?)", [LOCK]).catch(() => undefined);
    }
  }

  /** Legacy groups up to 11 in `schema_migrations` (each recorded, so a failed build resumes), then state 11. */
  private async baseline(): Promise<void> {
    await this.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INT NOT NULL PRIMARY KEY)");
    const [row] = await this.all("SELECT MAX(version) AS v FROM schema_migrations");
    for (let v = Number(row?.v ?? 0) + 1; v <= BASELINE_STATE; v++) {
      for (const st of BASELINE[v - 1]!) await this.run(st);
      await this.run("INSERT INTO schema_migrations (version) VALUES (?)", [v]);
    }
    await this.run(`CREATE TABLE IF NOT EXISTS schema_state (id TINYINT NOT NULL PRIMARY KEY, state INT NOT NULL) ${TABLE}`);
    await this.run("INSERT INTO schema_state (id, state) VALUES (1, ?)", [BASELINE_STATE]);
  }

  private async record(state: number): Promise<void> {
    const n = await this.run("UPDATE schema_state SET state = ? WHERE id = 1", [state]);
    if (n !== 1) throw new Error("schema_state has no row: run the baseline first");
  }

  private async readOnly<T>(fn: () => Promise<T>): Promise<T> {
    await this.run("START TRANSACTION READ ONLY");
    try {
      return await fn();
    } finally {
      await this.run("ROLLBACK").catch(() => undefined);
    }
  }
}
