import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverDescriptor } from "../src/import/mcp-servers.js";
import { canonicalJson, descriptionHash } from "../src/packs/pack-entries.store.js";
import { checkPackGrants } from "../src/packs/pack-grants.js";
import type { Timestamp, UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { MIGRATIONS_TABLE, type MigrationDb, type SqlDriver, applyMigrations, discoverMigrations } from "../src/state/index.js";
import CHANGE_REF_ONLY from "../src/controller/migrations/20261112T1200-controller-change-ref-only.migration.js";
import SUB_TASKS from "../src/controller/migrations/20261112T1800-controller-sub-tasks.migration.js";
import TASK_SCHEDULE from "../src/controller/migrations/20261113T0900-controller-task-schedule.migration.js";
import TASK_PROJECTS from "../src/controller/migrations/20261113T1300-controller-task-projects.migration.js";
import { newStore, issue, system, w1, PROJECT_KEY, OTHER_PROJECT_KEY } from "./helpers/store.js";

const LEASE = 60_000;
/** A project label as the cursor `project_label:<key>` stores it, and the PR link the store writes as change_url. */
const LABEL = "github.com/o/r";
const prUrl = (label: string, n: number) => `https://${label}/pull/${n}`;

describe("migration 19 on an existing SQLite database", () => {
  it("adds worker_processes and keeps every earlier row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-mig19-"));
    const path = join(dir, "factory.db");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    for (let v = 1; v <= 18; v++) {
      raw.exec(MIGRATIONS[v - 1]!);
      raw.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
    }
    raw.prepare("INSERT INTO settings_overrides (setting_key, project_key, value_json, set_by, set_at) VALUES (?, ?, ?, ?, ?)").run(
      "workers", "", "2", "local:owner", "2026-01-01T00:00:00.000Z",
    );
    raw.prepare("INSERT INTO cursors (name, value) VALUES (?, ?)").run("poll", "c1");
    raw.close();

    const clock = new FakeClock();
    const store = new SqlFactoryStore(new SqliteDriver(path, { applyBreaking: true }), clock);
    try {
      await store.migrate();
      expect(await store.schemaVersion()).toMatchObject({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
      expect((await store.listSettingOverrides()).map((o) => [o.key, o.value])).toEqual([["workers", "2"]]);
      expect(await store.getCursor("poll")).toBe("c1");
      await store.reportWorkerProcess({
        process_id: "h:1", pid: 1, host: "h", slots: 1, max_slots: 1, busy: 0, index_base: 0, started_at: clock.now().toISOString() as Timestamp,
      });
      expect(await store.listWorkerProcesses(LEASE)).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
});

describe("migration 28 on an existing SQLite database", () => {
  it("adds host_sleeps and keeps every earlier row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-mig28-"));
    const path = join(dir, "factory.db");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    for (let v = 1; v <= 27; v++) {
      raw.exec(MIGRATIONS[v - 1]!);
      raw.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
    }
    raw.prepare("INSERT INTO settings_overrides (setting_key, project_key, value_json, set_by, set_at) VALUES (?, ?, ?, ?, ?)").run(
      "workers", "", "2", "local:owner", "2026-01-01T00:00:00.000Z",
    );
    raw.prepare("INSERT INTO cursors (name, value) VALUES (?, ?)").run("poll", "c1");
    raw.close();

    const clock = new FakeClock();
    const store = new SqlFactoryStore(new SqliteDriver(path, { applyBreaking: true }), clock);
    try {
      await store.migrate();
      expect(await store.schemaVersion()).toMatchObject({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
      expect((await store.listSettingOverrides()).map((o) => [o.key, o.value])).toEqual([["workers", "2"]]);
      expect(await store.getCursor("poll")).toBe("c1");
      const s = { worker_id: w1, woke_at: clock.now().toISOString() as Timestamp, gap_ms: 90_000, run_id: null };
      await store.recordHostSleep(s);
      expect(await store.listHostSleeps({ limit: 10 })).toEqual([s]);
    } finally {
      await store.close();
    }
  });
});

describe("migration 32 on an existing SQLite database", () => {
  it("adds standing_rules and standing_proposals and keeps every earlier row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-mig32-"));
    const path = join(dir, "factory.db");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
    for (let v = 1; v <= 31; v++) {
      raw.exec(MIGRATIONS[v - 1]!);
      raw.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
    }
    raw.prepare("INSERT INTO cursors (name, value) VALUES (?, ?)").run("poll", "c1");
    raw.close();

    const store = new SqlFactoryStore(new SqliteDriver(path, { applyBreaking: true }), new FakeClock());
    try {
      await store.migrate();
      expect(await store.schemaVersion()).toMatchObject({ applied: MIGRATIONS.length, latest: MIGRATIONS.length });
      expect(await store.getCursor("poll")).toBe("c1");
      const { created } = await store.recordStandingProposal({ gate: "spec", tier: 2, run_length: 10, threshold: 10 });
      expect(created).toBe(true);
      expect((await store.putStandingRule({ gate: "spec", tier: 2, enabled: false, set_by: "github:1" as UserId })).enabled).toBe(false);
    } finally {
      await store.close();
    }
  });
});

describe("20261112T1200-controller-change-ref-only on an existing SQLite database", () => {
  const ID = "20261112T1200-controller-change-ref-only";
  const ITEM = "(id, version, source_type, source_id, source_link, requester_id, project, problem, resources, allowed_paths, stage, blocked_on, " +
    "loop_count, restart_count, token_cost, created_at, updated_at, pr_number, change_ref, change_url)";
  const at = "2026-11-01T00:00:00.000Z";
  const cols = (db: DatabaseSync, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));

  /** A file database at the schema just before the migration, with rows in both tables and a child of a work item. */
  async function oldDatabase(): Promise<string> {
    const path = join(mkdtempSync(join(tmpdir(), "sf-change-ref-only-")), "factory.db");
    const driver = new SqliteDriver(path, { baselineOnly: true });
    await driver.migrate();
    const db: MigrationDb = { dialect: "sqlite", all: (sql, p) => driver.all(sql, p), run: (sql, p) => driver.run(sql, p) };
    const before = (await discoverMigrations()).filter((m) => m.id < ID);
    await applyMigrations(db, { backupDir: null, now: () => at, migrations: before });
    expect(cols(new DatabaseSync(path), "controller_work_items")).toContain("pr_number");
    for (const [id, n] of [["wi_a", 5], ["wi_b", null], ["wi_c", 7]] as const) {
      await driver.run(`INSERT INTO controller_work_items ${ITEM} VALUES (?, 1, 'github_issue', ?, 'l', 'github:1', ?, 'p', '[]', '[]', 'REVIEW', 'none', 0, 0, 0, ?, ?, ?, ?, ?)`, [
        id, `o/r#${id}`, PROJECT_KEY, at, at, n, n === null ? null : String(n), n === null ? null : prUrl(LABEL, n),
      ]);
    }
    await driver.run("INSERT INTO controller_state_changes (id, work_item_id, version, at, actor, reason, changes) VALUES ('sc_1', 'wi_a', 1, ?, ?, 'intake', '{}')", [at, JSON.stringify(system)]);
    await driver.run("INSERT INTO controller_unreviewed_merges (id, project, pr_number, change_ref, merge_sha, merger_id, at) VALUES ('um_1', ?, 9, '9', 'm9', NULL, ?)", [PROJECT_KEY, at]);
    await driver.run("INSERT INTO controller_unreviewed_merges (id, project, pr_number, change_ref, merge_sha, merger_id, at) VALUES ('um_2', ?, 9, '9', 'm9b', 'github:2', ?)", [OTHER_PROJECT_KEY, at]);
    await driver.close();
    return path;
  }

  it("is breaking, names both tables, and verifies itself", () => {
    expect(CHANGE_REF_ONLY).toMatchObject({ change: "breaking", tables: expect.arrayContaining(["controller_work_items", "controller_unreviewed_merges"]) });
    expect(CHANGE_REF_ONLY.verify).toBeTypeOf("function");
  });

  it("rebuilds both tables without pr_number, keeping every row, the indexes, the unique key and the children's foreign keys", async () => {
    const path = await oldDatabase();
    const store = new SqlFactoryStore(new SqliteDriver(path, { applyBreaking: true }), new FakeClock());
    try {
      await store.migrate();
    } finally {
      await store.close();
    }
    const db = new DatabaseSync(path);
    try {
      for (const t of ["controller_work_items", "controller_unreviewed_merges"]) {
        expect(cols(db, t)).not.toContain("pr_number");
        expect(cols(db, `legacy_${t}`)).toContain("pr_number");
        // A column a later migration added (controller_work_items.done_checks) is only on the new table.
        const kept = cols(db, t).filter((c) => cols(db, `legacy_${t}`).includes(c)).join(", ");
        // Every row, every value, in both the new table and its legacy copy.
        expect(rows(db, `SELECT ${kept} FROM ${t} ORDER BY id`)).toEqual(rows(db, `SELECT ${kept} FROM legacy_${t} ORDER BY id`));
      }
      expect(rows(db, "SELECT id, change_ref, change_url FROM controller_work_items ORDER BY id")).toEqual([
        { id: "wi_a", change_ref: "5", change_url: prUrl(LABEL, 5) },
        { id: "wi_b", change_ref: null, change_url: null },
        { id: "wi_c", change_ref: "7", change_url: prUrl(LABEL, 7) },
      ]);
      expect(rows(db, "SELECT id, project, change_ref, merge_sha, merger_id, at FROM controller_unreviewed_merges ORDER BY id")).toEqual([
        { id: "um_1", project: PROJECT_KEY, change_ref: "9", merge_sha: "m9", merger_id: null, at },
        { id: "um_2", project: OTHER_PROJECT_KEY, change_ref: "9", merge_sha: "m9b", merger_id: "github:2", at },
      ]);
      // New index names on the new tables; the legacy tables keep the old ones.
      const indexes = (t: string) => rows(db, `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${t}' AND sql IS NOT NULL`);
      expect(indexes("controller_work_items")).toEqual(expect.arrayContaining([
        { name: "controller_work_items_by_change", sql: expect.stringMatching(/\(project, change_ref\)$/) },
        { name: "controller_work_items_by_merge_sha", sql: expect.stringMatching(/\(merge_sha\)$/) },
      ]));
      expect(indexes("controller_unreviewed_merges")).toEqual(expect.arrayContaining([
        { name: "controller_unreviewed_merges_by_change", sql: expect.stringMatching(/^CREATE UNIQUE INDEX .*\(project, change_ref\)$/) },
        { name: "controller_unreviewed_merges_by_at", sql: expect.stringMatching(/\(at\)$/) },
      ]));
      expect(indexes("legacy_controller_work_items").map((i) => i.name)).toContain("controller_work_items_change");
      expect(() => db.prepare("INSERT INTO controller_unreviewed_merges (id, project, change_ref, merge_sha, at) VALUES ('um_3', ?, '9', 'x', ?)").run(PROJECT_KEY, at)).toThrow(/UNIQUE/);
      // The work item's children point to the new table, not its legacy copy.
      expect(rows(db, "SELECT \"table\" AS t FROM pragma_foreign_key_list('controller_state_changes')")).toEqual([{ t: "controller_work_items" }]);
      expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }

    // The store reads and writes the rebuilt tables: lookups by change_ref, an intake with its state change, a merge.
    const after = new SqlFactoryStore(new SqliteDriver(path), new FakeClock());
    try {
      await after.migrate();
      expect((await after.getWorkItemByPr(PROJECT_KEY, "5"))!.id).toBe("wi_a");
      expect(await after.listStateChanges("wi_a" as WorkItemId)).toHaveLength(1);
      const { item } = await after.createWorkItem(issue(40), system);
      expect(await after.listStateChanges(item.id)).toHaveLength(1);
      expect(await after.recordUnreviewedMerge({ project: PROJECT_KEY, change_ref: "9", merge_sha: "x", merger_id: null })).toMatchObject({ created: false, merge: { id: "um_1" } });
    } finally {
      await after.close();
    }
  });
});

describe("migration 40 (sync leases, forge budget, thread actor)", () => {
  /** Found by what it creates, so a renumber at merge needs no edit. */
  const STEP = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS sync_leases")) + 1;

  it("SQLite: adds both tables and the actor column to an existing database, keeping its thread entries", async () => {
    expect(STEP).toBeGreaterThan(0);
    const raw = new DatabaseSync(":memory:");
    for (const m of MIGRATIONS.slice(0, STEP - 1)) raw.exec(m);
    // Only the thread row matters here: no work item row is built for it.
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("INSERT INTO item_thread (work_item_id, marker, body, created_at) VALUES ('wi_1', 'm', 'b', 't')");
    raw.exec(MIGRATIONS[STEP - 1]!);
    expect(raw.prepare("SELECT marker, actor FROM item_thread").all().map((r) => ({ ...r }))).toEqual([{ marker: "m", actor: null }]);
    const cols = (t: string) => (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name).sort();
    expect(cols("sync_leases")).toEqual(["expires_at", "name", "owner", "token"]);
    expect(cols("forge_budget")).toEqual(["limit", "plugin", "project_key", "remaining", "reset_at", "updated_at"]);
    expect(cols("item_thread")).toContain("actor");
    raw.close();
  });

});

describe("20261112T1800-controller-sub-tasks on an existing SQLite database", () => {
  const ID = "20261112T1800-controller-sub-tasks";
  const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

  it("adds the nullable, indexed parent_task_id, backfills nothing, keeps parent_id unique and is safe to rerun", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("DROP INDEX controller_tasks_sub_tasks");
    await db.run("ALTER TABLE controller_tasks DROP COLUMN parent_task_id");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    await db.run(
      "INSERT INTO controller_tasks (id, title, created_by, created_at, parent_id) VALUES ('tk_old', 'old', 'u', '2026-01-01T00:00:00.000Z', NULL)",
    );
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(await db.all("SELECT id, parent_id, parent_task_id FROM controller_tasks")).toEqual([{ id: "tk_old", parent_id: null, parent_task_id: null }]);
    expect(await db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'controller_tasks_sub_tasks'")).toEqual([{ name: "controller_tasks_sub_tasks" }]);
    expect(SUB_TASKS).toMatchObject({ change: "additive" });
    await SUB_TASKS.up(mdb(db));
    expect(await db.all("SELECT id, parent_task_id FROM controller_tasks")).toEqual([{ id: "tk_old", parent_task_id: null }]);
    // parent_id keeps its recurrence meaning and its unique key.
    await db.run("UPDATE controller_tasks SET parent_id = 'tk_x'");
    await expect(
      db.run("INSERT INTO controller_tasks (id, title, created_by, created_at, parent_id) VALUES ('tk_2', 't', 'u', 'x', 'tk_x')"),
    ).rejects.toThrow();
  });
});

describe("20261113T1300-controller-task-projects on an existing SQLite database", () => {
  const ID = "20261113T1300-controller-task-projects";
  const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });
  const projectTables = (db: SqlDriver) =>
    db.all("SELECT type, name FROM sqlite_master WHERE tbl_name IN ('controller_projects', 'controller_task_projects') ORDER BY type, name");

  it("adds both tables and the membership index, writes no row on a store with tasks, and is safe to rerun", async () => {
    const { store } = await newStore();
    const db = store.db;
    const created = await projectTables(db);
    expect(created).toEqual(expect.arrayContaining([
      { type: "index", name: "controller_task_projects_project" },
      { type: "table", name: "controller_projects" },
      { type: "table", name: "controller_task_projects" },
    ]));
    await db.run("DROP TABLE controller_task_projects");
    await db.run("DROP TABLE controller_projects");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    await db.run("INSERT INTO controller_tasks (id, title, list, created_by, created_at) VALUES ('tk_old', 'old', 'home', 'u', '2026-01-01T00:00:00.000Z')");
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(await projectTables(db)).toEqual(created);
    expect(await db.all("SELECT * FROM controller_projects")).toEqual([]);
    expect(await db.all("SELECT * FROM controller_task_projects")).toEqual([]);
    expect(TASK_PROJECTS).toMatchObject({ change: "additive" });
    await TASK_PROJECTS.up(mdb(db));
    expect(await projectTables(db)).toEqual(created);
    expect(await db.all("SELECT * FROM controller_projects")).toEqual([]);
    expect(await db.all("SELECT * FROM controller_task_projects")).toEqual([]);
    expect(await db.all("SELECT id, list FROM controller_tasks")).toEqual([{ id: "tk_old", list: "home" }]);
  });
});

describe("20261113T0900-controller-task-schedule on an existing SQLite database", () => {
  const ID = "20261113T0900-controller-task-schedule";
  const mdb = (db: SqlDriver): MigrationDb => ({ dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) });

  it("adds the nullable duration_minutes and reminded_at, backfills nothing and is safe to rerun", async () => {
    const { store } = await newStore();
    const db = store.db;
    await db.run("ALTER TABLE controller_tasks DROP COLUMN duration_minutes");
    await db.run("ALTER TABLE controller_tasks DROP COLUMN reminded_at");
    await db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID]);
    await db.run(
      "INSERT INTO controller_tasks (id, title, created_by, created_at, due_date, due_time) VALUES ('tk_old', 'old', 'u', '2026-01-01T00:00:00.000Z', '2026-01-02', '09:00')",
    );
    await store.migrate();
    expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [ID])).toEqual([{ id: ID }]);
    expect(await db.all("SELECT id, due_time, duration_minutes, reminded_at FROM controller_tasks")).toEqual([
      { id: "tk_old", due_time: "09:00", duration_minutes: null, reminded_at: null },
    ]);
    expect(TASK_SCHEDULE).toMatchObject({ change: "additive" });
    await TASK_SCHEDULE.up(mdb(db));
    expect(await db.all("SELECT id, duration_minutes, reminded_at FROM controller_tasks")).toEqual([{ id: "tk_old", duration_minutes: null, reminded_at: null }]);
    expect(await store.getTask("tk_old")).toMatchObject({ duration_minutes: null, reminded_at: null });
  });
});

describe("20261116T1300 and 20261116T1310: the plugin import's pointer tables on an existing SQLite database", () => {
  const POINTERS = "20261116T1300-state-ext-packs-entries-pointers";
  const BY_PATH = "20261116T1310-state-ext-skill-refs-by-path";
  const at = "2026-11-15T00:00:00.000Z";
  const later = "2026-11-15T01:00:00.000Z";
  const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));
  const cols = (db: DatabaseSync, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  const ENTRY = "(id, kind, name, description_hash, module_hash, descriptor, credential_name, status, added_by, created_at, updated_at)";
  const ME = "local:me@example.com";

  afterEach(() => vi.unstubAllEnvs());

  /** A copied descriptor as the old import stored it, and its hash. */
  const copied = (source: string, key: string, raw: Record<string, unknown>) => {
    const d = serverDescriptor(source, key, raw);
    return { text: canonicalJson(d), hash: descriptionHash(d) };
  };

  /**
   * A HOME whose ~/.claude.json still holds `docs` unchanged and whose ~/.codex/config.toml holds `notes` changed;
   * `gone` is in neither. A file database just before the two migrations, with a pack tool, the three copied servers
   * (docs twice: an older and the current description) and skill refs (one path imported twice), and an approval.
   */
  async function oldDatabase() {
    const home = mkdtempSync(join(tmpdir(), "sf-pointer-home-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { docs: { command: "docs-mcp", env: { DOCS_TOKEN: "v" } } } }));
    writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.notes]\ncommand = "notes-v2"\n`);
    vi.stubEnv("HOME", home);
    const path = join(mkdtempSync(join(tmpdir(), "sf-pointers-")), "factory.db");
    const driver = new SqliteDriver(path, { baselineOnly: true });
    await driver.migrate();
    const db: MigrationDb = { dialect: "sqlite", all: (sql, p) => driver.all(sql, p), run: (sql, p) => driver.run(sql, p) };
    await applyMigrations(db, { backupDir: null, now: () => at, migrations: (await discoverMigrations()).filter((m) => m.id < POINTERS) });
    const docsOld = copied("claude", "docs", { command: "docs-mcp-v0" });
    const docs = copied("claude", "docs", { command: "docs-mcp", env: { DOCS_TOKEN: "v" } });
    const notes = copied("codex", "notes", { command: "notes" });
    const gone = copied("claude", "gone", { command: "gone" });
    const tool = { text: canonicalJson({ name: "tracker", description: "Reads issues." }), hash: "h-tool" };
    const insert = (id: string, kind: string, name: string, e: { text: string; hash: string }, created: string) =>
      driver.run(`INSERT INTO ext_packs_entries ${ENTRY} VALUES (?, ?, ?, ?, NULL, ?, NULL, 'pending', ?, ?, ?)`, [id, kind, name, e.hash, e.text, ME, created, created]);
    await insert("pe_tool", "tool", "tracker", tool, at);
    await insert("pe_docs_old", "mcp_server", "docs", docsOld, at);
    await insert("pe_docs", "mcp_server", "docs", docs, later);
    await insert("pe_notes", "mcp_server", "notes", notes, at);
    await insert("pe_gone", "mcp_server", "gone", gone, at);
    await driver.run("INSERT INTO ext_packs_approvals (kind, name, description_hash, action, user_id, at) VALUES ('mcp_server', 'docs', ?, 'approve', ?, ?)", [docs.hash, ME, at]);
    await driver.run("INSERT INTO ext_packs_approvals (kind, name, description_hash, action, user_id, at) VALUES ('mcp_server', 'notes', ?, 'approve', ?, ?)", [notes.hash, ME, at]);
    const ref = (id: string, name: string, p: string, sha: string, created: string) =>
      driver.run("INSERT INTO ext_skill_refs (id, source, name, path, sha256, added_by, created_at) VALUES (?, 'claude', ?, ?, ?, ?, ?)", [id, name, p, sha, ME, created]);
    await ref("sr_a_old", "alpha", "/s/alpha/SKILL.md", "a0", at);
    await ref("sr_a", "alpha", "/s/alpha/SKILL.md", "a1", later);
    await ref("sr_b", "beta", "/s/beta/SKILL.md", "b1", at);
    const before = { entries: await driver.all("SELECT * FROM ext_packs_entries ORDER BY id"), refs: await driver.all("SELECT * FROM ext_skill_refs ORDER BY id") };
    await driver.close();
    return { home, path, before, docs, notes, gone, tool };
  }

  /** Opens the database as `npm run migrate` does: breaking migrations applied. */
  async function migrate(path: string): Promise<void> {
    const store = new SqlFactoryStore(new SqliteDriver(path, { applyBreaking: true }), new FakeClock());
    try {
      await store.migrate();
    } finally {
      await store.close();
    }
  }

  it("are breaking, name their one table each, verify themselves and come after 20261115T1200", async () => {
    const found = (await discoverMigrations()).filter((m) => m.id === POINTERS || m.id === BY_PATH);
    expect(found.map((m) => [m.id, m.change, m.tables])).toEqual([[POINTERS, "breaking", ["ext_packs_entries"]], [BY_PATH, "breaking", ["ext_skill_refs"]]]);
    for (const m of found) expect(m.verify).toBeTypeOf("function");
    expect(found.every((m) => m.id > "20261115T1200")).toBe(true);
  });

  it("rebuilds both tables, keeps the old ones as legacy_ tables with every row, and turns copied MCP rows into pointers", async () => {
    const o = await oldDatabase();
    await migrate(o.path);
    const db = new DatabaseSync(o.path);
    try {
      // The legacy tables hold every old row as it was; nothing was dropped.
      expect(rows(db, "SELECT * FROM legacy_ext_packs_entries ORDER BY id")).toEqual(o.before.entries);
      expect(rows(db, "SELECT * FROM legacy_ext_skill_refs ORDER BY id")).toEqual(o.before.refs);
      expect(cols(db, "ext_packs_entries")).toEqual(expect.arrayContaining(["source", "source_file", "source_key", "module_hash"]));
      expect(cols(db, "ext_skill_refs")).toEqual(expect.arrayContaining(["kind", "updated_at"]));
      // The pack tool is copied as it was.
      expect(rows(db, "SELECT id, descriptor, description_hash, source_file FROM ext_packs_entries WHERE kind = 'tool'")).toEqual([
        { id: "pe_tool", descriptor: o.tool.text, description_hash: o.tool.hash, source_file: null },
      ]);
      // One pointer per imported name, from its current row; no descriptor copy.
      expect(rows(db, "SELECT id, name, description_hash, descriptor, source, source_file, source_key, status FROM ext_packs_entries WHERE kind = 'mcp_server' ORDER BY name")).toEqual([
        { id: "pe_docs", name: "docs", description_hash: o.docs.hash, descriptor: null, source: "claude", source_file: join(o.home, ".claude.json"), source_key: "docs", status: "pending" },
        { id: "pe_gone", name: "gone", description_hash: o.gone.hash, descriptor: null, source: "claude", source_file: join(o.home, ".claude.json"), source_key: "gone", status: "missing" },
        {
          id: "pe_notes", name: "notes", description_hash: copied("codex", "notes", { command: "notes-v2" }).hash, descriptor: null,
          source: "codex", source_file: join(o.home, ".codex", "config.toml"), source_key: "notes", status: "pending",
        },
      ]);
      // Skill refs: one row per (source, path), the newest kept with its data; every one a skill.
      expect(rows(db, "SELECT id, source, kind, name, path, sha256, added_by, created_at, updated_at FROM ext_skill_refs ORDER BY id")).toEqual([
        { id: "sr_a", source: "claude", kind: "skill", name: "alpha", path: "/s/alpha/SKILL.md", sha256: "a1", added_by: ME, created_at: later, updated_at: later },
        { id: "sr_b", source: "claude", kind: "skill", name: "beta", path: "/s/beta/SKILL.md", sha256: "b1", added_by: ME, created_at: at, updated_at: at },
      ]);
      expect(() => db.prepare("INSERT INTO ext_skill_refs (id, source, kind, name, path, sha256, added_by, created_at, updated_at) VALUES ('x', 'claude', 'skill', 'alpha', '/s/alpha/SKILL.md', 'a2', 'u', 't', 't')").run()).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it("an unchanged server's approval still holds; a changed one is pending again; a missing one runs nothing", async () => {
    const o = await oldDatabase();
    await migrate(o.path);
    const driver = new SqliteDriver(o.path);
    try {
      expect(await checkPackGrants(driver, ["pack:mcp_server:docs", "pack:mcp_server:notes", "pack:mcp_server:gone"], false)).toEqual({
        broker: [],
        mcp_servers: [{ name: "docs", command: "docs-mcp", args: [] }],
        refused: [{ grant: "pack:mcp_server:notes", reason: "not_approved" }, { grant: "pack:mcp_server:gone", reason: "missing" }],
      });
    } finally {
      await driver.close();
    }
  });

  it("a rerun of either migration changes nothing", async () => {
    const o = await oldDatabase();
    await migrate(o.path);
    const driver = new SqliteDriver(o.path);
    try {
      const all = async () => JSON.stringify([await driver.all("SELECT * FROM ext_packs_entries ORDER BY id"), await driver.all("SELECT * FROM ext_skill_refs ORDER BY id")]);
      const once = await all();
      const db: MigrationDb = { dialect: "sqlite", all: (sql, p) => driver.all(sql, p), run: (sql, p) => driver.run(sql, p) };
      for (const m of (await discoverMigrations()).filter((x) => x.id === POINTERS || x.id === BY_PATH)) {
        await m.up(db);
        expect(await m.verify!(db)).toEqual([]);
      }
      expect(await all()).toBe(once);
    } finally {
      await driver.close();
    }
  });
});

describe("skill draft slots: two replicas on one SQLite file (design 07-self-improvement)", () => {
  it("cannot pass the cap together: the conditional increment is one statement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-skill-draft-days-"));
    const clock = new FakeClock();
    const open = async () => {
      const s = new SqlFactoryStore(new SqliteDriver(join(dir, "factory.db")), clock);
      await s.migrate();
      return s;
    };
    const a = await open();
    const b = await open();
    const taken = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).takeSkillDraftSlot(PROJECT_KEY, 3)));
    expect(taken.filter(Boolean)).toHaveLength(3);
    expect(await a.skillDraftCount(PROJECT_KEY)).toBe(3);
    expect(await b.skillDraftCount(PROJECT_KEY)).toBe(3);
    await a.close();
    await b.close();
  });
});
