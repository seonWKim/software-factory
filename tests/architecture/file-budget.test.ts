import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RatchetOptions, ratchetCounts, read, sourceFiles } from "./lib.js";

// RFC 0015 §9 file-budget: no src/ file over BUDGET lines; files over it are listed with their line count,
// which may only fall. It was 60,000 for the refactor (the owner's 100× raise); M11 set it back to 600 and
// relisted the files then over it (2026-11-09).
// The counts are kept in one list per folder, known-violations/file-budget-<folder with / as ->.json (files
// directly under src/ in file-budget-src.json), so items that touch files in different folders edit different
// lists and stop conflicting on one (issue #824).

const BUDGET = 600;
const KNOWN = join(import.meta.dirname, "known-violations");
const PREFIX = "file-budget-";

/** The ratchet name of the list that holds a src/-relative file: file-budget-<folder with / as ->. */
function budgetList(file: string): string {
  const folder = posix.dirname(file.split("\\").join("/"));
  return PREFIX + (folder === "." ? "src" : folder.split("/").join("-"));
}

/**
 * Checks the over-budget files against their folder lists, and every other file-budget-*.json list in the
 * directory against no files, so a list whose files all fell under the budget still fails until lowered.
 */
function ratchetFileBudget(over: Readonly<Record<string, number>>, o: RatchetOptions = {}): void {
  const groups = new Map<string, Record<string, number>>();
  for (const [file, lines] of Object.entries(over)) {
    const list = budgetList(file);
    groups.set(list, { ...groups.get(list), [file]: lines });
  }
  const dir = o.dir ?? KNOWN;
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const list = f.endsWith(".json") && f.startsWith(PREFIX) ? f.slice(0, -".json".length) : undefined;
    if (list && !groups.has(list)) groups.set(list, {});
  }
  for (const [list, found] of [...groups].sort(([a], [b]) => a.localeCompare(b))) ratchetCounts(list, found, o);
}

describe("file-budget", () => {
  it(`no src/ file grows past ${BUDGET} lines (ratchet)`, () => {
    const over: Record<string, number> = {};
    for (const file of sourceFiles()) {
      const lines = read(file).split("\n").length;
      if (lines > BUDGET) over[file] = lines;
    }
    ratchetFileBudget(over);
  });
});

describe("file-budget lists per folder", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function lists(content: Record<string, Record<string, number>>): string {
    dir = mkdtempSync(join(tmpdir(), "file-budget-"));
    for (const [name, v] of Object.entries(content)) writeFileSync(join(dir, `${name}.json`), JSON.stringify(v));
    return dir;
  }
  const listed = (name: string): unknown => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));

  it("names a list by folder, with src for files directly under src/", () => {
    expect(budgetList("golden.ts")).toBe("file-budget-src");
    expect(budgetList("core/settings.ts")).toBe("file-budget-core");
    expect(budgetList("impl/store/sql/sql-factory-store.ts")).toBe("file-budget-impl-store-sql");
  });

  it("passes when each folder's files match their list", () => {
    const d = lists({ "file-budget-core": { "core/a.ts": 700 }, "file-budget-src": { "b.ts": 650 } });
    expect(() => ratchetFileBudget({ "core/a.ts": 700, "b.ts": 650 }, { dir: d, env: {} })).not.toThrow();
  });

  it("fails when an over-budget file grows past its listed count, or a new file goes over", () => {
    const d = lists({ "file-budget-core": { "core/a.ts": 700 } });
    expect(() => ratchetFileBudget({ "core/a.ts": 701 }, { dir: d, env: {} })).toThrow();
    expect(() => ratchetFileBudget({ "core/a.ts": 700, "x/new.ts": 601 }, { dir: d, env: {} })).toThrow();
  });

  it("fails when a listed count falls and is not lowered", () => {
    const d = lists({ "file-budget-core": { "core/a.ts": 700, "core/b.ts": 800 } });
    expect(() => ratchetFileBudget({ "core/a.ts": 690, "core/b.ts": 800 }, { dir: d, env: {} })).toThrow();
  });

  it("checks a list whose files all fell under the budget", () => {
    const d = lists({ "file-budget-core": { "core/a.ts": 700 }, "file-budget-worker": { "worker/r.ts": 900 } });
    expect(() => ratchetFileBudget({ "core/a.ts": 700 }, { dir: d, env: {} })).toThrow();
  });

  it("shrink mode lowers a fallen count in its own list and never raises one", () => {
    const d = lists({
      "file-budget-core": { "core/a.ts": 700, "core/b.ts": 800 },
      "file-budget-src": { "g.ts": 650 },
      "file-budget-worker": { "worker/r.ts": 900 },
      "other": { "core/a.ts": 1 },
    });
    const env = { SF_RATCHET_SHRINK: "1" };
    ratchetFileBudget({ "core/a.ts": 650, "core/b.ts": 800, "g.ts": 650 }, { dir: d, env });
    expect(listed("file-budget-core")).toEqual({ "core/a.ts": 650, "core/b.ts": 800 });
    expect(listed("file-budget-src")).toEqual({ "g.ts": 650 });
    expect(listed("file-budget-worker")).toEqual({});
    expect(listed("other")).toEqual({ "core/a.ts": 1 });
    expect(() => ratchetFileBudget({ "core/a.ts": 651, "core/b.ts": 800, "g.ts": 650 }, { dir: d, env })).toThrow();
    expect(listed("file-budget-core")).toEqual({ "core/a.ts": 650, "core/b.ts": 800 });
  });
});
