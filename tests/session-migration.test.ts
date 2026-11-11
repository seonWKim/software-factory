import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";

// Interactive sessions (design §5, 2026-11-01, issue #112): the run's actor, transcript and token columns.
describe("migration step 18: run session columns", () => {
  it("SQLite migration 18 adds the three columns", () => {
    for (const col of ["actor_id", "transcript_url", "session_tokens"]) expect(MIGRATIONS[17]!).toContain(col);
  });
});
