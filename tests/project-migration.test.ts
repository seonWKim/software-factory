import { describe, expect, it } from "vitest";
import type { ProjectRef } from "../src/core/project.js";
import { projectLabelCursor } from "../src/core/project.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { MysqlMigrations } from "../src/impl/store/mysql/migrations.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import {
  PROJECT_TABLES, type ProjectKeyDb, type ResolveRepo, applyProjectKeys, countLegacyProjectRows, planProjectKeys, runProjectKeyStep,
} from "../src/impl/store/project-keys.js";
import type { SqlDriver } from "../src/impl/store/sql/driver.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { MYSQL_URL, issue, newEmptyMysqlDatabase, system } from "./helpers/store.js";

// The project-key data step of `npm run migrate` (design 2026-11-01): owner/name → github:<host>:<node id> in
// every table with a project column. Runs on SQLite always, and on MySQL when SF_TEST_MYSQL_URL is set.

const KEYS: Record<string, ProjectRef> = {
  "o/r": { key: "github:github.com:R_kgDOrepo1", label: "github.com/o/r" },
  "x/y": { key: "github:github.com:R_kgDOrepo2", label: "github.com/x/y-renamed" },
};

/** Resolves through a fake GitHub: KEYS, and anything else fails as a 404 would. Records each call. */
function resolver(fail: readonly string[] = []) {
  const calls: string[] = [];
  const resolve: ResolveRepo = async (ownerName) => {
    calls.push(ownerName);
    const ref = KEYS[ownerName];
    if (!ref || fail.includes(ownerName)) throw new Error("GitHub GET /repos/" + ownerName + " → 404 Not Found");
    return ref;
  };
  return { calls, resolve, factory: async () => resolve };
}

interface Backend {
  name: string;
  open(): Promise<{ driver: SqlDriver & ProjectKeyDb; reopen: () => SqlFactoryStore; projectColumns: () => Promise<string[]> }>;
}

const sqlite: Backend = {
  name: "sqlite",
  async open() {
    const driver = new SqliteDriver(":memory:");
    await driver.migrate();
    return {
      driver,
      reopen: () => new SqlFactoryStore(driver, new FakeClock()),
      projectColumns: async () => {
        const tables = (await driver.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => String(r.name));
        const out: string[] = [];
        for (const t of tables) if ((await driver.all(`PRAGMA table_info(${t})`)).some((c) => c.name === "project")) out.push(t);
        return out.sort();
      },
    };
  },
};

const mysqlBackend: Backend = {
  name: "mysql",
  async open() {
    const db = await newEmptyMysqlDatabase();
    await new MysqlMigrations(await db.connect()).apply(() => undefined);
    const driver = new MysqlDriver(db.options);
    db.onCleanup(() => driver.close());
    return {
      driver,
      reopen: () => new SqlFactoryStore(driver, new FakeClock()),
      projectColumns: async () =>
        (await driver.all("SELECT table_name AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'project'"))
          .map((r) => String(r.t))
          .sort(),
    };
  },
};

const BACKENDS = [sqlite, ...(MYSQL_URL ? [mysqlBackend] : [])];

/** Rows as a pre-change database holds them: written with keys, then set back to owner/name directly. */
async function seedLegacy(b: Backend) {
  const opened = await b.open();
  const { driver } = opened;
  const store = new SqlFactoryStore(driver, new FakeClock());
  const a = await store.createWorkItem({ ...issue(1), project: KEYS["o/r"]!.key }, system);
  const c = await store.createWorkItem({ ...issue(2), project: KEYS["o/r"]!.key }, system);
  const d = await store.createWorkItem({ ...issue(3), project: KEYS["x/y"]!.key }, system);
  await store.recordUnreviewedMerge({ project: KEYS["o/r"]!.key, pr_number: 9, merge_sha: "m9", merger_id: null });
  for (const [ownerName, ref] of Object.entries(KEYS)) {
    for (const t of PROJECT_TABLES) await driver.run(`UPDATE ${t} SET project = ? WHERE project = ?`, [ownerName, ref.key]);
  }
  const snapshot = async () => ({
    work_items: await driver.all("SELECT * FROM work_items ORDER BY id"),
    unreviewed_merges: await driver.all("SELECT * FROM unreviewed_merges ORDER BY id"),
    cursors: await driver.all("SELECT * FROM cursors ORDER BY name"),
  });
  return { ...opened, ids: [a.item.id, c.item.id, d.item.id], snapshot };
}

for (const b of BACKENDS) {
  describe(`project-key migration: ${b.name}`, () => {
    it("PROJECT_TABLES lists every table that has a project column", async () => {
      const { projectColumns } = await b.open();
      expect(await projectColumns()).toEqual([...PROJECT_TABLES].sort());
    });

    it("the store refuses to open while owner/name rows remain, naming npm run migrate", async () => {
      const f = await seedLegacy(b);
      await expect(f.reopen().migrate()).rejects.toThrow(/4 rows still hold an owner\/name project value: run `npm run migrate`/);
    });

    it("--dry-run lists each row it would change and writes nothing", async () => {
      const f = await seedLegacy(b);
      const before = await f.snapshot();
      const lines: string[] = [];
      expect(await runProjectKeyStep(f.driver, resolver().factory, "dry-run", (l) => lines.push(l))).toBe(0);
      expect(await f.snapshot()).toEqual(before);
      expect(await countLegacyProjectRows(f.driver)).toBe(4);
      expect(lines[0]).toBe("-- project keys: 4 rows would change");
      for (const id of f.ids) expect(lines.some((l) => l.includes(id))).toBe(true);
      expect(lines.filter((l) => l.includes('"table":"unreviewed_merges"'))).toHaveLength(1);
      expect(lines.at(-1)).toBe("dry run: nothing was changed");
    });

    it("rewrites owner/name to the key in every project table, stores the labels, and opens again", async () => {
      const f = await seedLegacy(b);
      const lines: string[] = [];
      expect(await runProjectKeyStep(f.driver, resolver().factory, "apply", (l) => lines.push(l))).toBe(0);
      expect(lines.at(-1)).toContain("rewrote 4 rows");
      const projects = (await f.driver.all("SELECT id, project FROM work_items ORDER BY id")).map((r) => [r.id, r.project]);
      expect(projects).toEqual(
        [[f.ids[0], KEYS["o/r"]!.key], [f.ids[1], KEYS["o/r"]!.key], [f.ids[2], KEYS["x/y"]!.key]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
      expect((await f.driver.all("SELECT project FROM unreviewed_merges")).map((r) => r.project)).toEqual([KEYS["o/r"]!.key]);
      const store = f.reopen();
      await store.migrate();
      expect(await store.getCursor(projectLabelCursor(KEYS["x/y"]!.key))).toBe("github.com/x/y-renamed");
      expect((await store.getWorkItem(f.ids[0]!))?.project).toBe(KEYS["o/r"]!.key);
    });

    it("a second run changes no rows and asks GitHub nothing", async () => {
      const f = await seedLegacy(b);
      await runProjectKeyStep(f.driver, resolver().factory, "apply", () => undefined);
      const after = await f.snapshot();
      const r = resolver();
      const lines: string[] = [];
      expect(await runProjectKeyStep(f.driver, r.factory, "apply", (l) => lines.push(l))).toBe(0);
      expect(lines).toEqual(["project keys: nothing to rewrite"]);
      expect(r.calls).toEqual([]);
      expect(await f.snapshot()).toEqual(after);
      // Applying a plan made now changes nothing either.
      expect(await applyProjectKeys(f.driver, await planProjectKeys(f.driver, r.resolve))).toBe(0);
      expect(await f.snapshot()).toEqual(after);
    });

    it("a repo GitHub cannot resolve stops the step with an error naming it, and no row is written", async () => {
      const f = await seedLegacy(b);
      const before = await f.snapshot();
      const lines: string[] = [];
      expect(await runProjectKeyStep(f.driver, resolver(["x/y"]).factory, "apply", (l) => lines.push(l))).toBe(1);
      expect(lines.join("\n")).toMatch(/cannot resolve x\/y to its GitHub repository ID: .*404/);
      expect(await f.snapshot()).toEqual(before);
    });

    it("--status counts the rows left without calling GitHub", async () => {
      const f = await seedLegacy(b);
      const r = resolver();
      const lines: string[] = [];
      expect(await runProjectKeyStep(f.driver, r.factory, "status", (l) => lines.push(l))).toBe(0);
      expect(lines).toEqual(["project keys: 4 rows to rewrite"]);
      expect(r.calls).toEqual([]);
    });
  });
}
