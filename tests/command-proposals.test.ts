import { describe, expect, it } from "vitest";
import { CONFIRM_COMMAND, interpretReply, isProposalId, parseProposalMarker, proposalMarker } from "../src/core/interpret.js";
import { type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeSource, cleanScanner, config, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";
import { proposalId } from "../src/controller/units/commands/proposals.js";
import { proposalPress } from "../src/impl/source/slack-commands.js";
import { COMMAND_PROPOSALS_SQLITE } from "../src/impl/store/sql/command-proposals.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";

// Stored command proposals (design 04-gate-commands, issue #584): the table in both schemas, the reply's marker, the
// proposal ID and the press values, and the controller's confirm path for `factory confirm` (one row as the CLI
// identity). The store contract is in tests/store-contract.test.ts; the Slack buttons end to end in
// tests/slack-source.test.ts; the dashboard's Confirm all and Cancel in tests/ui-commands.test.ts.

/** The column names (and the key) a CREATE TABLE statement defines, in order. */
function columns(sql: string): string[] {
  const body = /CREATE TABLE IF NOT EXISTS controller_command_proposals \(([\s\S]*?)\n\s*\)/.exec(sql)![1]!;
  return body.split("\n").map((l) => l.trim()).filter((l) => l !== "").map((l) => (l.startsWith("PRIMARY KEY") ? l.replace(/,$/, "") : l.split(/\s+/)[0]!));
}

describe("command proposals: the table", () => {
  it("SQLite defines the columns and the key", () => {
    expect(columns(COMMAND_PROPOSALS_SQLITE)).toEqual([
      "proposal_id", "idx", "work_item_id", "command", "args", "author_id", "status", "answered_by", "refusal", "created_at", "answered_at",
      "PRIMARY KEY (proposal_id, idx)",
    ]);
  });

  it("is a SQLite migration, after merge-evaluations", () => {
    expect(MIGRATIONS).toContain(COMMAND_PROPOSALS_SQLITE);
    expect(MIGRATIONS.indexOf(COMMAND_PROPOSALS_SQLITE)).toBeGreaterThan(MIGRATIONS.findIndex((m) => m.includes("controller_merge_evaluations")));
  });

  it("a fresh SQLite database has it, and running its migration again changes nothing", async () => {
    const driver = new SqliteDriver(":memory:");
    await driver.migrate();
    await driver.run(COMMAND_PROPOSALS_SQLITE);
    expect((await driver.all("SELECT name FROM sqlite_master WHERE name = 'controller_command_proposals'")).length).toBe(1);
    await driver.close();
  });
});

describe("command proposals: the reply, its ID and the press values", () => {
  const item = { id: "wi_1" as never, number: 566, title: "T", state: { phase: "spec_pending" as const, has_pr: false }, ref: "o/r#566", link: "" };
  const r = { kind: "commands" as const, proposals: [{ item, command: "approve" as const, args: "ship it" }, { item, command: "retry" as const, args: "" }] };

  it("a stored reply ends with its hidden marker; the same text without one when nothing is stored", () => {
    const id = proposalId("wi_1", "1800000001.000200");
    const body = interpretReply(r, id)!;
    expect(body.split("\n").at(-1)).toBe(proposalMarker(id, ["approve", "retry"]));
    expect(parseProposalMarker(body)).toEqual({ id, commands: ["approve", "retry"] });
    expect(body.startsWith(interpretReply(r)!)).toBe(true);
    expect(parseProposalMarker(interpretReply(r)!)).toBeNull();
    expect(() => proposalMarker("bad:id", ["approve"])).toThrow();
  });

  it("the proposal ID is the same for every delivery of one comment, and differs per comment and per item", () => {
    const id = proposalId("wi_1", "c1");
    expect(proposalId("wi_1", "c1")).toBe(id);
    expect(proposalId("wi_1", "c2")).not.toBe(id);
    expect(proposalId("wi_2", "c1")).not.toBe(id);
    expect(isProposalId(id)).toBe(true);
  });

  it("a press value names only the proposal and the index; anything else is no proposal press", () => {
    expect(proposalPress("sf_proposal:1", "prop_ab:1")).toEqual({ kind: "confirm", id: "prop_ab", index: 1 });
    expect(proposalPress("sf_proposal_all", "prop_ab")).toEqual({ kind: "confirm", id: "prop_ab", index: null });
    expect(proposalPress("sf_proposal_cancel", "prop_ab")).toEqual({ kind: "cancel", id: "prop_ab" });
    for (const [action, value] of [
      ["sf_proposal:1", "prop_ab:2"], ["sf_proposal:1", "prop_ab"], ["sf_proposal_all", "/approve ship it"], ["sf_proposal_cancel", "prop:ab"],
      ["sf_confirm", "prop_ab"], ["sf_proposal_all", null],
    ] as const) {
      expect(proposalPress(action, value)).toBeNull();
    }
  });
});

describe("command proposals: the controller applies a `factory confirm`", () => {
  const OWNER = "local:owner@example.com" as UserId;
  const HELPER = "local:helper@example.com" as UserId;
  const PROP = "prop_cli";
  const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", tier: 2 };

  /** The owner and a requester on the local auth plugin; items on a fake issue source, whose posts are the thread. */
  async function harness() {
    const { store, clock } = await newStore();
    const source = new FakeSource();
    const controller = new ControllerRole({
      store, source, auth: new OwnerAuth(store), clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false,
    });
    await store.claimLocalOwner(OWNER);
    await store.setLocalUserRole(HELPER, "requester", OWNER);
    let n = 0;
    const cli = (user: UserId): LocalCliDeps => ({ store, identity: { user, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => `k${++n}` });
    const at = async (n: number, patch: WorkItemPatch = SPEC_PENDING): Promise<WorkItem> => {
      const { item } = await store.createWorkItem(issue(n), system);
      const r = await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch });
      if (!r.ok) throw new Error("setup");
      return r.item;
    };
    /** `factory confirm` as `user`, then the controller's command step. */
    const confirm = async (user: UserId) => {
      expect((await runLocalCli(cli(user), { action: "confirm", proposal: PROP })).code).toBe(0);
      await controller.tickCommands();
    };
    const posts = (re: RegExp) => source.comments.filter((c) => re.test(c.marker));
    const statuses = async () => (await store.listCommandProposals(PROP)).map((r) => [r.idx, r.status, r.answered_by]);
    return { store, controller, at, confirm, posts, statuses };
  }

  it("applies each pending command once through the typed command's path; a second confirm applies nothing and says so", async () => {
    const h = await harness();
    const a = await h.at(1);
    const b = await h.at(2);
    await h.store.recordCommandProposals([
      { proposal_id: PROP, idx: 0, work_item_id: a.id, command: "approve", args: "ship it", author_id: OWNER },
      { proposal_id: PROP, idx: 1, work_item_id: b.id, command: "reject", args: "not needed", author_id: OWNER },
    ]);
    await h.confirm(OWNER);
    expect((await h.store.getWorkItem(a.id))!.stage).toBe("RUNNING");
    expect((await h.store.getWorkItem(b.id))!).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    const approved = (await h.store.listStateChanges(a.id)).filter((c) => c.reason === "spec_approved");
    expect(approved.map((c) => [c.actor, c.detail?.note])).toEqual([[{ kind: "user", id: OWNER }, "ship it"]]);
    expect(await h.statuses()).toEqual([[0, "applied", OWNER], [1, "applied", OWNER]]);
    expect(h.posts(/proposal-(refused|answered)/)).toEqual([]);

    const version = (await h.store.getWorkItem(a.id))!.version;
    // A second confirm: the CLI says nothing is pending and stores nothing; a row stored anyway (a race) applies nothing.
    const again = await runLocalCli({ store: h.store, identity: { user: OWNER, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "race" }, { action: "confirm", proposal: PROP });
    expect(again.lines[0]).toContain("nothing was applied");
    await h.store.appendCliCommand({ key: "cli:race", actor: OWNER, command: CONFIRM_COMMAND, args: { item: a.id, proposal: PROP } });
    await h.controller.tickCommands();
    await h.controller.tickCommands();
    expect((await h.store.getWorkItem(a.id))!.version).toBe(version);
    const answered = h.posts(/proposal-answered/);
    expect(answered).toHaveLength(1);
    expect(answered[0]!.body).toMatch(/^Nothing was applied this time/);
    expect(answered[0]!.body).toContain("was already applied");
  });

  it("a command the confirmer may not run is refused: its row marked refused, one reply saying why, the item unchanged", async () => {
    const h = await harness();
    const a = await h.at(3);
    await h.store.recordCommandProposals([{ proposal_id: PROP, idx: 0, work_item_id: a.id, command: "approve", args: "", author_id: HELPER }]);
    const before = await h.store.getWorkItem(a.id);
    await h.confirm(HELPER);
    await h.controller.tickCommands();
    expect(await h.store.getWorkItem(a.id)).toEqual(before);
    const [row] = await h.store.listCommandProposals(PROP);
    expect(row).toMatchObject({ status: "refused", answered_by: HELPER });
    const refused = h.posts(/proposal-refused/);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.body).toMatch(/^`\/approve` was not applied/);
    expect(refused[0]!.body).toContain(row!.refusal!);
  });

  it("a command whose item has moved on is refused: its row marked refused, one reply saying why; the next command still applies", async () => {
    const h = await harness();
    const moved = await h.at(4, { stage: "RUNNING", tier: 2 });
    const waiting = await h.at(5);
    await h.store.recordCommandProposals([
      { proposal_id: PROP, idx: 0, work_item_id: moved.id, command: "approve", args: "", author_id: OWNER },
      { proposal_id: PROP, idx: 1, work_item_id: waiting.id, command: "approve", args: "", author_id: OWNER },
    ]);
    await h.confirm(OWNER);
    expect((await h.store.getWorkItem(moved.id))!.version).toBe(moved.version);
    expect((await h.store.getWorkItem(waiting.id))!.stage).toBe("RUNNING");
    const rows = await h.store.listCommandProposals(PROP);
    expect(rows.map((r) => r.status)).toEqual(["refused", "applied"]);
    expect(rows[0]!.refusal).toContain("implementing");
    const refused = h.posts(/proposal-refused/);
    expect(refused).toHaveLength(1);
    // Answered in the thread of the item the confirm names: the first pending command's.
    expect(refused[0]!.source.id).toBe(moved.source.id);
    expect(refused[0]!.body).toContain(rows[0]!.refusal!);
  });
});
