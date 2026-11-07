import { describe, expect, it } from "vitest";
import { WORK_STATUSES } from "../src/core/status-label.js";
import { GitHubClient, GitHubError } from "../src/impl/github/github-client.js";
import { GitHubIssueSource, statusLabels } from "../src/impl/github/github-issue-source.js";
import type { SecretStore } from "../src/interfaces/secret-store.js";
import { issueRef } from "./helpers/fakes.js";
import { RecordingGitHubClient as FakeClient } from "./helpers/github.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";

const user = { id: 1, login: "alice", type: "User" };
/** A command's identity: the numeric id only, as the command inbox row keeps it (issue #284); no login. */
const aliceId = { provider: "github", subject: "1" };
const comment = (id: number, body: string, updated_at: string, issue = 7) => ({
  id,
  issue_url: `https://api.github.com/repos/o/r/issues/${issue}`,
  body,
  user,
  updated_at,
});

function setup() {
  const client = new FakeClient();
  const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main");
  return { client, source };
}

describe("GitHubIssueSource", () => {
  it("reacts 👀 on a comment and on an issue with the exact endpoints and body", async () => {
    const { client, source } = setup();
    await source.markSeen(issueRef(7), "12345");
    await source.markSeen(issueRef(7), null);
    expect(client.calls).toEqual([
      { method: "POST", path: "/repos/o/r/issues/comments/12345/reactions", body: { content: "eyes" } },
      { method: "POST", path: "/repos/o/r/issues/7/reactions", body: { content: "eyes" } },
    ]);
  });

  it("passes the comment id through on command events", async () => {
    const { client, source } = setup();
    client.responses["/repos/o/r/issues/comments"] = [
      comment(10, "/approve", "2026-11-01T00:00:01Z"),
      comment(11, "/reject too big\nsplit it", "2026-11-01T00:00:02Z"),
      comment(12, "/retry", "2026-11-01T00:00:03Z"),
      comment(13, "looks good", "2026-11-01T00:00:04Z"),
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      { kind: "spec_approved", source: issueRef(7), comment_id: "10", approver: aliceId, note: "" },
      {
        kind: "spec_rejected", source: issueRef(7), comment_id: "11",
        approver: aliceId, reason: "too big\nsplit it",
      },
      { kind: "retry_requested", source: issueRef(7), comment_id: "12", requester: aliceId },
      { kind: "plain_comment", source: issueRef(7), comment_id: "13", author: { provider: "github", subject: "1", login: "alice" }, body: "looks good" },
    ]);
  });

  it("parses /revise with its feedback, and /reject with and without a reason", async () => {
    const { client, source } = setup();
    const alice = { provider: "github", subject: "1", login: "alice" };
    client.responses["/repos/o/r/issues/comments"] = [
      comment(20, "/revise keep the CLI flag\nand drop the config key", "2026-11-01T00:00:01Z"),
      comment(21, "/revise", "2026-11-01T00:00:02Z"),
      comment(22, "/revise   \n", "2026-11-01T00:00:03Z"),
      comment(23, "/reject", "2026-11-01T00:00:04Z"),
      comment(24, "/reject duplicate of #3", "2026-11-01T00:00:05Z"),
      comment(25, "/revised plan below", "2026-11-01T00:00:06Z"),
      comment(26, "/rejectfoo", "2026-11-01T00:00:07Z"),
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      { kind: "revise_requested", source: issueRef(7), comment_id: "20", requester: aliceId, feedback: "keep the CLI flag\nand drop the config key" },
      { kind: "revise_requested", source: issueRef(7), comment_id: "21", requester: aliceId, feedback: "" },
      { kind: "revise_requested", source: issueRef(7), comment_id: "22", requester: aliceId, feedback: "" },
      { kind: "spec_rejected", source: issueRef(7), comment_id: "23", approver: aliceId, reason: "" },
      { kind: "spec_rejected", source: issueRef(7), comment_id: "24", approver: aliceId, reason: "duplicate of #3" },
      // A longer word is not the command: it is an unknown one.
      { kind: "unknown_command", source: issueRef(7), comment_id: "25", requester: aliceId, command: "revised" },
      { kind: "unknown_command", source: issueRef(7), comment_id: "26", requester: aliceId, command: "rejectfoo" },
    ]);
  });

  it("emits one approval with its note, an unknown command for a typo, a help event, and a plain comment for other text", async () => {
    const { client, source } = setup();
    const alice = { provider: "github", subject: "1", login: "alice" };
    client.responses["/repos/o/r/issues/comments"] = [
      comment(40, "/approve", "2026-11-01T00:00:01Z"),
      comment(41, "/approve keep the flag", "2026-11-01T00:00:02Z"),
      comment(42, "/approve  first line\nsecond line\n", "2026-11-01T00:00:03Z"),
      comment(43, "/Approve\n\n  note below  ", "2026-11-01T00:00:04Z"),
      comment(44, "/aprove", "2026-11-01T00:00:05Z"),
      comment(45, "/help", "2026-11-01T00:00:06Z"),
      comment(46, "thanks!", "2026-11-01T00:00:07Z"),
      comment(47, "/", "2026-11-01T00:00:08Z"),
      comment(48, "/ approve", "2026-11-01T00:00:09Z"),
      comment(49, "/retry please", "2026-11-01T00:00:10Z"),
      comment(50, "/retry +paths src/a.ts docs/b.md\nkeep it small", "2026-11-01T00:00:11Z"),
      comment(51, "/approve +paths src/a.ts", "2026-11-01T00:00:12Z"),
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      { kind: "spec_approved", source: issueRef(7), comment_id: "40", approver: aliceId, note: "" },
      { kind: "spec_approved", source: issueRef(7), comment_id: "41", approver: aliceId, note: "keep the flag" },
      { kind: "spec_approved", source: issueRef(7), comment_id: "42", approver: aliceId, note: "first line\nsecond line" },
      { kind: "spec_approved", source: issueRef(7), comment_id: "43", approver: aliceId, note: "note below" },
      { kind: "unknown_command", source: issueRef(7), comment_id: "44", requester: aliceId, command: "aprove" },
      { kind: "help_requested", source: issueRef(7), comment_id: "45", requester: aliceId },
      // Text that is not a command is passed on whole, for a suggestion (design §4).
      { kind: "plain_comment", source: issueRef(7), comment_id: "46", author: alice, body: "thanks!" },
      { kind: "plain_comment", source: issueRef(7), comment_id: "47", author: alice, body: "/" },
      { kind: "plain_comment", source: issueRef(7), comment_id: "48", author: alice, body: "/ approve" },
      // /retry notes and +paths (issue #280) are passed on as typed; the controller splits and checks them.
      { kind: "retry_requested", source: issueRef(7), comment_id: "49", requester: aliceId, note: "please" },
      { kind: "retry_requested", source: issueRef(7), comment_id: "50", requester: aliceId, note: "+paths src/a.ts docs/b.md\nkeep it small" },
      { kind: "spec_approved", source: issueRef(7), comment_id: "51", approver: aliceId, note: "+paths src/a.ts" },
    ]);
  });

  it("emits plain_comment for a person's non-command issue comment, never for a bot's or a PR conversation's", async () => {
    const { client, source } = setup();
    const alice = { provider: "github", subject: "1", login: "alice" };
    client.responses["/repos/o/r/issues/comments"] = [
      comment(60, "ship it", "2026-11-01T00:00:01Z"),
      { ...comment(61, "ship it", "2026-11-01T00:00:02Z"), user: { id: 9, login: "sf[bot]", type: "Bot" } },
      { ...comment(62, "ship it", "2026-11-01T00:00:03Z", 8), html_url: "https://github.com/o/r/pull/8#issuecomment-62" },
      comment(63, "can you split this\ninto two parts?", "2026-11-01T00:00:04Z", 9),
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      { kind: "plain_comment", source: issueRef(7), comment_id: "60", author: alice, body: "ship it" },
      { kind: "plain_comment", source: issueRef(9), comment_id: "63", author: alice, body: "can you split this\ninto two parts?" },
    ]);
  });

  it("closes an issue as not planned", async () => {
    const { client, source } = setup();
    await source.closeIssue(issueRef(7));
    expect(client.calls).toEqual([
      { method: "PATCH", path: "/repos/o/r/issues/7", body: { state: "closed", state_reason: "not_planned" } },
    ]);
  });

  it("does not deliver a comment again once the cursor's high-water mark passed it", async () => {
    const { client, source } = setup();
    client.responses["/repos/o/r/issues/comments"] = [comment(10, "/approve", "2026-11-01T00:00:01Z")];
    const first = await source.poll(null);
    expect(first.events).toHaveLength(1);

    // `since` is inclusive: the next poll returns the same comment, and an edit of it, plus a new one.
    client.responses["/repos/o/r/issues/comments"] = [
      comment(10, "/approve", "2026-11-01T00:00:01Z"),
      comment(10, "/approve", "2026-11-01T00:00:05Z"),
      comment(14, "/retry", "2026-11-01T00:00:06Z"),
    ];
    const second = await source.poll(first.next_cursor);
    expect(second.events.map((e) => ("comment_id" in e ? e.comment_id : null))).toEqual(["14"]);
    expect(JSON.parse(second.next_cursor)).toMatchObject({ comments: "2026-11-01T00:00:06Z", last_comment_id: 14 });
  });

  it("parses /budget and its argument from the first line into budget_continue", async () => {
    const { client, source } = setup();
    const approver = { provider: "github", subject: "1", login: "alice" };
    client.responses["/repos/o/r/issues/comments"] = [
      comment(30, "/budget", "2026-11-01T00:00:01Z"),
      comment(31, "/budget 9000000\nmore room please", "2026-11-01T00:00:02Z"),
      comment(32, "  /budget   1.5  ", "2026-11-01T00:00:03Z"),
      comment(33, "/budgetx 5", "2026-11-01T00:00:04Z"),
      comment(34, "please /budget 5", "2026-11-01T00:00:05Z"),
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      { kind: "budget_continue", source: issueRef(7), comment_id: "30", approver: aliceId, amount: null },
      { kind: "budget_continue", source: issueRef(7), comment_id: "31", approver: aliceId, amount: "9000000" },
      { kind: "budget_continue", source: issueRef(7), comment_id: "32", approver: aliceId, amount: "1.5" },
      // Not /budget: an unknown command word gets a reply (design §4).
      { kind: "unknown_command", source: issueRef(7), comment_id: "33", requester: aliceId, command: "budgetx" },
      { kind: "plain_comment", source: issueRef(7), comment_id: "34", author: approver, body: "please /budget 5" },
    ]);
  });

  it("reads a cursor written before the high-water mark existed", async () => {
    const { client, source } = setup();
    client.responses["/repos/o/r/issues/comments"] = [comment(10, "/approve", "2026-11-01T00:00:01Z")];
    const old = JSON.stringify({ issues: null, comments: "2026-11-01T00:00:00Z", pulls: null });
    const { events } = await source.poll(old);
    expect(events).toHaveLength(1);
  });
});

describe("GitHubIssueSource: intake events carry the issue's updated_at (issue #254)", () => {
  it("item_requested has the open issue's updated_at as GitHub gave it", async () => {
    const { client, source } = setup();
    client.responses["/repos/o/r/issues"] = [{ number: 7, title: "t", body: "b", user, updated_at: "2026-11-07T09:00:00Z" }];
    const { events } = await source.poll(null);
    expect(events.find((e) => e.kind === "item_requested")).toMatchObject({
      kind: "item_requested", source: issueRef(7), title: "t", body: "b", updated_at: "2026-11-07T09:00:00Z",
    });
  });
});

describe("GitHubIssueSource: closed issues", () => {
  /** Answers the closed-issue list from `closed`, single-issue GETs from `issues`; everything else as FakeClient. */
  class ClosedClient extends FakeClient {
    closed: unknown[] = [];
    issues: Record<number, unknown> = {};
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (method === "GET" && path.startsWith("/repos/o/r/issues?state=closed")) {
        this.calls.push({ method, path, body });
        return (path.includes("page=1") ? this.closed : []) as T;
      }
      const m = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(path);
      if (method === "GET" && m) {
        this.calls.push({ method, path, body });
        return this.issues[Number(m[1])] as T;
      }
      return super.request<T>(method, path, body);
    }
  }
  const make = () => {
    const client = new ClosedClient();
    const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main");
    return { client, source };
  };
  const closedIssue = (number: number, updated_at: string, pr = false) => ({
    number, title: "t", body: null, user, updated_at, ...(pr ? { pull_request: {} } : {}),
  });
  const bob = { id: 2, login: "bob", type: "User" };

  it("emits source_closed with the closer for closed factory issues, skips pull requests, and advances its cursor", async () => {
    const { client, source } = make();
    client.closed = [closedIssue(7, "2026-11-01T00:00:01Z"), closedIssue(8, "2026-11-01T00:00:02Z", true), closedIssue(9, "2026-11-01T00:00:03Z")];
    client.issues[7] = { number: 7, closed_by: bob };
    client.issues[9] = { number: 9, closed_by: null };
    const first = await source.poll(null);
    expect(first.events).toEqual([
      { kind: "source_closed", source: issueRef(7), closer: { provider: "github", subject: "2", login: "bob" }, state_reason: null },
      { kind: "source_closed", source: issueRef(9), closer: null, state_reason: null },
    ]);
    const list = client.calls.find((c) => c.path.startsWith("/repos/o/r/issues?state=closed"))!;
    expect(list.path).toContain(`labels=factory`);
    expect(list.path).not.toContain("since=");
    // The pull request's closer is never looked up.
    expect(client.calls.some((c) => c.path === "/repos/o/r/issues/8")).toBe(false);
    expect(JSON.parse(first.next_cursor)).toMatchObject({ closed: "2026-11-01T00:00:03Z" });

    // `since` is inclusive: #9 comes back unchanged and is not delivered again; #10 is new.
    client.calls = [];
    client.closed = [closedIssue(9, "2026-11-01T00:00:03Z"), closedIssue(10, "2026-11-01T00:00:04Z")];
    client.issues[10] = { number: 10, closed_by: bob };
    const second = await source.poll(first.next_cursor);
    expect(second.events).toEqual([
      { kind: "source_closed", source: issueRef(10), closer: { provider: "github", subject: "2", login: "bob" }, state_reason: null },
    ]);
    expect(client.calls.find((c) => c.path.startsWith("/repos/o/r/issues?state=closed"))!.path).toContain("since=2026-11-01T00:00:03Z");
    expect(client.calls.some((c) => c.path === "/repos/o/r/issues/9")).toBe(false);
    expect(JSON.parse(second.next_cursor)).toMatchObject({ closed: "2026-11-01T00:00:04Z" });
  });

  it("returns no PR event, whatever the pull lists hold, and reads no pull list (issue #273)", async () => {
    const { client, source } = make();
    client.closed = [closedIssue(7, "2026-11-01T00:00:01Z")];
    client.issues[7] = { number: 7, closed_by: bob };
    client.responses["/repos/o/r/pulls"] = [{
      number: 42, merged_at: "2026-11-01T00:00:01Z", merge_commit_sha: "m", updated_at: "2026-11-01T00:00:01Z",
      head: { ref: "factory/wi_a", sha: "h" }, base: { ref: "main", sha: "b" },
    }];
    const { events } = await source.poll(null);
    const prKinds = ["pr_merged", "pr_closed", "pr_open", "pr_unmergeable", "pr_changes_requested"];
    expect(events.filter((e) => prKinds.includes(e.kind))).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(["source_closed"]);
    expect(client.calls.filter((c) => c.path.startsWith("/repos/o/r/pulls"))).toEqual([]);
  });

  it("reads a cursor from before issue #273, PR position included, without error", async () => {
    const { client, source } = make();
    client.closed = [closedIssue(7, "2026-11-01T00:00:01Z")];
    client.issues[7] = { number: 7, closed_by: bob };
    const old = JSON.stringify({
      issues: null, comments: null, pulls: "2026-10-01T00:00:00Z", start: "2026-09-01T00:00:00Z", reviews: "2026-10-01T00:00:00Z", review_ids: [1],
    });
    const { events, next_cursor } = await source.poll(old);
    expect(events.map((e) => e.kind)).toEqual(["source_closed"]);
    // The PR position is carried along unread; the forge starts from it (GitHubForge.handover_cursor).
    expect(JSON.parse(next_cursor)).toMatchObject({ pulls: "2026-10-01T00:00:00Z", start: "2026-09-01T00:00:00Z" });
  });

  it("carries GitHub's close reason: completed and not_planned as they are, anything else as null", async () => {
    const { client, source } = make();
    client.closed = [
      closedIssue(7, "2026-11-01T00:00:01Z"), closedIssue(8, "2026-11-01T00:00:02Z"),
      closedIssue(9, "2026-11-01T00:00:03Z"), closedIssue(10, "2026-11-01T00:00:04Z"),
    ];
    client.issues[7] = { number: 7, closed_by: bob, state_reason: "completed" };
    client.issues[8] = { number: 8, closed_by: bob, state_reason: "not_planned" };
    client.issues[9] = { number: 9, closed_by: bob, state_reason: null };
    client.issues[10] = { number: 10, closed_by: bob, state_reason: "something_new" };
    const { events } = await source.poll(null);
    expect(events.map((e) => (e.kind === "source_closed" ? e.state_reason : e.kind))).toEqual(["completed", "not_planned", null, null]);
  });

  it("reads a cursor written before closed issues were polled", async () => {
    const { client, source } = make();
    client.closed = [closedIssue(7, "2026-11-01T00:00:01Z")];
    client.issues[7] = { number: 7, closed_by: bob };
    const old = JSON.stringify({ issues: null, comments: null, pulls: null });
    const { events } = await source.poll(old);
    expect(events).toEqual([{ kind: "source_closed", source: issueRef(7), closer: { provider: "github", subject: "2", login: "bob" }, state_reason: null }]);
  });
});

describe("GitHubIssueSource: /verdict", () => {
  /** Answers GET /issues/N and GET /pulls/N from `issues` and `pulls`; everything else as FakeClient. */
  class VerdictClient extends FakeClient {
    issues: Record<number, unknown> = {};
    pulls: Record<number, unknown> = {};
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const m = /^\/repos\/o\/r\/(issues|pulls)\/(\d+)$/.exec(path);
      if (method === "GET" && m) {
        this.calls.push({ method, path, body });
        return (m[1] === "issues" ? this.issues : this.pulls)[Number(m[2])] as T;
      }
      return super.request<T>(method, path, body);
    }
  }
  const make = () => {
    const client = new VerdictClient();
    const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main");
    return { client, source };
  };
  const approver = { provider: "github", subject: "1", login: "alice" };

  it("emits verdict_submitted with the raw arguments for a comment on an issue", async () => {
    const { client, source } = make();
    client.issues[7] = { number: 7 };
    client.responses["/repos/o/r/issues/comments"] = [
      comment(20, "/verdict changes minor rename it\nand split the test", "2026-11-01T00:00:01Z"),
      comment(21, "/verdict", "2026-11-01T00:00:02Z"),
      comment(22, "/verdict/x accept none", "2026-11-01T00:00:03Z"),
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      {
        kind: "verdict_submitted", target: { kind: "issue", source: issueRef(7) }, comment_id: "20", approver: aliceId,
        args: "changes minor rename it\nand split the test",
      },
      { kind: "verdict_submitted", target: { kind: "issue", source: issueRef(7) }, comment_id: "21", approver: aliceId, args: "" },
      { kind: "plain_comment", source: issueRef(7), comment_id: "22", author: approver, body: "/verdict/x accept none" },
    ]);
  });

  it("names the PR and its head branch for a comment on a factory PR, and skips other PRs", async () => {
    const { client, source } = make();
    client.issues[42] = { number: 42, pull_request: {} };
    client.issues[43] = { number: 43, pull_request: {} };
    client.pulls[42] = { number: 42, head: { ref: "factory/wi_a", sha: "h" }, base: { ref: "main", sha: "b" } };
    client.pulls[43] = { number: 43, head: { ref: "feature/x", sha: "h" }, base: { ref: "main", sha: "b" } };
    client.responses["/repos/o/r/issues/comments"] = [
      comment(30, "/verdict accept none", "2026-11-01T00:00:01Z", 42),
      comment(31, "/verdict accept none", "2026-11-01T00:00:02Z", 43),
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      {
        kind: "verdict_submitted", target: { kind: "pr", pr_number: 42, head_branch: "factory/wi_a" },
        comment_id: "30", approver: aliceId, args: "accept none",
      },
    ]);
    const gets = client.calls.filter((c) => /^\/repos\/o\/r\/(issues|pulls)\/\d+$/.test(c.path)).map((c) => c.path);
    expect(gets).toEqual(["/repos/o/r/issues/42", "/repos/o/r/pulls/42", "/repos/o/r/issues/43", "/repos/o/r/pulls/43"]);
  });
});

describe("GitHubIssueSource: base-branch commits", () => {
  const commit = (sha: string, message: string, date: string) => ({ sha, commit: { message, committer: { date } } });

  it("emits one base_commit per new commit on the base branch, oldest first, and cursors on the commit date", async () => {
    const { client, source } = setup();
    // The commits endpoint returns newest first.
    client.responses["/repos/o/r/commits"] = [
      commit("c2", "Revert \"x (#3)\" (#4)", "2026-11-01T00:00:02Z"),
      commit("c1", "first", "2026-11-01T00:00:01Z"),
    ];
    const first = await source.poll(null);
    expect(first.events.filter((e) => e.kind === "base_commit")).toEqual([
      { kind: "base_commit", sha: "c1", message: "first" },
      { kind: "base_commit", sha: "c2", message: "Revert \"x (#3)\" (#4)" },
    ]);
    const call = client.calls.find((c) => c.path.startsWith("/repos/o/r/commits"))!;
    expect(call.path).toContain("sha=main");
    expect(call.path).not.toContain("since=");
    expect(JSON.parse(first.next_cursor)).toMatchObject({ commits: "2026-11-01T00:00:02Z" });

    // `since` is inclusive: c2 comes back with a new commit; only c3 is new.
    client.calls = [];
    client.responses["/repos/o/r/commits"] = [
      commit("c3", "third", "2026-11-01T00:00:03Z"),
      commit("c2", "Revert \"x (#3)\" (#4)", "2026-11-01T00:00:02Z"),
    ];
    const second = await source.poll(first.next_cursor);
    expect(second.events.filter((e) => e.kind === "base_commit")).toEqual([{ kind: "base_commit", sha: "c3", message: "third" }]);
    const again = client.calls.find((c) => c.path.startsWith("/repos/o/r/commits"))!;
    expect(again.path).toContain("since=2026-11-01T00:00:02Z");
    expect(JSON.parse(second.next_cursor)).toMatchObject({ commits: "2026-11-01T00:00:03Z" });
  });

  it("reads a cursor written before commits were polled", async () => {
    const { client, source } = setup();
    client.responses["/repos/o/r/commits"] = [commit("c1", "first", "2026-11-01T00:00:01Z")];
    const old = JSON.stringify({ issues: null, comments: null, pulls: null });
    const { events } = await source.poll(old);
    expect(events).toEqual([{ kind: "base_commit", sha: "c1", message: "first" }]);
  });
});

describe("GitHubIssueSource: /resolve", () => {
  const alice = { provider: "github", subject: "1", login: "alice" };
  const prComment = (id: number, body: string, pr: number) => ({
    ...comment(id, body, `2026-11-01T00:00:${String(id).padStart(2, "0")}Z`, pr),
    html_url: `https://github.com/o/r/pull/${pr}#issuecomment-${id}`,
  });

  /** Answers GET /pulls/<n> from `pulls` (404 when absent); everything else as FakeClient. */
  class PullClient extends FakeClient {
    pulls: Record<number, { number: number; head: { ref: string; sha: string } }> = {};
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(path);
      if (method === "GET" && m) {
        this.calls.push({ method, path, body });
        const p = this.pulls[Number(m[1])];
        if (!p) throw new GitHubError(404, "Not Found");
        return p as T;
      }
      return super.request<T>(method, path, body);
    }
  }

  it("turns /resolve on an issue into resolve_requested with the notes (rest of the comment, trimmed)", async () => {
    const { client, source } = setup();
    client.responses["/repos/o/r/issues/comments"] = [
      comment(10, "/resolve", "2026-11-01T00:00:01Z"),
      comment(11, "  /resolve keep main's API  \n\n  and the new flag \n", "2026-11-01T00:00:02Z"),
      comment(12, "/resolver nope", "2026-11-01T00:00:03Z"),
      comment(13, "please /resolve", "2026-11-01T00:00:04Z"),
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      { kind: "resolve_requested", source: issueRef(7), comment_id: "10", requester: aliceId, notes: "", pr: null },
      {
        kind: "resolve_requested", source: issueRef(7), comment_id: "11", requester: aliceId,
        notes: "keep main's API\n\n  and the new flag", pr: null,
      },
      { kind: "unknown_command", source: issueRef(7), comment_id: "12", requester: aliceId, command: "resolver" },
      { kind: "plain_comment", source: issueRef(7), comment_id: "13", author: alice, body: "please /resolve" },
    ]);
  });

  it("a /resolve on a factory PR's conversation names the PR and its head branch, and its source is the PR", async () => {
    const client = new PullClient();
    const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main");
    client.pulls[42] = { number: 42, head: { ref: "factory/wi_a", sha: "h" } };
    client.pulls[43] = { number: 43, head: { ref: "feature/x", sha: "h" } };
    client.responses["/repos/o/r/issues/comments"] = [
      prComment(20, "/resolve take both", 42),
      prComment(21, "/resolve", 43), // not a factory PR: ignored
      prComment(22, "/resolve", 44), // PR gone (404): ignored, the poll still succeeds
      prComment(23, "lgtm", 42), // not a command: no PR lookup, and no plain_comment on a PR conversation
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      {
        kind: "resolve_requested", source: issueRef(42), comment_id: "20", requester: aliceId, notes: "take both",
        pr: { pr_number: 42, head_branch: "factory/wi_a" },
      },
    ]);
    const lookups = client.calls.filter((c) => /^\/repos\/o\/r\/pulls\/\d+$/.test(c.path)).map((c) => c.path);
    expect(lookups).toEqual(["/repos/o/r/pulls/42", "/repos/o/r/pulls/43", "/repos/o/r/pulls/44"]);
  });

  it("/revise on a PR's conversation names the PR and its head branch, factory or not; a PR that is gone is ignored", async () => {
    const client = new PullClient();
    const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main");
    client.pulls[14] = { number: 14, head: { ref: "factory/wi_a", sha: "h" } };
    client.pulls[10] = { number: 10, head: { ref: "feature/x", sha: "h" } };
    const onPr = (id: number, body: string, pr: number) => ({
      ...comment(id, body, `2026-11-01T00:00:${String(id).padStart(2, "0")}Z`, pr),
      html_url: `https://github.com/o/r/pull/${pr}#issuecomment-${id}`,
    });
    client.responses["/repos/o/r/issues/comments"] = [
      onPr(30, "/revise rename the flag\nkeep an alias", 14),
      onPr(31, "/revise", 10),
      { ...onPr(32, "/revise x", 44), html_url: "https://github.com/o/r/pull/44#issuecomment-32" },
      comment(33, "/revise on the issue", "2026-11-01T00:00:33Z", 7),
    ];
    // PR 44 is gone (404): its comment is ignored and the poll still succeeds.
    const { events } = await source.poll(null);
    expect(events.filter((e) => e.kind === "revise_requested")).toEqual([
      {
        kind: "revise_requested", source: issueRef(14), comment_id: "30", requester: aliceId, feedback: "rename the flag\nkeep an alias",
        pr: { pr_number: 14, head_branch: "factory/wi_a" },
      },
      { kind: "revise_requested", source: issueRef(10), comment_id: "31", requester: aliceId, feedback: "", pr: { pr_number: 10, head_branch: "feature/x" } },
      { kind: "revise_requested", source: issueRef(7), comment_id: "33", requester: aliceId, feedback: "on the issue" },
    ]);
  });
});

describe("GitHubIssueSource: status labels", () => {
  /** Keeps repo labels and per-issue labels like GitHub does, and answers the labels endpoints from them. */
  class LabelClient extends GitHubClient {
    calls: { method: string; path: string; body: unknown }[] = [];
    repoLabels = new Map<string, { color: string; description: string }>();
    issueLabels = new Map<number, string[]>();

    constructor() {
      super({} as GitHubCredentials, "http://unused");
    }
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      this.calls.push({ method, path, body });
      const bare = path.split("?")[0]!;
      if (method === "POST" && bare === "/repos/o/r/labels") {
        const b = body as { name: string; color: string; description: string };
        if (this.repoLabels.has(b.name)) {
          throw new GitHubError(422, `GitHub POST ${path} → 422 {"message":"Validation Failed","errors":[{"resource":"Label","code":"already_exists","field":"name"}]}`);
        }
        this.repoLabels.set(b.name, { color: b.color, description: b.description });
        return {} as T;
      }
      let m = /^\/repos\/o\/r\/issues\/(\d+)\/labels$/.exec(bare);
      if (m) {
        const n = Number(m[1]);
        const have = this.issueLabels.get(n) ?? [];
        if (method === "POST") {
          for (const l of (body as { labels: string[] }).labels) if (!have.includes(l)) have.push(l);
          this.issueLabels.set(n, have);
          return [] as T;
        }
        if (method === "GET") return (path.includes("page=1") ? have.map((name) => ({ name })) : []) as T;
      }
      m = /^\/repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/.exec(bare);
      if (m && method === "DELETE") {
        const n = Number(m[1]);
        const name = decodeURIComponent(m[2]!);
        const have = this.issueLabels.get(n) ?? [];
        if (!have.includes(name)) throw new GitHubError(404, `GitHub DELETE ${path} → 404`);
        this.issueLabels.set(n, have.filter((l) => l !== name));
        return [] as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    }
  }

  const make = (prefix?: string) => {
    const client = new LabelClient();
    const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main", prefix);
    return { client, source };
  };
  const enc = encodeURIComponent;

  it("has one table of eight labels: prefix plus suffix, colour, description", () => {
    const labels = statusLabels("sf: ");
    expect(labels.map((l) => l.status)).toEqual([...WORK_STATUSES]);
    expect(labels.find((l) => l.status === "needs_approval")!.name).toBe("sf: needs approval");
    for (const l of labels) {
      expect(l.color).toMatch(/^[0-9a-f]{6}$/);
      expect(l.description.length).toBeGreaterThan(0);
      expect(l.description.length).toBeLessThanOrEqual(100);
    }
    expect(statusLabels("x/").find((l) => l.status === "done")!.name).toBe("x/done");
  });

  it("reads the labels, creates the label, adds it, then removes only other fixed-set status labels", async () => {
    const { client, source } = make();
    client.issueLabels.set(7, ["factory", "sf: triaging", "sf: custom", "bug"]);
    await source.setStatus(issueRef(7), "needs_approval", null);

    const def = statusLabels("sf: ").find((l) => l.status === "needs_approval")!;
    expect(client.calls).toEqual([
      { method: "GET", path: "/repos/o/r/issues/7/labels?per_page=100&page=1", body: undefined },
      { method: "POST", path: "/repos/o/r/labels", body: { name: "sf: needs approval", color: def.color, description: def.description } },
      { method: "POST", path: "/repos/o/r/issues/7/labels", body: { labels: ["sf: needs approval"] } },
      { method: "DELETE", path: `/repos/o/r/issues/7/labels/${enc("sf: triaging")}`, body: undefined },
    ]);
    expect(client.issueLabels.get(7)).toEqual(["factory", "sf: custom", "bug", "sf: needs approval"]);
  });

  it("makes one read and no write when the labels are already right (GitHub call budget)", async () => {
    const { client, source } = make();
    client.issueLabels.set(7, ["factory", "sf: implementing"]);
    await source.setStatus(issueRef(7), "implementing", null);
    expect(client.calls).toEqual([{ method: "GET", path: "/repos/o/r/issues/7/labels?per_page=100&page=1", body: undefined }]);
  });

  it("only removes the stale status label when the target is already there", async () => {
    const { client, source } = make();
    client.issueLabels.set(7, ["sf: implementing", "sf: triaging"]);
    await source.setStatus(issueRef(7), "implementing", null);
    expect(client.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(client.issueLabels.get(7)).toEqual(["sf: implementing"]);
  });

  it("treats an existing label (422 already exists) as created, and changes nothing on a repeat call", async () => {
    const { client, source } = make();
    await source.setStatus(issueRef(7), "implementing", null);
    const after = [...client.issueLabels.get(7)!];
    const labels = new Map(client.repoLabels);
    client.calls = [];
    await source.setStatus(issueRef(7), "implementing", null);
    expect(client.issueLabels.get(7)).toEqual(after);
    expect(client.repoLabels).toEqual(labels);
    expect(client.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("rethrows a 422 that is not 'already exists'", async () => {
    const { client, source } = make();
    client.request = async <T>(method: string, path: string): Promise<T> => {
      throw new GitHubError(422, `GitHub ${method} ${path} → 422 {"message":"Validation Failed","errors":[{"code":"invalid","field":"color"}]}`);
    };
    await expect(source.setStatus(issueRef(7), "done", null)).rejects.toThrow(/invalid/);
  });

  it("counts a 404 on DELETE as success (label already gone)", async () => {
    const { client, source } = make();
    client.issueLabels.set(7, ["sf: triaging"]);
    const real = client.request.bind(client);
    client.request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (method === "DELETE") {
        client.calls.push({ method, path, body });
        throw new GitHubError(404, "gone");
      }
      return real<T>(method, path, body);
    };
    await expect(source.setStatus(issueRef(7), "implementing", null)).resolves.toBeUndefined();
  });

  it("labels the PR, not the issue, when pr_number is given", async () => {
    const { client, source } = make();
    await source.setStatus(issueRef(7), "in_review", 42);
    expect(client.issueLabels.get(42)).toEqual(["sf: in review"]);
    expect(client.issueLabels.has(7)).toBe(false);
  });

  it("uses the configured prefix", async () => {
    const { client, source } = make("factory/");
    client.issueLabels.set(7, ["sf: triaging"]);
    await source.setStatus(issueRef(7), "done", null);
    expect(client.issueLabels.get(7)).toEqual(["sf: triaging", "factory/done"]);
  });
});

describe("GitHubIssueSource: split phases (design 2026-11-01)", () => {
  /** Answers POST /issues with a new issue and GETs from `responses`; the sub-issue link can be made to fail. */
  class SubIssueClient extends FakeClient {
    nextNumber = 20;
    linkError: GitHubError | null = null;
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (method === "POST" && path === "/repos/o/r/issues") {
        this.calls.push({ method, path, body });
        const n = this.nextNumber++;
        return { id: 9000 + n, number: n, body: (body as { body: string }).body } as T;
      }
      if (method === "POST" && path.endsWith("/sub_issues") && this.linkError) {
        this.calls.push({ method, path, body });
        throw this.linkError;
      }
      return super.request<T>(method, path, body);
    }
  }
  const make = () => {
    const client = new SubIssueClient();
    const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main");
    return { client, source };
  };
  const input = { parent: issueRef(5), title: "Phase 1/2: core", body: "the phase text", marker: "<!-- factory:phase:wi_p:1 -->" };
  const writes = (c: FakeClient) => c.calls.filter((x) => x.method !== "GET");

  it("files the issue with the factory label and the marker, then links it to the parent as a sub-issue", async () => {
    const { client, source } = make();
    expect(await source.fileSubIssue(input)).toEqual(issueRef(20));
    expect(writes(client)).toEqual([
      {
        method: "POST",
        path: "/repos/o/r/issues",
        body: { title: "Phase 1/2: core", body: "the phase text\n\n<!-- factory:phase:wi_p:1 -->", labels: ["factory"] },
      },
      { method: "POST", path: "/repos/o/r/issues/5/sub_issues", body: { sub_issue_id: 9020 } },
    ]);
  });

  it("an issue already linked with the marker is returned with nothing filed", async () => {
    const { client, source } = make();
    client.responses["/repos/o/r/issues/5/sub_issues"] = [{ id: 9011, number: 11, body: `text\n\n${input.marker}` }];
    expect(await source.fileSubIssue(input)).toEqual(issueRef(11));
    expect(writes(client)).toEqual([]);
  });

  it("an issue filed earlier but never linked is linked, not filed again", async () => {
    const { client, source } = make();
    client.responses["/repos/o/r/issues"] = [
      { id: 9012, number: 12, body: "another issue" },
      { id: 9013, number: 13, body: `text\n\n${input.marker}` },
    ];
    expect(await source.fileSubIssue(input)).toEqual(issueRef(13));
    expect(writes(client)).toEqual([{ method: "POST", path: "/repos/o/r/issues/5/sub_issues", body: { sub_issue_id: 9013 } }]);
  });

  it("a failed link is thrown, so the caller retries", async () => {
    const { client, source } = make();
    client.linkError = new GitHubError(500, "boom");
    await expect(source.fileSubIssue(input)).rejects.toThrow("boom");
  });

  it("closes an issue as completed when asked", async () => {
    const { client, source } = make();
    await source.closeIssue(issueRef(5), "completed");
    expect(client.calls).toEqual([
      { method: "PATCH", path: "/repos/o/r/issues/5", body: { state: "closed", state_reason: "completed" } },
    ]);
  });
});

