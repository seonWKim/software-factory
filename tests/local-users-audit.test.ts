// Local user changes are audited (design 08-permissions, issue #445): every add, role change and removal of a
// local user writes one `identity_local_user_changes` row (actor, user, action, old role, new role, time) in the same
// transaction as the change, from the store, so `factory users` and the Users page write the same row. A refused
// or empty write writes none. Never pin a step as the newest.

import { describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import { cliIdentity, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import migration from "../src/identity/migrations/20261109T1300-identity-local-user-changes.migration.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Dialect, MigrationDb } from "../src/state/index.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { newStore } from "./helpers/store.js";

const OWNER = "local:owner@example.com" as UserId;
const ALICE = "local:alice" as UserId;

/** The audit rows, oldest first. */
async function changes(store: FactoryStore) {
  const page = await store.listTableRows({ table: "identity_local_user_changes", limit: 200 });
  return [...page!.rows].sort((a, b) => Number(a.seq) - Number(b.seq)).map(({ seq: _, ...r }) => r);
}

async function owned() {
  const { store, clock } = await newStore();
  await store.claimLocalOwner(OWNER);
  return { store, at: clock.now().toISOString() };
}

describe("identity_local_user_changes: one row per add, change and remove", () => {
  it("records an add, a change and a remove with the actor, the old and new role and the time", async () => {
    const { store, at } = await owned();
    await store.setLocalUserRole(ALICE, "requester", OWNER);
    await store.setLocalUserRole(ALICE, "approver", OWNER);
    expect(await store.removeLocalUser(ALICE)).toBe("removed");
    expect(await changes(store)).toEqual([
      { user_id: ALICE, action: "add", old_role: null, new_role: "requester", actor: OWNER, at },
      { user_id: ALICE, action: "change", old_role: "requester", new_role: "approver", actor: OWNER, at },
      { user_id: ALICE, action: "remove", old_role: "approver", new_role: null, actor: OWNER, at },
    ]);
  });

  it("writes no row for a refused write or one that changes nothing", async () => {
    const { store } = await owned();
    expect(await store.setLocalUserRole(OWNER, "requester", OWNER)).toEqual({ ok: false, reason: "owner" });
    expect(await store.removeLocalUser(OWNER)).toBe("owner");
    expect(await store.removeLocalUser(ALICE)).toBe("missing");
    await store.setLocalUserRole(ALICE, "approver", OWNER);
    await store.setLocalUserRole(ALICE, "approver", OWNER);
    expect((await changes(store)).map((c) => c.action)).toEqual(["add"]);
  });

  it("`factory users add` and `users remove` write the same rows; a non-owner's attempt writes none", async () => {
    const { store } = await owned();
    const as = (user: UserId) => ({
      store, identity: { user, from: "git user.email" as const }, project: async () => null,
      read: async () => "", newId: () => "x",
    });
    const run = async (user: UserId, args: string[]) => {
      const a = parseLocalCliArgs("users", args);
      if ("error" in a) throw new Error(a.error);
      return runLocalCli(as(user), a);
    };
    expect((await run(OWNER, ["add", ALICE, "--role", "approver"])).code).toBe(0);
    expect((await run(ALICE, ["remove", OWNER])).code).toBe(1);
    expect((await run(ALICE, ["add", "local:bob", "--role", "requester"])).code).toBe(1);
    expect((await run(OWNER, ["remove", ALICE])).code).toBe(0);
    expect((await changes(store)).map((c) => [c.action, c.user_id, c.actor])).toEqual([
      ["add", ALICE, OWNER],
      ["remove", ALICE, OWNER],
    ]);
    // The CLI identity is a key, never a display name.
    expect(cliIdentity(null, { gitEmail: "Owner@Example.com", osUser: null }).user).toBe(OWNER);
  });
});

describe("migration: identity_local_user_changes", () => {
  /** The statements the migration runs on `dialect`. */
  async function statements(dialect: Dialect): Promise<string[]> {
    const sql: string[] = [];
    const db = { dialect, run: async (q: string) => (sql.push(q), 0), all: async () => [] } as unknown as MigrationDb;
    await migration.up(db);
    return sql;
  }

  it("is additive and creates the same table, with every column, on SQLite", async () => {
    expect(migration.change).toBe("additive");
    for (const dialect of ["sqlite"] as const) {
      const [sql, ...rest] = await statements(dialect);
      expect(rest).toEqual([]);
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS identity_local_user_changes");
      for (const col of ["seq", "user_id", "action", "old_role", "new_role", "actor", "at"]) expect(sql).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
  });

  it("runs again on a database that already has the table (a rerun after a crash)", async () => {
    const driver = new SqliteDriver(":memory:");
    await driver.migrate();
    const db: MigrationDb = { dialect: "sqlite", run: (q, p) => driver.run(q, p), all: (q, p) => driver.all(q, p) };
    await expect(migration.up(db)).resolves.toBeUndefined();
    await driver.close();
  });
});
