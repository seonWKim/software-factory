import { describe, expect, it } from "vitest";
import { interpretReply, isProposalId, parseProposalMarker, proposalMarker } from "../src/core/interpret.js";
import { proposalId } from "../src/controller/units/commands/proposals.js";
import { proposalPress } from "../src/impl/source/slack-commands.js";
import { COMMAND_PROPOSALS_SQLITE } from "../src/impl/store/sql/command-proposals.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";

// Stored command proposals (design 04-gate-commands, issue #584): the table in both schemas, the reply's marker, the
// proposal ID and the press values. The store contract is in tests/store-contract.test.ts; the Slack buttons, the
// confirm path and its refusals end to end in tests/slack-source.test.ts.

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
