import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, discoverMigrations, dropTables, pendingMigrations, tableExists, type MigrationDb } from "../../src/state/index.js";
import { LEGACY_TABLES } from "../../src/state/migrations/20261109T0900-state-drop-legacy-tables.migration.js";
import { issue, newStore, system } from "../helpers/store.js";

// RFC 0015 §12 D2: a contract migration drops `legacy_*` only when the owner runs `migrate --contract`, and only
// CONTRACT_MIN_DAYS after the breaking migrations it follows; until then the down path (D9) stays open. Opening a
// database (which applies every other pending migration) never runs one. The one legacy contract copies every
// legacy row missing from its current table before it drops them all.

const LEGACY_DROP = "20261109T0900-state-drop-legacy-tables";
const BASE_PUSHES_DROP = "20261109T1215-outbound-drop-base-pushes";
const DAY = 86_400_000;
const later = () => new Date(Date.now() + 15 * DAY).toISOString();

async function fresh() {
  const { store } = await newStore();
  const d: MigrationDb = { dialect: "sqlite", all: (s, p) => store.db.all(s, p), run: (s, p) => store.db.run(s, p) };
  return { store, d };
}

/** The `legacy_*` tables sqlite_master still lists. */
async function legacyLeft(d: MigrationDb): Promise<string[]> {
  return (await d.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'legacy\\_%' ESCAPE '\\'")).map((r) => String(r.name));
}

const DECISION = ["decision", "holder_work_item_id", "holder_ref", "holder_kind", "shared", "cost", "threshold", "fallback", "approved_by", "at"];

/** A claim decision row for `workItem`, only in legacy_claim_decisions (its legacy parent is not needed for the fixture). */
async function legacyDecision(d: MigrationDb, runId: string, workItem: string, decision = "claim"): Promise<void> {
  await d.run("PRAGMA foreign_keys = OFF");
  await d.run(
    `INSERT INTO legacy_claim_decisions (run_id, work_item_id, ${DECISION.join(", ")}) VALUES (?, ?, ?, NULL, 'ref', 'branch', '[]', 1.5, 2, 0, NULL, '2026-11-01T00:00:00.000Z')`,
    [runId, workItem, decision],
  );
  await d.run("PRAGMA foreign_keys = ON");
}

async function contract(d: MigrationDb, extra: { dryRun?: boolean; backupDir?: string | null } = {}) {
  const lines: string[] = [];
  const backupDir = extra.backupDir === undefined ? mkdtempSync(join(tmpdir(), "sf-contract-")) : extra.backupDir;
  const done = await applyMigrations(d, { backupDir, now: later, contract: true, print: (l) => lines.push(l), ...(extra.dryRun ? { dryRun: true } : {}) });
  return { done, lines, backupDir };
}

describe("contract migrations", () => {
  it("are not applied on open and are not pending for a start or an update; one of them drops legacy tables", async () => {
    const { d } = await fresh();
    expect(await tableExists(d, "legacy_work_items")).toBe(true);
    expect(await tableExists(d, "legacy_inbound_commands")).toBe(true);
    expect((await pendingMigrations(d)).map((m) => m.id)).toEqual([]);
    const contracts = (await pendingMigrations(d, undefined, true)).map((m) => m.id);
    expect(contracts).toEqual(expect.arrayContaining([LEGACY_DROP, BASE_PUSHES_DROP]));
    expect(contracts.indexOf(LEGACY_DROP)).toBeLessThan(contracts.indexOf(BASE_PUSHES_DROP));
    expect(contracts.filter((id) => /legacy/.test(id))).toEqual([LEGACY_DROP]);
  });

  it("the legacy drop follows the rename, the command merge and the work item rebuild", async () => {
    const m = (await discoverMigrations()).find((x) => x.id === LEGACY_DROP)!;
    expect(m.after).toEqual(expect.arrayContaining(["20261108T1300-state-prefix-tables", "20261108T2200-inbound-merge-commands", "20261112T1200-controller-change-ref-only"]));
    expect(m.tables).toEqual(Object.keys(LEGACY_TABLES));
    expect(m.tables).not.toContain("outbound_base_pushes");
  });

  it("with --contract, wait 14 days after the migrations they follow and print why, then drop every legacy table", async () => {
    const { d } = await fresh();
    const soon = new Date(Date.now() + 13 * DAY).toISOString();
    const lines: string[] = [];
    expect(await applyMigrations(d, { backupDir: null, now: () => soon, contract: true, print: (l) => lines.push(l) })).toEqual([]);
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^skipping ${LEGACY_DROP}: 20261108T1300-state-prefix-tables was applied 1[23] days ago; contract waits 14`)),
      expect.stringMatching(new RegExp(`^skipping ${BASE_PUSHES_DROP}: 20261109T1200-outbound-carry-base-pushes was applied`)),
    ]));
    expect(await tableExists(d, "legacy_work_items")).toBe(true);

    // A fresh database has a seeded row in legacy_claim_locks, so the drop needs somewhere to archive it (D4).
    await expect(applyMigrations(d, { backupDir: null, now: later, contract: true })).rejects.toThrow(/no backup folder/);
    expect((await legacyLeft(d)).length).toBeGreaterThan(0);
    const { done, backupDir } = await contract(d);
    expect(done).toEqual(expect.arrayContaining([LEGACY_DROP, BASE_PUSHES_DROP]));
    const archive = readdirSync(backupDir!).find((f) => f.endsWith(LEGACY_DROP))!;
    expect(readFileSync(join(backupDir!, archive, "legacy_claim_locks.jsonl"), "utf8")).not.toBe("");
    expect(await legacyLeft(d)).toEqual([]);
    expect(await tableExists(d, "outbound_base_pushes")).toBe(false);
    expect(await tableExists(d, "controller_work_items")).toBe(true);
    expect(await tableExists(d, "inbound_commands")).toBe(true);
    expect(await tableExists(d, "worker_claim_locks")).toBe(true);
    expect(await tableExists(d, "controller_held_writes")).toBe(true);
  });

  it("copies a row that is only in legacy_claim_decisions to its current table with the same key and values, then drops the legacy table", async () => {
    const { store, d } = await fresh();
    const item = (await store.createWorkItem(issue(1), system)).item;
    await legacyDecision(d, "run_only_legacy", item.id);
    expect(await d.all("SELECT 1 FROM controller_claim_decisions WHERE run_id = 'run_only_legacy'")).toEqual([]);
    const before = await d.all(`SELECT run_id, work_item_id, ${DECISION.join(", ")} FROM legacy_claim_decisions`);

    const { lines } = await contract(d);
    expect(await d.all(`SELECT run_id, work_item_id, ${DECISION.join(", ")} FROM controller_claim_decisions`)).toEqual(before);
    expect(await tableExists(d, "legacy_claim_decisions")).toBe(false);
    expect(lines).toEqual(expect.arrayContaining(["legacy_claim_decisions: 1 rows; copied 1 into controller_claim_decisions; dropped 1", "  copied run_id=run_only_legacy"]));
  });

  it("does not insert a row whose key is already in the current table, and reports per table what it copied and dropped", async () => {
    const { store, d } = await fresh();
    const item = (await store.createWorkItem(issue(1), system)).item;
    await legacyDecision(d, "run_both", item.id, "old");
    await legacyDecision(d, "run_legacy", item.id);
    await d.run(`INSERT INTO controller_claim_decisions (run_id, work_item_id, ${DECISION.join(", ")}) SELECT run_id, work_item_id, 'current', ${DECISION.slice(1).join(", ")} FROM legacy_claim_decisions WHERE run_id = 'run_both'`);

    const { lines } = await contract(d);
    expect(await d.all("SELECT run_id, decision FROM controller_claim_decisions ORDER BY run_id")).toEqual([
      { run_id: "run_both", decision: "current" },
      { run_id: "run_legacy", decision: "claim" },
    ]);
    expect(lines).toContain("legacy_claim_decisions: 2 rows; copied 1 into controller_claim_decisions; dropped 2");
    expect(lines).toContain("legacy_work_items: 0 rows; copied 0 into controller_work_items; dropped 0");
    expect(lines).toContain("legacy_cli_commands: 0 rows; retired (no code read it), nothing copied; dropped 0");
  });

  it("carries a merged command table's row into inbound_commands under the id and seq trace the merge gave", async () => {
    const { d } = await fresh();
    await d.run("INSERT INTO legacy_inbound_app_requests (seq, request_key, actor, command, args, created_at) VALUES (7, 'app:k1', 'local:o', 'approve', '{}', '2026-11-01T00:00:00.000Z')");
    await contract(d);
    expect(await d.all("SELECT id, origin, command, legacy_table, legacy_seq FROM inbound_commands WHERE command_key = 'app:k1'")).toEqual([
      { id: "cmd_app_command_requests_7", origin: "app", command: "approve", legacy_table: "app_command_requests", legacy_seq: 7 },
    ]);
  });

  it("--dry-run prints each legacy table with its row count and the rows it would copy, and changes nothing", async () => {
    const { store, d } = await fresh();
    const item = (await store.createWorkItem(issue(1), system)).item;
    await legacyDecision(d, "run_dry", item.id);
    const tables = await legacyLeft(d);

    const { done, lines, backupDir } = await contract(d, { dryRun: true });
    expect(done).toContain(LEGACY_DROP);
    expect(lines).toEqual(expect.arrayContaining([
      `dry run of ${LEGACY_DROP} (rolled back, nothing changes):`,
      "  legacy_claim_decisions: 1 rows; copied 1 into controller_claim_decisions; dropped 1",
      "    copied run_id=run_dry",
      "  legacy_claim_locks: 1 rows; copied 0 into worker_claim_locks; dropped 1",
    ]));
    expect(await legacyLeft(d)).toEqual(tables);
    expect(await d.all("SELECT 1 FROM controller_claim_decisions")).toEqual([]);
    expect(readdirSync(backupDir!)).toEqual([]);
    expect((await pendingMigrations(d, undefined, true)).map((m) => m.id)).toContain(LEGACY_DROP);
  });

  it("a legacy table with no current table mapped blocks the whole run: nothing is copied or dropped, and the error names it", async () => {
    const { store, d } = await fresh();
    const item = (await store.createWorkItem(issue(1), system)).item;
    await legacyDecision(d, "run_blocked", item.id);
    await d.run("CREATE TABLE legacy_ghosts (id TEXT PRIMARY KEY)");
    const tables = await legacyLeft(d);

    await expect(contract(d)).rejects.toThrow(/no current table is mapped for legacy_ghosts/);
    expect(await legacyLeft(d)).toEqual(tables);
    expect(await d.all("SELECT 1 FROM controller_claim_decisions")).toEqual([]);
  });

  it("a rerun after it applied changes nothing; a run that stopped after copying finishes on its rerun", async () => {
    const { store, d } = await fresh();
    const item = (await store.createWorkItem(issue(1), system)).item;
    await legacyDecision(d, "run_resume", item.id);
    // Stops at the first drop, after every copy.
    const failing: MigrationDb = { ...d, run: (s, p) => (/^DROP TABLE legacy_/.test(s) ? Promise.reject(new Error("stopped")) : d.run(s, p)) };
    await expect(contract(failing)).rejects.toThrow(/stopped/);
    expect(await d.all("SELECT run_id FROM controller_claim_decisions")).toEqual([{ run_id: "run_resume" }]);
    expect(await tableExists(d, "legacy_claim_decisions")).toBe(true);

    const { done, lines } = await contract(d);
    expect(done).toContain(LEGACY_DROP);
    expect(lines).toContain("legacy_claim_decisions: 1 rows; copied 0 into controller_claim_decisions; dropped 1");
    expect(await d.all("SELECT run_id FROM controller_claim_decisions")).toEqual([{ run_id: "run_resume" }]);
    expect(await legacyLeft(d)).toEqual([]);

    const schema = await d.all("SELECT name FROM sqlite_master ORDER BY name");
    expect((await contract(d)).done).toEqual([]);
    expect(await d.all("SELECT name FROM sqlite_master ORDER BY name")).toEqual(schema);
  });

  it("drop a child table before the table its foreign key points to, so a parent listed first does not fail", async () => {
    // legacy_verdicts points to legacy_state_changes: dropping the parent first fails once a verdict row exists.
    const { d } = await fresh();
    await d.run("CREATE TABLE p (id INTEGER PRIMARY KEY)");
    await d.run("CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER NOT NULL REFERENCES p(id))");
    await d.run("INSERT INTO p (id) VALUES (1)");
    await d.run("INSERT INTO c (id, p_id) VALUES (1, 1)");
    await expect(d.run("DROP TABLE p")).rejects.toThrow(/FOREIGN KEY/);
    await dropTables(d, ["p", "c", "missing"]);
    expect([await tableExists(d, "p"), await tableExists(d, "c")]).toEqual([false, false]);
  });
});
