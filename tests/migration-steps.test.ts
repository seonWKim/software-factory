import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINE_STATE,
  INLINE_STEPS,
  STEPS_DIR,
  inlineStepName,
  compiledStepPath,
  isDataStep,
  readSteps,
  splitSql,
  stepProblems,
} from "../src/impl/store/mysql/migrations.js";
import { migrationCheck, mysqlMigrationCheck } from "../src/impl/store/mysql/migrate-command.js";
import { MIGRATION_PENDING_CODE } from "../src/interfaces/updater.js";
import { migrationPendingError } from "../src/impl/store/mysql/mysql-driver.js";

// Runs under plain `npm test`: no MySQL needed.

describe("migrations/mysql step files", () => {
  it("the repo's steps (files plus inline steps) are contiguous; inline 0013 adds the phase columns", () => {
    const files = readdirSync(STEPS_DIR).filter((f) => f !== "README.md");
    expect(stepProblems([...files, ...INLINE_STEPS.map(inlineStepName)])).toEqual([]);
    const steps = readSteps(STEPS_DIR, INLINE_STEPS);
    expect(steps.map((s) => s.number)).toEqual(steps.map((_, i) => BASELINE_STATE + 1 + i));
    const phases = steps.find((s) => s.name === "work-item-phases")!;
    expect(phases).toMatchObject({ number: 13, from: 12, kind: "sql", file: "0013-work-item-phases.sql" });
    expect(splitSql(phases.sql!)).toEqual([
      expect.stringContaining("ADD COLUMN parent_id VARCHAR(64) NULL"),
      expect.stringContaining("ADD COLUMN phase INT NULL"),
      expect.stringContaining("CREATE INDEX work_items_parent ON work_items (parent_id, phase)"),
    ]);
  });

  it("an inline step whose number a file already uses is a duplicate", () => {
    const dir = stepsDir({ "0012-a.sql": "SELECT 1;", "0013-b.sql": "SELECT 1;" });
    expect(() => readSteps(dir, [{ number: 13, name: "c", sql: "SELECT 2;" }])).toThrow(/share number 0013/);
    expect(readSteps(dir).map((s) => s.number)).toEqual([12, 13]);
  });

  it("the first step starts at the baseline state", () => {
    expect(BASELINE_STATE).toBe(11);
    expect(stepProblems(["0012-a.sql"])).toEqual([]);
    expect(stepProblems(["0013-a.sql"])).toEqual([expect.stringContaining("0012")]);
  });

  it("fails when two step files share a number", () => {
    expect(stepProblems(["0012-a.sql", "0012-b.ts"])).toEqual([expect.stringContaining("share number 0012")]);
  });

  it("fails when the numbers have a gap", () => {
    expect(stepProblems(["0012-a.sql", "0014-b.sql"])).toEqual([expect.stringContaining("gap")]);
  });

  it("fails when a file name does not match NNNN-<name>.sql or NNNN-<name>.ts", () => {
    for (const bad of ["12-a.sql", "0012_a.sql", "0012-a.js", "0012-.sql", "0012-A b.sql", "notes.txt", "0012-a.d.ts"]) {
      expect(stepProblems([bad]), bad).toEqual([expect.stringContaining(bad)]);
    }
  });

  it("numbers at or below the baseline are rejected", () => {
    expect(stepProblems(["0011-a.sql", "0012-b.sql"])).toEqual([expect.stringContaining("0011-a.sql")]);
  });

  it("readSteps lists steps in number order with their starting state", () => {
    const dir = stepsDir({ "0013-b.ts": "export default {}", "0012-a.sql": "SELECT 1;", "README.md": "x" });
    expect(readSteps(dir).map((s) => [s.number, s.from, s.kind, s.file])).toEqual([
      [12, 11, "sql", "0012-a.sql"],
      [13, 12, "ts", "0013-b.ts"],
    ]);
  });

  it("readSteps throws on an invalid tree", () => {
    const dir = stepsDir({ "0012-a.sql": "", "0012-b.sql": "" });
    expect(() => readSteps(dir)).toThrow(/share number 0012/);
  });
});

describe("splitSql", () => {
  it("splits at a ; that ends a line and drops comment-only chunks", () => {
    const sql = "-- add x\nALTER TABLE a\n  ADD COLUMN x INT NULL;\nUPDATE a SET x = 1 WHERE note = 'a;b';\n-- trailing comment\n";
    expect(splitSql(sql)).toEqual(["-- add x\nALTER TABLE a\n  ADD COLUMN x INT NULL", "UPDATE a SET x = 1 WHERE note = 'a;b'"]);
  });

  it("keeps a last statement without a ;", () => {
    expect(splitSql("SELECT 1;\nSELECT 2\n")).toEqual(["SELECT 1", "SELECT 2"]);
  });
});

describe("a .ts step", () => {
  it("is compiled by the migrations build into dist/ and loads as a data step", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-steps-build-"));
    mkdirSync(join(root, "migrations", "mysql"), { recursive: true });
    copyFileSync(join(STEPS_DIR, "..", "step.d.ts"), join(root, "migrations", "step.d.ts"));
    writeFileSync(join(root, "migrations", "mysql", "0012-sample.ts"), SAMPLE_TS_STEP);
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    // The repo's migrations build, pointed at this throwaway tree.
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        extends: join(process.cwd(), "tsconfig.migrations.json"),
        compilerOptions: { rootDir: ".", outDir: "dist", types: [] },
        include: ["migrations/**/*.ts"],
      }),
    );
    execFileSync(join(process.cwd(), "node_modules", ".bin", "tsc"), ["-p", join(root, "tsconfig.json")], { stdio: "pipe" });
    const compiled = compiledStepPath(join(root, "migrations", "mysql"), "0012-sample.ts");
    expect(compiled).toBe(join(root, "dist", "migrations", "mysql", "0012-sample.js"));
    expect(existsSync(compiled)).toBe(true);
    const mod = (await import(pathToFileURL(compiled).href)) as { default: unknown };
    expect(isDataStep(mod.default)).toBe(true);
  }, 60_000);

  it("isDataStep accepts { plan, apply } and rejects anything else", () => {
    expect(isDataStep({ plan: async () => [], apply: async () => undefined })).toBe(true);
    expect(isDataStep({ apply: async () => undefined })).toBe(false);
    expect(isDataStep(null)).toBe(false);
  });

  it("the repo's tsconfig.migrations.json emits migrations/ into dist/", async () => {
    const { readFile } = await import("node:fs/promises");
    const cfg = JSON.parse(await readFile(join(process.cwd(), "tsconfig.migrations.json"), "utf8")) as {
      compilerOptions: { rootDir: string; outDir: string };
      include: string[];
    };
    expect(cfg.compilerOptions).toMatchObject({ rootDir: ".", outDir: "dist" });
    expect(cfg.include).toContain("migrations/**/*.ts");
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toContain("tsc -p tsconfig.migrations.json");
    expect(pkg.scripts.migrate).toContain("dist/main.js migrate");
  });
});

const SAMPLE_TS_STEP = `import type { DataStep } from "../step.js";

const step: DataStep = {
  async plan(db) {
    return db.all("SELECT name FROM cursors WHERE value = ?", ["old"]);
  },
  async apply(db) {
    await db.run("UPDATE cursors SET value = ? WHERE value = ?", ["new", "old"]);
  },
};

export default step;
`;

function stepsDir(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "sf-steps-")), "migrations", "mysql");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

/** A fake MySQL connection: a recorded state, the tables that exist, and the owner/name rows per table. */
function fakeDb(o: { state: number | null; tables?: string[]; legacy?: Record<string, number> }) {
  const sql: string[] = [];
  const tables = o.tables ?? ["schema_state", "work_items", "unreviewed_merges", "cursors"];
  return {
    sql,
    async query(q: string): Promise<[unknown, unknown]> {
      sql.push(q);
      if (q.includes("information_schema.tables")) return [tables.map((name) => ({ name })), null];
      if (q.startsWith("SELECT state FROM schema_state")) return [o.state === null ? [] : [{ state: o.state }], null];
      const m = /FROM (\w+) WHERE project NOT LIKE/.exec(q);
      if (m) return [[{ n: o.legacy?.[m[1]!] ?? 0 }], null];
      throw new Error(`unexpected query ${q}`);
    },
  };
}

describe("migrate --status --json (the updater's check)", () => {
  it("lists the schema state and the pending step names; the project-key step is not counted while schema steps are pending", async () => {
    const dir = stepsDir({ "0012-a.sql": "SELECT 1;", "0013-b.ts": "export default {}" });
    const db = fakeDb({ state: 11, legacy: { work_items: 3 } });
    const check = await mysqlMigrationCheck(db, { dir });
    expect(check).toEqual({
      store: "mysql",
      schema_state: 11,
      latest: 13,
      schema_pending: ["0012-a.sql", "0013-b.ts"],
      refusal: null,
      project_keys: "after schema steps",
      project_key_rows: null,
      pending: ["0012-a.sql", "0013-b.ts"],
    });
    expect(db.sql.some((q) => q.includes("COUNT(*)"))).toBe(false);
    expect(JSON.parse(JSON.stringify(check))).toEqual(check); // one JSON line
  });

  it("with the schema current, owner/name rows left are the pending project-keys step", async () => {
    const dir = stepsDir({ "0012-a.sql": "SELECT 1;" });
    expect(await mysqlMigrationCheck(fakeDb({ state: 12, legacy: { work_items: 2, unreviewed_merges: 1 } }), { dir })).toMatchObject({
      schema_pending: [],
      project_keys: "pending",
      project_key_rows: 3,
      pending: ["project-keys"],
    });
    expect(await mysqlMigrationCheck(fakeDb({ state: 12 }), { dir })).toMatchObject({ project_keys: "done", project_key_rows: 0, pending: [] });
  });

  it("a database ahead of the code has nothing pending (the store opens it)", async () => {
    const dir = stepsDir({ "0012-a.sql": "SELECT 1;" });
    expect(await mysqlMigrationCheck(fakeDb({ state: 14 }), { dir })).toMatchObject({ pending: [], refusal: expect.stringContaining("ahead") });
  });

  it("SQLite has no schema steps: only the project-key rows count", () => {
    expect(migrationCheck("sqlite", null, 0)).toMatchObject({ schema_state: null, latest: null, schema_pending: [], project_keys: "done", pending: [] });
    expect(migrationCheck("sqlite", null, 4)).toMatchObject({ project_keys: "pending", project_key_rows: 4, pending: ["project-keys"] });
  });

  it("the store's pending-steps error carries the stable code, not only the text", () => {
    const err = migrationPendingError("1 schema step pending (state 11, latest 12): run `npm run migrate`");
    expect(err.code).toBe(MIGRATION_PENDING_CODE);
    expect(MIGRATION_PENDING_CODE).toBe("migration_pending");
  });
});
