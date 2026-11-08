import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { REPO, TABLE_PREFIXES, codeOnly, componentOf, ratchet, read, sourceFiles } from "./lib.js";

// RFC 0015 §9 table-ownership: every table carries its owner's prefix, and a component's SQL names only
// tables with its own prefix. Today's unprefixed tables are listed and leave the list as they are renamed (M1).

const PREFIXES = Object.keys(TABLE_PREFIXES);

function tables(): string[] {
  const sql = readFileSync(join(REPO, "schema", "sqlite.sql"), "utf8");
  return [...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]!);
}

describe("table-ownership", () => {
  it("every table has its owner's prefix (ratchet)", () => {
    ratchet("table-ownership", tables().filter((t) => !PREFIXES.some((p) => t.startsWith(p))).map((t) => `unprefixed|schema/sqlite.sql|${t}`));
  });

  it("component code names only its own tables (ratchet)", () => {
    const known = new Set(tables());
    const found: string[] = [];
    for (const file of sourceFiles()) {
      const own = componentOf(file);
      if (!own || own === "shared" || own === "state") continue;
      const text = codeOnly(read(file));
      for (const m of text.matchAll(/\b([a-z]+_[a-z0-9_]+)\b/g)) {
        const name = m[1]!;
        if (!known.has(name)) continue;
        const prefix = PREFIXES.find((p) => name.startsWith(p));
        if (prefix && TABLE_PREFIXES[prefix] !== own) found.push(`foreign-table|${file}|${name}`);
      }
    }
    ratchet("table-ownership-sql", found);
  });
});
