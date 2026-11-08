// Local user changes are audited (design 08-permissions, issue #445): every add, role change and removal of a
// local user writes one `local_user_changes` row (actor, user, action, old role, new role, time) in the same
// transaction as the change, from the store, so `factory users` and the Users page write the same row. A refused
// or empty write writes none. Never pin a step as the newest.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import { cliIdentity, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import { INLINE_STEPS, STEPS_DIR, readSteps } from "../src/impl/store/mysql/migrations.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { newStore } from "./helpers/store.js";

const STEP = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS local_user_changes")) + 1;
const STEP_FILE = `${String(STEP).padStart(4, "0")}-local-user-changes.sql`;
const OWNER = "local:owner@example.com" as UserId;
const ALICE = "local:alice" as UserId;

/** The audit rows, oldest first. */
async function changes(store: FactoryStore) {
  const page = await store.listTableRows({ table: "local_user_changes", limit: 200 });
  return [...page!.rows].sort((a, b) => Number(a.seq) - Number(b.seq)).map(({ seq: _, ...r }) => r);
}

async function owned() {
  const { store, clock } = await newStore();
  await store.claimLocalOwner(OWNER);
  return { store, at: clock.now().toISOString() };
}

describe("local_user_changes: one row per add, change and remove", () => {
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

describe("migration: local_user_changes", () => {
  it("is one SQLite migration and the MySQL step of the same number", () => {
    expect(STEP).toBeGreaterThan(0);
    expect(readSteps(STEPS_DIR, INLINE_STEPS).find((s) => s.name === "local-user-changes")).toMatchObject({
      number: STEP, from: STEP - 1, kind: "sql", file: STEP_FILE,
    });
    const sql = readFileSync(join(STEPS_DIR, STEP_FILE), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS local_user_changes");
    for (const col of ["seq", "user_id", "action", "old_role", "new_role", "actor", "at"]) expect(sql).toMatch(new RegExp(`\\n\\s+${col}\\s`));
  });
});
