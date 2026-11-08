import { describe, expect, it } from "vitest";
import { componentOf, sourceFiles } from "./lib.js";

// RFC 0015 §9 migration-naming: `<yyyymmddThhmm>-<component>-<slug>.migration.ts` in its component's folder,
// no duplicate timestamps. The frozen numbered lists (SQLite schema.ts, migrations/mysql/) stay as the baseline.

const NAME = /^(\d{8}T\d{4})-([a-z]+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.migration\.ts$/;

describe("migration-naming", () => {
  it("each migration is named by timestamp and component, and lives in that component", () => {
    const bad: string[] = [];
    const stamps = new Map<string, string>();
    for (const file of sourceFiles().filter((f) => f.endsWith(".migration.ts"))) {
      const m = NAME.exec(file.split("/").pop()!);
      if (!m) {
        bad.push(`${file}: expected <yyyymmddThhmm>-<component>-<slug>.migration.ts`);
        continue;
      }
      if (componentOf(file) !== m[2]) bad.push(`${file}: names component ${m[2]} but lives in ${componentOf(file) ?? "a legacy folder"}`);
      const seen = stamps.get(m[1]!);
      if (seen) bad.push(`${file}: timestamp ${m[1]} is also used by ${seen}`);
      stamps.set(m[1]!, file);
    }
    expect(bad).toEqual([]);
  });
});
