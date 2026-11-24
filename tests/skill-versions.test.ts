import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ImportDeps, importItem, importLine, skillRefId } from "../src/import/import-plugins.js";
import { type FoundFile, scanUserConfigs } from "../src/import/scan.js";
import { SqlSkillEvalStore } from "../src/impl/store/sql/skill-evals.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { skillVersion } from "../src/runtime/capabilities/capabilities.js";
import type { Timestamp } from "../src/core/types.js";
import type { SqlDriver } from "../src/state/index.js";
import type { MigrationDb } from "../src/state/migrate/migration.js";
import { cleanScanner } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";
import migration from "../src/state/migrations/20261124T1001-state-ext-skill-versions.migration.js";

// Skill versions (design 11-plugin-import): each import of a skill whose folder hash changed keeps the next version,
// with its full SKILL.md text, in `ext_skill_versions`; the skill files themselves are only read.

const V1 = "---\ndescription: Review helper\n---\n# Review helper\n\nReview the diff carefully.\n";
const V2 = "---\ndescription: Review helper\n---\n# Review helper\n\nReview the diff, then the tests.\n";

const temp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A HOME with one Claude Code skill (with a second file in its folder) and one command. */
function home(skill = V1): string {
  const h = temp("sf-skill-versions-");
  write(join(h, ".claude", "skills", "review-helper", "SKILL.md"), skill);
  write(join(h, ".claude", "skills", "review-helper", "notes", "checklist.md"), "- tests\n");
  write(join(h, ".claude", "commands", "ship.md"), "# Ship\n");
  return h;
}

async function found(h: string, name: string): Promise<FoundFile> {
  const r = await scanUserConfigs({ home: h, kinds: ["skill", "command"], sources: ["claude", "claude-command"] });
  const f = r.found.find((x) => x.name === name);
  if (!f || f.kind === "mcp_server") throw new Error(`not found: ${name}`);
  return f;
}

async function setup() {
  const { store, clock } = await newStore();
  const db = storeSql(store);
  const d: ImportDeps = { db, now: () => clock.now().toISOString(), scanner: cleanScanner, added_by: "local:owner" };
  const versions = new SqlSkillEvalStore(db, () => clock.now().toISOString() as Timestamp);
  return { store, clock, db, d, versions };
}

const skillPath = (h: string) => join(h, ".claude", "skills", "review-helper", "SKILL.md");

describe("skill versions: import", () => {
  it("the first import creates version 1 with the folder hash, the full SKILL.md text, the time and the source", async () => {
    const { d, clock, versions } = await setup();
    const h = home();
    const item = await found(h, "review-helper");
    expect((await importItem(d, item, new Set())).outcome).toBe("stored");
    expect(await versions.listSkillVersions(skillRefId(item))).toEqual([
      { ref_id: skillRefId(item), version: 1, folder_hash: await skillVersion(dirname(skillPath(h))), text: V1, source: "claude", created_at: clock.now().toISOString() },
    ]);
  });

  it("a changed SKILL.md imported again is version 2, and version 1 still holds the old text", async () => {
    const { d, clock, versions } = await setup();
    const h = home();
    await importItem(d, await found(h, "review-helper"), new Set());
    const first = clock.now().toISOString();
    clock.advance(60_000);
    write(skillPath(h), V2);
    const item = await found(h, "review-helper");
    expect((await importItem(d, item, new Set())).outcome).toBe("updated");
    const list = await versions.listSkillVersions(skillRefId(item));
    expect(list.map((v) => [v.version, v.text, v.created_at])).toEqual([[1, V1, first], [2, V2, clock.now().toISOString()]]);
    expect(list[1]!.folder_hash).toBe(await skillVersion(dirname(skillPath(h))));
    expect(list[0]!.folder_hash).not.toBe(list[1]!.folder_hash);
  });

  it("unchanged skill content imported again creates no new version", async () => {
    const { d, clock, versions } = await setup();
    const h = home();
    const item = await found(h, "review-helper");
    await importItem(d, item, new Set());
    const once = await versions.listSkillVersions(skillRefId(item));
    clock.advance(60_000);
    expect((await importItem(d, await found(h, "review-helper"), new Set())).outcome).toBe("already_added");
    expect(await versions.listSkillVersions(skillRefId(item))).toEqual(once);
  });

  it("two imports of the same change at the same time make one version 2", async () => {
    const { d, versions } = await setup();
    const h = home();
    await importItem(d, await found(h, "review-helper"), new Set());
    write(skillPath(h), V2);
    const item = await found(h, "review-helper");
    await Promise.all([importItem(d, item, new Set()), importItem(d, item, new Set())]);
    expect((await versions.listSkillVersions(skillRefId(item))).map((v) => [v.version, v.text])).toEqual([[1, V1], [2, V2]]);
  });

  it("the unique key decides: a worker that read a stale latest version writes nothing and stops", async () => {
    const { db, clock, versions } = await setup();
    const v = { ref_id: "sr_x", folder_hash: "h2", text: V2, source: "claude" };
    expect(await versions.recordSkillVersion({ ...v, folder_hash: "h1", text: V1 })).toMatchObject({ version: 1 });
    // Another worker's transaction that read before version 1 was written: its latest-version read sees nothing.
    let first = true;
    const stale: SqlDriver = Object.assign(Object.create(db) as SqlDriver, {
      transaction: <T>(fn: Parameters<SqlDriver["transaction"]>[0]) => db.transaction((tx) => fn({
        all: async (sql: string, params?: Parameters<typeof tx.all>[1]) => (first && /FROM ext_skill_versions/.test(sql) ? ((first = false), []) : tx.all(sql, params)),
        run: (sql: string, params?: Parameters<typeof tx.run>[1]) => tx.run(sql, params),
      })) as Promise<T>,
    });
    expect(await new SqlSkillEvalStore(stale, () => clock.now().toISOString() as Timestamp).recordSkillVersion(v)).toBeNull();
    expect((await versions.listSkillVersions("sr_x")).map((x) => [x.version, x.folder_hash])).toEqual([[1, "h1"]]);
  });

  it("a skill whose SKILL.md fails the egress scan is refused with its rules: no version and no ref stored", async () => {
    const { d, db, versions } = await setup();
    // An AWS access key ID shape, built from parts.
    const key = ["AK", "IA"].join("") + "ABCDEFGHIJKLMNOP";
    const h = home(`${V1}\nexport AWS_ACCESS_KEY_ID=${key}\n`);
    const item = await found(h, "review-helper");
    const r = await importItem(d, item, new Set());
    expect(r).toMatchObject({ outcome: "refused", rules: ["aws_access_key"] });
    expect(importLine(r)).toMatch(/^refused skill review-helper from claude: aws_access_key$/);
    expect(await versions.listSkillVersions(skillRefId(item))).toEqual([]);
    expect(await db.all("SELECT id FROM ext_skill_refs WHERE id = ?", [skillRefId(item)])).toEqual([]);
  });

  it("never writes a skill file: bytes and modification time are the same after imports", async () => {
    const { d } = await setup();
    const h = home();
    const files = [skillPath(h), join(dirname(skillPath(h)), "notes", "checklist.md"), join(h, ".claude", "commands", "ship.md")];
    const snap = () => files.map((f) => [readFileSync(f, "base64"), statSync(f).mtimeMs]);
    const before = snap();
    for (const name of ["review-helper", "ship", "review-helper"]) await importItem(d, await found(h, name), new Set());
    expect(snap()).toEqual(before);
  });

  it("commands get no version, and their rows are unchanged by a second import", async () => {
    const { d, db } = await setup();
    const h = home();
    const cmd = await found(h, "ship");
    expect(cmd.kind).toBe("command");
    await importItem(d, cmd, new Set());
    const rows = await db.all("SELECT * FROM ext_skill_refs WHERE kind = 'command'");
    await importItem(d, cmd, new Set());
    expect(await db.all("SELECT * FROM ext_skill_refs WHERE kind = 'command'")).toEqual(rows);
    expect(await db.all("SELECT ref_id FROM ext_skill_versions WHERE ref_id = ?", [skillRefId(cmd)])).toEqual([]);
  });
});

describe("skill versions: the migration", () => {
  it("writes no version for a ref stored before it (a rerun changes nothing); the next import makes version 1", async () => {
    const { db, d, versions } = await setup();
    const h = home();
    const item = await found(h, "review-helper");
    // A store before the migration, holding a ref an earlier import stored; then the migration, twice.
    await db.run("DROP TABLE ext_skill_versions");
    await db.run(
      "INSERT INTO ext_skill_refs (id, source, kind, name, path, sha256, added_by, created_at, updated_at) VALUES (?, ?, 'skill', ?, ?, ?, 'local:owner', 't0', 't0')",
      [skillRefId(item), item.source, item.name, item.path, item.sha256],
    );
    const mdb: MigrationDb = { dialect: "sqlite", all: (q, p) => db.all(q, p), run: (q, p) => db.run(q, p) };
    await migration.up(mdb);
    await migration.up(mdb);
    expect(await db.all("SELECT * FROM ext_skill_versions")).toEqual([]);
    expect((await importItem(d, item, new Set())).outcome).toBe("already_added");
    expect((await versions.listSkillVersions(skillRefId(item))).map((v) => [v.version, v.text])).toEqual([[1, V1]]);
  });

  it("enforces one row per (ref_id, version)", async () => {
    const { db } = await setup();
    const insert = () => db.run("INSERT INTO ext_skill_versions (ref_id, version, folder_hash, text, source, created_at) VALUES ('sr_y', 1, 'h', 't', 'claude', 't0')");
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE|PRIMARY/);
  });
});
