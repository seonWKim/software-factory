import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO, TABLE_PREFIXES, codeOnly, componentOf, ratchet, read, sourceFiles } from "./lib.js";

// RFC 0015 §9 table-ownership: every table carries its owner's prefix, and a component's SQL names only
// tables with its own prefix. Today's unprefixed tables are listed and leave the list as they are renamed (M1).
// The component-SQL check is a hard rule: it expects no foreign table and reads no known-violations list.

const PREFIXES = Object.keys(TABLE_PREFIXES);

function tables(): string[] {
  const sql = readFileSync(join(REPO, "schema", "sqlite.sql"), "utf8");
  return [...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]!);
}

describe("table-ownership", () => {
  it("every table has its owner's prefix (ratchet)", () => {
    ratchet("table-ownership", tables().filter((t) => !PREFIXES.some((p) => t.startsWith(p))).map((t) => `unprefixed|schema/sqlite.sql|${t}`));
  });

  it("component code names only its own tables (hard rule)", () => {
    expect(foreignTables()).toEqual([]);
  });

  it("a component naming another component's table is a violation", () => {
    const table = tables().find((t) => t.startsWith("bus_"))!;
    expect(foreignTables([["worker/x.ts", `db.run("DELETE FROM ${table}");\n`]])).toEqual([`foreign-table|worker/x.ts|${table}`]);
  });
});

function foreignTables(files: Iterable<readonly [string, string]> = sourceFiles().map((f) => [f, read(f)] as const)): string[] {
  const known = new Set(tables());
  const found: string[] = [];
  for (const [file, text] of files) {
    const own = componentOf(file);
    if (!own || own === "shared" || own === "state") continue;
    for (const m of codeOnly(text).matchAll(/\b([a-z]+_[a-z0-9_]+)\b/g)) {
      const name = m[1]!;
      if (!known.has(name)) continue;
      const prefix = PREFIXES.find((p) => name.startsWith(p));
      if (prefix && TABLE_PREFIXES[prefix] !== own) found.push(`foreign-table|${file}|${name}`);
    }
  }
  return found;
}
