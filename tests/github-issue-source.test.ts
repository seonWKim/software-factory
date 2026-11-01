import { describe, expect, it } from "vitest";
import { WORK_STATUSES } from "../src/core/status-label.js";
import { GitHubClient, GitHubError } from "../src/impl/github/github-client.js";
import { GitHubIssueSource, statusLabels } from "../src/impl/source/github-issue-source.js";
import type { SecretStore } from "../src/interfaces/secret-store.js";
import { issueRef } from "./helpers/fakes.js";

/** Records every request; GET answers come from `responses` by path prefix (without query), else []. */
class FakeClient extends GitHubClient {
  calls: { method: string; path: string; body: unknown }[] = [];
  responses: Record<string, unknown[]> = {};

  constructor() {
    super({} as SecretStore, "http://unused");
  }
  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    if (method !== "GET") return {} as T;
    const bare = path.split("?")[0]!;
    // Pages after the first are always empty.
    if (!path.includes("page=1")) return [] as T;
    return (this.responses[bare] ?? []) as T;
  }
}

const user = { id: 1, login: "alice", type: "User" };
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
      { kind: "spec_approved", source: issueRef(7), comment_id: "10", approver: { provider: "github", subject: "1", login: "alice" }, note: "" },
      {
        kind: "spec_rejected", source: issueRef(7), comment_id: "11",
        approver: { provider: "github", subject: "1", login: "alice" }, reason: "too big\nsplit it",
      },
      { kind: "retry_requested", source: issueRef(7), comment_id: "12", requester: { provider: "github", subject: "1", login: "alice" } },
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
      { kind: "revise_requested", source: issueRef(7), comment_id: "20", requester: alice, feedback: "keep the CLI flag\nand drop the config key" },
      { kind: "revise_requested", source: issueRef(7), comment_id: "21", requester: alice, feedback: "" },
      { kind: "revise_requested", source: issueRef(7), comment_id: "22", requester: alice, feedback: "" },
      { kind: "spec_rejected", source: issueRef(7), comment_id: "23", approver: alice, reason: "" },
      { kind: "spec_rejected", source: issueRef(7), comment_id: "24", approver: alice, reason: "duplicate of #3" },
      // A longer word is not the command: it is an unknown one.
      { kind: "unknown_command", source: issueRef(7), comment_id: "25", requester: alice, command: "revised" },
      { kind: "unknown_command", source: issueRef(7), comment_id: "26", requester: alice, command: "rejectfoo" },
    ]);
  });

  it("emits one approval with its note, an unknown command for a typo, a help event, and nothing for other text", async () => {
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
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      { kind: "spec_approved", source: issueRef(7), comment_id: "40", approver: alice, note: "" },
      { kind: "spec_approved", source: issueRef(7), comment_id: "41", approver: alice, note: "keep the flag" },
      { kind: "spec_approved", source: issueRef(7), comment_id: "42", approver: alice, note: "first line\nsecond line" },
      { kind: "spec_approved", source: issueRef(7), comment_id: "43", approver: alice, note: "note below" },
      { kind: "unknown_command", source: issueRef(7), comment_id: "44", requester: alice, command: "aprove" },
      { kind: "help_requested", source: issueRef(7), comment_id: "45", requester: alice },
      { kind: "retry_requested", source: issueRef(7), comment_id: "49", requester: alice },
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
      { kind: "budget_continue", source: issueRef(7), comment_id: "30", approver, amount: null },
      { kind: "budget_continue", source: issueRef(7), comment_id: "31", approver, amount: "9000000" },
      { kind: "budget_continue", source: issueRef(7), comment_id: "32", approver, amount: "1.5" },
      // Not /budget: an unknown command word gets a reply (design §4).
      { kind: "unknown_command", source: issueRef(7), comment_id: "33", requester: approver, command: "budgetx" },
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
      { kind: "source_closed", source: issueRef(7), closer: { provider: "github", subject: "2", login: "bob" } },
      { kind: "source_closed", source: issueRef(9), closer: null },
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
      { kind: "source_closed", source: issueRef(10), closer: { provider: "github", subject: "2", login: "bob" } },
    ]);
    expect(client.calls.find((c) => c.path.startsWith("/repos/o/r/issues?state=closed"))!.path).toContain("since=2026-11-01T00:00:03Z");
    expect(client.calls.some((c) => c.path === "/repos/o/r/issues/9")).toBe(false);
    expect(JSON.parse(second.next_cursor)).toMatchObject({ closed: "2026-11-01T00:00:04Z" });
  });

  it("delivers closes after pull request events, so a merge that closes its issue is seen first", async () => {
    const { client, source } = make();
    client.closed = [closedIssue(7, "2026-11-01T00:00:01Z")];
    client.issues[7] = { number: 7, closed_by: bob };
    client.responses["/repos/o/r/pulls"] = [{
      number: 42, merged_at: null, merge_commit_sha: null, updated_at: "2026-11-01T00:00:01Z",
      head: { ref: "factory/wi_a", sha: "h" }, base: { ref: "main", sha: "b" },
    }];
    const { events } = await source.poll(null);
    expect(events.map((e) => e.kind)).toEqual(["pr_closed", "source_closed"]);
  });

  it("reads a cursor written before closed issues were polled", async () => {
    const { client, source } = make();
    client.closed = [closedIssue(7, "2026-11-01T00:00:01Z")];
    client.issues[7] = { number: 7, closed_by: bob };
    const old = JSON.stringify({ issues: null, comments: null, pulls: null });
    const { events } = await source.poll(old);
    expect(events).toEqual([{ kind: "source_closed", source: issueRef(7), closer: { provider: "github", subject: "2", login: "bob" } }]);
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
        kind: "verdict_submitted", target: { kind: "issue", source: issueRef(7) }, comment_id: "20", approver,
        args: "changes minor rename it\nand split the test",
      },
      { kind: "verdict_submitted", target: { kind: "issue", source: issueRef(7) }, comment_id: "21", approver, args: "" },
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
        comment_id: "30", approver, args: "accept none",
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

describe("GitHubIssueSource: unmergeable factory PRs", () => {
  const pull = (number: number, ref: string) => ({
    number, merged_at: null, merge_commit_sha: null, updated_at: "2026-11-01T00:00:00Z",
    head: { ref, sha: `head${number}` }, base: { ref: "main", sha: `base${number}` },
  });
  const full = (number: number, ref: string, mergeable: boolean | null) => ({ ...pull(number, ref), mergeable });

  /** Answers the single-PR GETs from `byNumber`; everything else as FakeClient. */
  class PrClient extends FakeClient {
    byNumber: Record<number, unknown> = {};
    open: unknown[] = [];
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (method === "GET" && path.startsWith("/repos/o/r/pulls?state=open")) {
        this.calls.push({ method, path, body });
        return (path.includes("page=1") ? this.open : []) as T;
      }
      const m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(path);
      if (method === "GET" && m) {
        this.calls.push({ method, path, body });
        return this.byNumber[Number(m[1])] as T;
      }
      return super.request<T>(method, path, body);
    }
  }

  it("emits pr_unmergeable only for open factory PRs whose mergeable is false", async () => {
    const client = new PrClient();
    const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main");
    client.open = [
      pull(1, "factory/wi_a"), pull(2, "factory/wi_b"), pull(3, "factory/wi_c"), pull(4, "feature/x"),
    ];
    client.byNumber = {
      1: full(1, "factory/wi_a", false),
      2: full(2, "factory/wi_b", true),
      3: full(3, "factory/wi_c", null),
      4: full(4, "feature/x", false),
    };
    const { events } = await source.poll(null);
    expect(events).toEqual([
      { kind: "pr_unmergeable", pr_number: 1, head_branch: "factory/wi_a", head_sha: "head1", base_sha: "base1" },
    ]);
    const gets = client.calls.filter((c) => c.method === "GET").map((c) => c.path);
    expect(gets.some((p) => p.startsWith("/repos/o/r/pulls?state=open"))).toBe(true);
    expect(gets.filter((p) => /^\/repos\/o\/r\/pulls\/\d+$/.test(p)).sort()).toEqual([
      "/repos/o/r/pulls/1", "/repos/o/r/pulls/2", "/repos/o/r/pulls/3",
    ]);
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
      { kind: "resolve_requested", source: issueRef(7), comment_id: "10", requester: alice, notes: "", pr: null },
      {
        kind: "resolve_requested", source: issueRef(7), comment_id: "11", requester: alice,
        notes: "keep main's API\n\n  and the new flag", pr: null,
      },
      { kind: "unknown_command", source: issueRef(7), comment_id: "12", requester: alice, command: "resolver" },
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
      prComment(23, "lgtm", 42), // not a command: no PR lookup
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      {
        kind: "resolve_requested", source: issueRef(42), comment_id: "20", requester: alice, notes: "take both",
        pr: { pr_number: 42, head_branch: "factory/wi_a" },
      },
    ]);
    const lookups = client.calls.filter((c) => /^\/repos\/o\/r\/pulls\/\d+$/.test(c.path)).map((c) => c.path);
    expect(lookups).toEqual(["/repos/o/r/pulls/42", "/repos/o/r/pulls/43", "/repos/o/r/pulls/44"]);
  });
});

describe("GitHubIssueSource: status labels", () => {
  /** Keeps repo labels and per-issue labels like GitHub does, and answers the labels endpoints from them. */
  class LabelClient extends GitHubClient {
    calls: { method: string; path: string; body: unknown }[] = [];
    repoLabels = new Map<string, { color: string; description: string }>();
    issueLabels = new Map<number, string[]>();

    constructor() {
      super({} as SecretStore, "http://unused");
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

  it("creates the label, adds it, then removes only other fixed-set status labels", async () => {
    const { client, source } = make();
    client.issueLabels.set(7, ["factory", "sf: triaging", "sf: custom", "bug"]);
    await source.setStatus(issueRef(7), "needs_approval", null);

    const def = statusLabels("sf: ").find((l) => l.status === "needs_approval")!;
    expect(client.calls).toEqual([
      { method: "POST", path: "/repos/o/r/labels", body: { name: "sf: needs approval", color: def.color, description: def.description } },
      { method: "POST", path: "/repos/o/r/issues/7/labels", body: { labels: ["sf: needs approval"] } },
      { method: "GET", path: "/repos/o/r/issues/7/labels?per_page=100&page=1", body: undefined },
      { method: "DELETE", path: `/repos/o/r/issues/7/labels/${enc("sf: triaging")}`, body: undefined },
    ]);
    expect(client.issueLabels.get(7)).toEqual(["factory", "sf: custom", "bug", "sf: needs approval"]);
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
