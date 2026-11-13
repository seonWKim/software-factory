// The one owner (design 08-permissions, One owner; issue #577, phase 2 of #568). Roles and local users are gone: a
// migration copies the owner into the one-row identity_owner table and drops identity_local_users and
// identity_local_user_changes; the owner check, the rules verdict check and the Slack help list read the owner from
// there; each owner-check decision writes one authz_audit row with no passport. Never pin a step as the newest.

import { describe, expect, it } from "vitest";
import { NOT_OWNER, OwnerAuth } from "../src/core/authorize.js";
import type { UserId } from "../src/core/types.js";
import { NO_PASSPORT, OWNER_TABLE, readOwner } from "../src/identity/index.js";
import { runChatCommand } from "../src/impl/source/slack-commands.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { type MigrationDb, MIGRATIONS_TABLE, applyMigrations, discoverMigrations, tableExists } from "../src/state/index.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { PauseDeps, UiPauses } from "../src/ui/pause-api.js";
import { ownerOf } from "../src/ui/rules-api.js";
import { respond } from "../src/ui/server.js";
import { cleanScanner } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

const MIGRATION = "20261113T1500-identity-owner";
const DROPPED = ["identity_local_users", "identity_local_user_changes"];
const OWNER = "local:owner@example.com" as UserId;
const AT = "2026-11-13T12:00:00.000Z";

/** A database with every migration before the owner migration applied, so the two old tables are there. */
async function beforeMigration() {
  const driver = new SqliteDriver(":memory:", { baselineOnly: true });
  await driver.migrate();
  const db: MigrationDb = { dialect: "sqlite", run: (q, p) => driver.run(q, p), all: (q, p) => driver.all(q, p) };
  const all = await discoverMigrations();
  const mine = all.find((m) => m.id === MIGRATION)!;
  expect(mine).toBeDefined();
  await applyMigrations(db, { backupDir: null, now: () => AT, migrations: all.filter((m) => m.id < MIGRATION) });
  return { driver, db, mine };
}

describe("migration: identity_owner replaces identity_local_users and identity_local_user_changes", () => {
  it("copies the owner first, then drops both tables; the owner is unchanged", async () => {
    const { driver, db, mine } = await beforeMigration();
    try {
      for (const t of DROPPED) expect(await tableExists(db, t), t).toBe(true);
      await db.run("INSERT INTO identity_local_users (user_id, role, owner_slot, added_by, created_at) VALUES (?, 'owner', 1, ?, ?)", [OWNER, OWNER, AT]);
      await db.run("INSERT INTO identity_local_users (user_id, role, owner_slot, added_by, created_at) VALUES ('local:dev', 'approver', NULL, ?, ?)", [OWNER, AT]);
      await db.run("INSERT INTO identity_local_user_changes (user_id, action, old_role, new_role, actor, at) VALUES ('local:dev', 'add', NULL, 'approver', ?, ?)", [OWNER, AT]);
      expect(mine.change).toBe("breaking");
      expect(mine.tables).toEqual(DROPPED);

      expect(await applyMigrations(db, { backupDir: null, now: () => AT, migrations: [mine] })).toEqual([MIGRATION]);
      for (const t of DROPPED) expect(await tableExists(db, t), t).toBe(false);
      expect(await readOwner(db)).toBe(OWNER);
      expect(await db.all(`SELECT slot, user_id, claimed_at FROM ${OWNER_TABLE}`)).toEqual([{ slot: 1, user_id: OWNER, claimed_at: AT }]);
      expect(await db.all(`SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = ?`, [MIGRATION])).toHaveLength(1);
      expect(await mine.verify!(db)).toEqual([]);
      // A rerun after a crash changes nothing.
      await mine.up(db);
      expect(await readOwner(db)).toBe(OWNER);
    } finally {
      await driver.close();
    }
  });

  it("a store with no owner yet stays without one", async () => {
    const { driver, db, mine } = await beforeMigration();
    try {
      await applyMigrations(db, { backupDir: null, now: () => AT, migrations: [mine] });
      for (const t of DROPPED) expect(await tableExists(db, t), t).toBe(false);
      expect(await readOwner(db)).toBeNull();
    } finally {
      await driver.close();
    }
  });

  it("a new store opens with identity_owner and neither old table", async () => {
    const { store } = await newStore();
    const db = { dialect: "sqlite" as const, run: store.db.run.bind(store.db), all: store.db.all.bind(store.db) };
    for (const t of DROPPED) expect(await tableExists(db, t), t).toBe(false);
    expect(await tableExists(db, OWNER_TABLE)).toBe(true);
    // One slot: a second claim keeps the first owner.
    expect(await store.claimOwner(OWNER)).toBe(OWNER);
    expect(await store.claimOwner("local:dev" as UserId)).toBe(OWNER);
    expect(await store.getOwner()).toBe(OWNER);
  });
});

describe("each owner-check decision writes exactly one authz_audit row with no passport", () => {
  it("one allowed and one refused command: two rows", async () => {
    const { store } = await newStore();
    await store.claimOwner(OWNER);
    const auth = new OwnerAuth(store);
    const item = { kind: "work_item" as const, id: "wi_1" };
    expect(await auth.authorize({ user_id: OWNER, attributes: {} }, "approve_spec", item)).toEqual({ allow: true });
    expect(await auth.authorize({ user_id: "local:dev" as UserId, attributes: {} }, "approve_spec", item)).toEqual({ allow: false, reason: NOT_OWNER });
    const rows = await store.db.all("SELECT passport_id, principal, action, resource, decision, reason FROM authz_audit ORDER BY seq");
    expect(rows).toEqual([
      { passport_id: NO_PASSPORT, principal: OWNER, action: "approve_spec", resource: '{"project":null,"item":"wi_1"}', decision: "allow", reason: "allowed" },
      { passport_id: NO_PASSPORT, principal: "local:dev", action: "approve_spec", resource: '{"project":null,"item":"wi_1"}', decision: "deny", reason: NOT_OWNER },
    ]);
  });
});

describe("the owner lookup in the rules verdict check and the Slack help list", () => {
  const pauses = (user: UserId): UiPauses => ({ principal: async () => user, authorize: async () => ({ allow: true }), csrfToken: "t", log: { info() {}, warn() {}, error() {} } as never });

  it("the rules verdict check allows the stored owner only", async () => {
    const { store } = await newStore();
    await store.claimOwner(OWNER);
    const d = { store } as unknown as PauseDeps;
    expect(await ownerOf(d, pauses(OWNER), "judges rules")).toEqual({ user: OWNER });
    expect(await ownerOf(d, pauses("local:dev" as UserId), "judges rules")).toEqual({ error: "Only the owner judges rules; you are local:dev." });
  });

  it("Slack's help lists the owner's commands to the owner (or anyone while no owner is stored), not to another linked user", async () => {
    const { store } = await newStore();
    const link = async (user: UserId, code: string, slack: string) => {
      await store.createLinkCode(user, code);
      await store.redeemLinkCode(code, { provider: "slack", subject: slack });
    };
    await link(OWNER, "ABCDEFGHJK", "U1");
    await link("local:dev" as UserId, "BCDEFGHJKM", "U2");
    const help = async (slack: string) => {
      const r = await runChatCommand({ store }, { kind: "help" }, { user: slack, item: null, id: `h-${slack}`, origin: "slack" });
      return (r as { markdown: string }).markdown;
    };
    const OWNER_ONLY = "`confirm <proposal-id>`";
    expect(await help("U2")).toContain(OWNER_ONLY);
    await store.claimOwner(OWNER);
    expect(await help("U1")).toContain(OWNER_ONLY);
    expect(await help("U2")).not.toContain(OWNER_ONLY);
  });
});

describe("GET /api/v1/users is gone", () => {
  it("answers 404", async () => {
    const { store, clock } = await newStore();
    const d = { store, scanner: cleanScanner, clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock) };
    const r = await respond(d, { method: "GET", url: "/api/v1/users", host: "127.0.0.1:4310" });
    expect(r.status).toBe(404);
  });
});
