import { describe, expect, it } from "vitest";
import { githubCommand, syncedCommand } from "../src/core/command-inbox.js";
import { issueRef } from "./helpers/fakes.js";

// GitHub comment commands as command inbox rows (issue #284): what the GitHub poll writes and the reader maps back.

const github = { provider: "github", subject: "1" };
const pr = { change_ref: "42", head_branch: "factory/wi_1" };

describe("GitHub command rows", () => {
  it("are keyed on the comment id, act as the numeric user id, and read back as the comment's event with provider github", () => {
    const row = githubCommand({ comment_id: 10, user_id: 1, command: "approve", text: "+paths src/a.ts\nok", source: issueRef(7) });
    expect(row).toEqual({ key: "github:10", actor: "github:1", command: "approve", args: { source: issueRef(7), text: "+paths src/a.ts\nok" } });
    expect(syncedCommand(row)).toEqual({
      source: issueRef(7),
      event: { kind: "spec_approved", source: issueRef(7), comment_id: "10", approver: github, note: "+paths src/a.ts\nok" },
    });
    expect(syncedCommand(githubCommand({ comment_id: 11, user_id: 1, command: "aprove", text: "", source: issueRef(7) }))?.event)
      .toEqual({ kind: "unknown_command", source: issueRef(7), comment_id: "11", requester: github, command: "aprove" });
  });

  it("give a command on a PR's conversation the PR the poll read", () => {
    const on = (command: string) => syncedCommand(githubCommand({ comment_id: 20, user_id: 1, command, text: "x", source: issueRef(42), pr }))?.event;
    expect(on("revise")).toMatchObject({ kind: "revise_requested", source: issueRef(42), feedback: "x", pr });
    expect(on("resolve")).toMatchObject({ kind: "resolve_requested", source: issueRef(42), notes: "x", pr });
    expect(on("verdict")).toMatchObject({ kind: "verdict_submitted", target: { kind: "pr", ...pr }, args: "x" });
  });

  it("write args.pr as change_ref, and read a row queued before the rename (legacy pr_number) as the same event", () => {
    const row = githubCommand({ comment_id: 21, user_id: 1, command: "revise", text: "x", source: issueRef(42), pr });
    expect(row.args.pr).toEqual({ change_ref: "42", head_branch: "factory/wi_1" });
    const legacy = { ...row, args: { ...row.args, pr: { pr_number: 42, head_branch: "factory/wi_1" } } };
    for (const command of ["revise", "resolve", "verdict"]) {
      const now = syncedCommand({ ...row, command });
      expect(now?.event).not.toBeNull();
      expect(syncedCommand({ ...legacy, command })).toEqual(now);
    }
    expect(syncedCommand(legacy)?.event).toMatchObject({ kind: "revise_requested", pr: { change_ref: "42", head_branch: "factory/wi_1" } });
    // A PR with neither name, or a legacy number that is not a whole number, gives no PR.
    expect(syncedCommand({ ...row, args: { ...row.args, pr: { head_branch: "factory/wi_1" } } })?.event).not.toHaveProperty("pr");
    expect(syncedCommand({ ...row, args: { ...row.args, pr: { pr_number: 4.2, head_branch: "factory/wi_1" } } })?.event).not.toHaveProperty("pr");
  });

  it("are only the rows the GitHub source wrote: CLI keys, local actors and rows with no source read as none", () => {
    const row = githubCommand({ comment_id: 30, user_id: 1, command: "approve", text: "", source: issueRef(7) });
    expect(syncedCommand({ ...row, key: "cli:abc" })).toBeNull();
    expect(syncedCommand({ ...row, actor: "local:me@example.com" })).toBeNull();
    expect(syncedCommand({ ...row, actor: "github:alice" })).toBeNull();
    expect(syncedCommand({ ...row, args: { text: "" } })).toBeNull();
  });
});
