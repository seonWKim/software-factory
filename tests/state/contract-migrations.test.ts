import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, dropTables, pendingMigrations, tableExists, type MigrationDb } from "../../src/state/index.js";
import { newStore } from "../helpers/store.js";

// RFC 0015 §12 D2: a contract migration drops `legacy_*` only when the owner runs `migrate --contract`, and only
// CONTRACT_MIN_DAYS after the breaking migration it follows; until then the down path (D9) stays open. Opening a
// database (which applies every other pending migration) never runs one.

const CONTRACTS = ["20261109T0900-state-drop-legacy-tables", "20261109T0901-inbound-drop-legacy-commands"];

async function db(): Promise<MigrationDb> {
  const { store } = await newStore();
  return { dialect: "sqlite", all: (s, p) => store.db.all(s, p), run: (s, p) => store.db.run(s, p) };
}

describe("contract migrations", () => {
  it("are not applied on open and are not pending for a start or an update", async () => {
    const d = await db();
    expect(await tableExists(d, "legacy_work_items")).toBe(true);
    expect(await tableExists(d, "legacy_inbound_commands")).toBe(true);
    expect((await pendingMigrations(d)).map((m) => m.id)).toEqual([]);
    expect((await pendingMigrations(d, undefined, true)).map((m) => m.id)).toEqual(CONTRACTS);
  });

  it("with --contract, wait 14 days after the migration they follow, then drop only the legacy tables", async () => {
    const d = await db();
    const soon = new Date(Date.now() + 13 * 86_400_000).toISOString();
    const lines: string[] = [];
    expect(await applyMigrations(d, { backupDir: null, now: () => soon, contract: true, print: (l) => lines.push(l) })).toEqual([]);
    expect(lines).toEqual([
      expect.stringMatching(/^skipping 20261109T0900-state-drop-legacy-tables: 20261108T1300-state-prefix-tables was applied 1[23] days ago/),
      expect.stringMatching(/^skipping 20261109T0901-inbound-drop-legacy-commands: 20261108T2200-inbound-merge-commands was applied/),
    ]);
    expect(await tableExists(d, "legacy_work_items")).toBe(true);

    const later = new Date(Date.now() + 15 * 86_400_000).toISOString();
    // A fresh database has a seeded row in legacy_claim_locks, so the drop needs somewhere to archive it (D4).
    await expect(applyMigrations(d, { backupDir: null, now: () => later, contract: true })).rejects.toThrow(/no backup folder/);
    const backups = mkdtempSync(join(tmpdir(), "sf-contract-"));
    expect(await applyMigrations(d, { backupDir: backups, now: () => later, contract: true })).toEqual(CONTRACTS);
    expect(readdirSync(backups).some((f) => f.endsWith(CONTRACTS[0]!))).toBe(true);
    for (const t of ["legacy_work_items", "legacy_cli_commands", "legacy_inbound_commands", "legacy_inbound_app_requests"]) {
      expect(await tableExists(d, t)).toBe(false);
    }
    expect(await tableExists(d, "controller_work_items")).toBe(true);
    expect(await tableExists(d, "inbound_commands")).toBe(true);
  });

  it("drop a child table before the table its foreign key points to, so a parent listed first does not fail", async () => {
    // legacy_verdicts points to legacy_state_changes: dropping the parent first fails once a verdict row exists.
    const d = await db();
    await d.run("CREATE TABLE p (id INTEGER PRIMARY KEY)");
    await d.run("CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER NOT NULL REFERENCES p(id))");
    await d.run("INSERT INTO p (id) VALUES (1)");
    await d.run("INSERT INTO c (id, p_id) VALUES (1, 1)");
    await expect(d.run("DROP TABLE p")).rejects.toThrow(/FOREIGN KEY/);
    await dropTables(d, ["p", "c", "missing"]);
    expect([await tableExists(d, "p"), await tableExists(d, "c")]).toEqual([false, false]);
  });
});
