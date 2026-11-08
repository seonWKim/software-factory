import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { type MigrationDescriptor, migrationSpecProblems } from "../../src/state/index.js";
import { SRC, sourceFiles } from "./lib.js";

// RFC 0015 §9 migration-safety: a breaking migration names its tables and verifies itself; a DROP happens
// only in a contract migration, and only of tables it names (so the runner archives them first, D4).

const DROP = /\bDROP\s+(?:TABLE|COLUMN)\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)/gi;

/** Problems in one migration: its declared spec, and the DROPs in its source text. */
export function safetyProblems(file: string, text: string, m: MigrationDescriptor): string[] {
  const out = migrationSpecProblems(m).map((p) => `${file}: ${p}`);
  for (const [, name] of text.matchAll(DROP)) {
    if (m.change !== "contract") out.push(`${file}: DROP ${name} outside a contract migration`);
    else if (!m.tables.includes(name!)) out.push(`${file}: drops ${name}, which its tables list does not name (so it is not archived)`);
  }
  return out;
}

describe("migration-safety", () => {
  it("every migration in src/ is safe", async () => {
    const problems: string[] = [];
    for (const file of sourceFiles().filter((f) => f.endsWith(".migration.ts"))) {
      const full = join(SRC, file);
      const m = ((await import(pathToFileURL(full).href)) as { default: MigrationDescriptor }).default;
      problems.push(...safetyProblems(file, readFileSync(full, "utf8"), m));
    }
    expect(problems).toEqual([]);
  });

  it("flags a DROP in a breaking migration, an unnamed drop in a contract, a breaking one with no verify, a contract with no after", () => {
    const up = async () => {};
    const verify = async () => [];
    expect(safetyProblems("a", "DROP TABLE x", { kind: "migration", change: "breaking", tables: ["x"], up, verify })).toEqual(["a: DROP x outside a contract migration"]);
    expect(safetyProblems("b", "DROP TABLE IF EXISTS `y`", { kind: "migration", change: "contract", tables: ["x"], after: ["m"], up })).toEqual([
      "b: drops y, which its tables list does not name (so it is not archived)",
    ]);
    expect(safetyProblems("c", "", { kind: "migration", change: "breaking", tables: ["x"], up })).toEqual(["c: a breaking migration needs verify"]);
    expect(safetyProblems("d", "", { kind: "migration", change: "contract", tables: [], after: ["m"], up })).toEqual(["d: a contract migration must name the tables it changes"]);
    // With no `after`, nothing holds it until the breaking migration's down path (D9) has had its time.
    expect(safetyProblems("e", "", { kind: "migration", change: "contract", tables: ["x"], up })).toEqual([
      "e: a contract migration must name the migrations it follows (after)",
    ]);
  });
});
