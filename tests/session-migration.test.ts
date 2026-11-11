import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INLINE_STEPS, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";

// Interactive sessions (design §5, 2026-11-01, issue #112): the run's actor, transcript and token columns.
describe("migration step 18: run session columns", () => {
  it("is the repo's step after 17 on MySQL, and SQLite migration 18, adding the same three columns", () => {
    const step = readSteps(STEPS_DIR, INLINE_STEPS).find((s) => s.name === "run-session")!;
    expect(step).toMatchObject({ number: 18, from: 17, kind: "sql", file: "0018-run-session.sql" });
    for (const sql of [readFileSync(join(STEPS_DIR, step.file), "utf8"), MIGRATIONS[17]!]) {
      for (const col of ["actor_id", "transcript_url", "session_tokens"]) expect(sql).toContain(col);
    }
  });
});
