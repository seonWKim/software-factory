import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubError } from "../src/impl/github/github-client.js";
import { GitHubForge } from "../src/impl/github/github-forge.js";
import type { PollContext } from "../src/impl/github/github-issue-source.js";
import type { ForgeEvent } from "../src/interfaces/forge.js";
import { issueRef, recordingLog } from "./helpers/fakes.js";
import { RecordingGitHubClient as FakeClient, pollContext } from "./helpers/github.js";

/** Stands in for the GitHub source's postComment and setStatus where PR comments and labels are not under test. */
const noWrites = { postComment: async () => ({ url: null }), setStatus: async () => undefined };

/** The GitHub forge over `client`. */
function forgeOf(client: FakeClient, ctx: PollContext = pollContext()): GitHubForge {
  return new GitHubForge(client, { owner: "o", name: "r" }, "factory/", "main", noWrites, ctx);
}

const user = { id: 1, login: "alice", type: "User" };

describe("GitHubForge: closePr", () => {
  /** Answers GET /pulls/N from `pulls` and GET /issues/N from `issues`; records every call; comments via commentOnce. */
  class PrClient extends FakeClient {
    pulls: Record<number, unknown> = {};
    issues: Record<number, unknown> = {};
    failClose = false;
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const m = /^\/repos\/o\/r\/(issues|pulls)\/(\d+)$/.exec(path);
      if (method === "GET" && m) {
        this.calls.push({ method, path, body });
        return (m[1] === "issues" ? this.issues : this.pulls)[Number(m[2])] as T;
      }
      if (method === "PATCH" && this.failClose) throw new GitHubError(500, "boom");
      return super.request<T>(method, path, body);
    }
  }
  const make = () => {
    const client = new PrClient();
    const forge = forgeOf(client);
    return { client, forge };
  };
  const body = (closer: { login?: string } | null) => `closed by ${closer?.login ?? "nobody"}`;
  const input = { pr: 42, closed: issueRef(7), marker: "<!-- m -->", body };

  it("comments with the issue's closer, then closes the open PR without merging", async () => {
    const { client, forge } = make();
    client.pulls[42] = { number: 42, state: "open", merged_at: null };
    client.issues[7] = { number: 7, closed_by: { id: 2, login: "bob", type: "User" } };
    expect(await forge.closePr(input)).toBe("closed");
    const writes = client.calls.filter((c) => c.method !== "GET");
    expect(writes).toEqual([
      { method: "POST", path: "/repos/o/r/issues/42/comments", body: { body: "closed by bob\n\n<!-- m -->" } },
      { method: "PATCH", path: "/repos/o/r/pulls/42", body: { state: "closed" } },
    ]);
    expect(client.calls.some((c) => c.path.includes("/merge"))).toBe(false);
  });

  it("with no closer on the issue, the body gets null", async () => {
    const { client, forge } = make();
    client.pulls[42] = { number: 42, state: "open", merged_at: null };
    client.issues[7] = { number: 7, closed_by: null };
    await forge.closePr(input);
    expect(client.calls.find((c) => c.method === "POST")!.body).toEqual({ body: "closed by nobody\n\n<!-- m -->" });
  });

  it("leaves a merged or closed PR alone: no comment, no close", async () => {
    for (const pr of [{ state: "closed", merged_at: "2026-11-01T00:00:00Z" }, { state: "closed", merged_at: null }]) {
      const { client, forge } = make();
      client.pulls[42] = { number: 42, ...pr };
      client.issues[7] = { number: 7, closed_by: null };
      expect(await forge.closePr(input)).toBe("not_open");
      expect(client.calls.filter((c) => c.method !== "GET")).toEqual([]);
    }
  });

  it("a failed close throws, after the comment; the retry does not post it again", async () => {
    const { client, forge } = make();
    client.pulls[42] = { number: 42, state: "open", merged_at: null };
    client.issues[7] = { number: 7, closed_by: null };
    client.failClose = true;
    await expect(forge.closePr(input)).rejects.toThrow();
    // The comment is now on the PR; commentOnce finds its marker on the retry.
    client.responses["/repos/o/r/issues/42/comments"] = [{ body: "closed by nobody\n\n<!-- m -->" }];
    client.failClose = false;
    client.calls = [];
    expect(await forge.closePr(input)).toBe("closed");
    expect(client.calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "PATCH", path: "/repos/o/r/pulls/42", body: { state: "closed" } },
    ]);
  });
});


describe("GitHubForge: unmergeable factory PRs", () => {
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

  it("emits change_unmergeable only for open factory PRs whose mergeable is false", async () => {
    const client = new PrClient();
    const forge = forgeOf(client);
    client.open = [
      pull(1, "factory/wi_a"), pull(2, "factory/wi_b"), pull(3, "factory/wi_c"), pull(4, "feature/x"),
    ];
    client.byNumber = {
      1: full(1, "factory/wi_a", false),
      2: full(2, "factory/wi_b", true),
      3: full(3, "factory/wi_c", null),
      4: full(4, "feature/x", false),
    };
    const { events } = await forge.poll(null);
    expect(events.filter((e) => e.kind === "change_unmergeable")).toEqual([
      { kind: "change_unmergeable", change_ref: "1", head_branch: "factory/wi_a", head_sha: "head1", base_sha: "base1" },
    ]);
    const gets = client.calls.filter((c) => c.method === "GET").map((c) => c.path);
    expect(gets.some((p) => p.startsWith("/repos/o/r/pulls?state=open"))).toBe(true);
    expect(gets.filter((p) => /^\/repos\/o\/r\/pulls\/\d+$/.test(p)).sort()).toEqual([
      "/repos/o/r/pulls/1", "/repos/o/r/pulls/2", "/repos/o/r/pulls/3",
    ]);
  });
});


describe("GitHubForge.prChecks", () => {
  /** Answers GET /pulls/42 with head sha "h1", and the check runs and commit statuses of "h1". */
  class ChecksClient extends FakeClient {
    runs: { name: string; status: string; conclusion: string | null }[] = [];
    statuses: { context: string; state: string }[] = [];
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      this.calls.push({ method, path, body });
      const bare = path.split("?")[0]!;
      if (bare === "/repos/o/r/pulls/42") return { number: 42, head: { ref: "factory/wi_a", sha: "h1" } } as T;
      if (bare === "/repos/o/r/commits/h1/check-runs") {
        return { total_count: this.runs.length, check_runs: path.includes("page=1") ? this.runs : [] } as T;
      }
      if (bare === "/repos/o/r/commits/h1/status") {
        return { state: "pending", total_count: this.statuses.length, statuses: this.statuses } as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    }
  }
  const run = (name: string, status: string, conclusion: string | null = null) => ({ name, status, conclusion });
  function make() {
    const client = new ChecksClient();
    return { client, forge: forgeOf(client) };
  }

  it("reads the check runs and statuses of the PR's head commit, read-only", async () => {
    const { client, forge } = make();
    client.runs = [run("test", "completed", "success")];
    await forge.prChecks(42);
    expect(client.calls).toEqual([
      { method: "GET", path: "/repos/o/r/pulls/42", body: undefined },
      { method: "GET", path: "/repos/o/r/commits/h1/check-runs?per_page=100&page=1", body: undefined },
      { method: "GET", path: "/repos/o/r/commits/h1/status?per_page=100", body: undefined },
    ]);
  });

  it("passed when every check succeeded, was skipped or neutral, and when there are none", async () => {
    const { client, forge } = make();
    expect(await forge.prChecks(42)).toEqual({ state: "passed" });
    client.runs = [run("test", "completed", "success"), run("lint", "completed", "skipped"), run("x", "completed", "neutral")];
    client.statuses = [{ context: "ci/legacy", state: "success" }];
    expect(await forge.prChecks(42)).toEqual({ state: "passed" });
  });

  it("pending while a check has not finished and none failed", async () => {
    const { client, forge } = make();
    client.runs = [run("test", "completed", "success"), run("test-mysql", "in_progress")];
    expect(await forge.prChecks(42)).toEqual({ state: "pending" });
    client.runs = [run("test", "completed", "success")];
    client.statuses = [{ context: "ci/legacy", state: "pending" }];
    expect(await forge.prChecks(42)).toEqual({ state: "pending" });
  });

  it("failed as soon as one check finished without success, naming every failed one", async () => {
    const { client, forge } = make();
    client.runs = [
      run("test", "completed", "failure"),
      run("test-mysql", "queued"),
      run("typecheck", "completed", "timed_out"),
      run("cancelled-one", "completed", "cancelled"),
      run("ok", "completed", "success"),
    ];
    client.statuses = [{ context: "ci/legacy", state: "error" }, { context: "ci/fine", state: "success" }];
    expect(await forge.prChecks(42)).toEqual({ state: "failed", failed: ["test", "typecheck", "cancelled-one", "ci/legacy"] });
  });
});


describe("GitHubForge: pull requests the factory did not open (design 2026-11-01)", () => {
  const bob = { id: 2, login: "bob", type: "User" };
  const pull = (number: number, ref: string, o: Record<string, unknown> = {}) => ({
    number, merged_at: null, merge_commit_sha: null, updated_at: "2026-11-01T00:00:00Z", draft: false,
    title: `PR ${number}`, body: `body ${number}`, user: bob, labels: [],
    head: { ref, sha: `head${number}`, repo: { full_name: "o/r" } }, base: { ref: "main", sha: `base${number}` },
    ...o,
  });

  /** Answers the open and closed PR lists, single PRs, PR files, issue timelines and single commits. */
  class PullsClient extends FakeClient {
    open: unknown[] = [];
    closed: unknown[] = [];
    byNumber: Record<number, unknown> = {};
    files: Record<number, unknown[]> = {};
    timeline: Record<number, unknown[]> = {};
    commits: Record<string, unknown> = {};
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const page1 = path.includes("page=1");
      const bare = path.split("?")[0]!;
      if (method === "GET" && path.startsWith("/repos/o/r/pulls?state=open")) {
        this.calls.push({ method, path, body });
        return (page1 ? this.open : []) as T;
      }
      if (method === "GET" && path.startsWith("/repos/o/r/pulls?state=closed")) {
        this.calls.push({ method, path, body });
        return (page1 ? this.closed : []) as T;
      }
      let m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(bare);
      if (method === "GET" && m) {
        this.calls.push({ method, path, body });
        return this.byNumber[Number(m[1])] as T;
      }
      m = /^\/repos\/o\/r\/pulls\/(\d+)\/files$/.exec(bare);
      if (method === "GET" && m) {
        this.calls.push({ method, path, body });
        return (page1 ? (this.files[Number(m[1])] ?? []) : []) as T;
      }
      m = /^\/repos\/o\/r\/issues\/(\d+)\/timeline$/.exec(bare);
      if (method === "GET" && m) {
        this.calls.push({ method, path, body });
        return (page1 ? (this.timeline[Number(m[1])] ?? []) : []) as T;
      }
      m = /^\/repos\/o\/r\/commits\/([0-9a-z]+)$/.exec(bare);
      if (method === "GET" && m) {
        this.calls.push({ method, path, body });
        return this.commits[m[1]!] as T;
      }
      return super.request<T>(method, path, body);
    }
  }
  const make = () => {
    const client = new PullsClient();
    return { client, forge: forgeOf(client) };
  };
  const prRef = (n: number) => ({ type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/pull/${n}` });
  const bobId = { provider: "github", subject: "2", login: "bob" };

  it("reports open non-draft PRs against the base from this repository, and every factory PR; no detail reads for others", async () => {
    const { client, forge } = make();
    client.open = [
      pull(10, "feature/x", { labels: [{ name: "factory: skip" }, { name: "bug" }] }),
      pull(11, "feature/draft", { draft: true }),
      pull(12, "feature/fork", { head: { ref: "feature/fork", sha: "head12", repo: { full_name: "evil/r" } } }),
      pull(13, "feature/rel", { base: { ref: "release", sha: "b" } }),
      pull(14, "factory/wi_a"),
      pull(15, "feature/gone", { head: { ref: "feature/gone", sha: "head15", repo: null } }),
    ];
    client.byNumber[14] = { ...pull(14, "factory/wi_a"), mergeable: true };
    const { events } = await forge.poll(null);
    expect(events.filter((e) => e.kind === "change_open")).toEqual([
      {
        kind: "change_open", source: prRef(10), change_ref: "10", head_branch: "feature/x", head_sha: "head10",
        title: "PR 10", body: "body 10", author: bobId, labels: ["factory: skip", "bug"],
      },
      {
        kind: "change_open", source: prRef(14), change_ref: "14", head_branch: "factory/wi_a", head_sha: "head14",
        title: "PR 14", body: "body 14", author: bobId, labels: [],
      },
    ]);
    const gets = client.calls.filter((c) => /^\/repos\/o\/r\/(pulls|issues)\/\d+/.test(c.path)).map((c) => c.path);
    expect(gets).toEqual(["/repos/o/r/pulls/14"]);
  });

  it("reports merges and closes of every PR, with the merger, and marks forks", async () => {
    const { client, forge } = make();
    client.closed = [
      pull(20, "feature/x", { merged_at: "2026-11-01T00:00:03Z", merge_commit_sha: "m20", updated_at: "2026-11-01T00:00:03Z" }),
      pull(21, "patch-1", {
        merged_at: "2026-11-01T00:00:02Z", merge_commit_sha: "m21", updated_at: "2026-11-01T00:00:02Z",
        head: { ref: "patch-1", sha: "h", repo: { full_name: "evil/r" } },
      }),
      pull(22, "feature/y", { updated_at: "2026-11-01T00:00:01Z" }),
    ];
    client.byNumber[20] = { merged_by: bob };
    client.byNumber[21] = { merged_by: null };
    const { events } = await forge.poll(null);
    expect(events.filter((e) => e.kind === "change_merged" || e.kind === "change_closed")).toEqual([
      { kind: "change_merged", change_ref: "20", head_branch: "feature/x", merge_sha: "m20", merger: bobId },
      { kind: "change_merged", change_ref: "21", head_branch: "patch-1", merge_sha: "m21", merger: null, fork: true },
      { kind: "change_closed", change_ref: "22", head_branch: "feature/y" },
    ]);
  });

  describe("'Request changes' reviews", () => {
    const at = (s: number) => `2026-11-02T00:00:${String(s).padStart(2, "0")}Z`;
    const rv = (id: number, state: string, submitted_at: string | null, o: Record<string, unknown> = {}) =>
      ({ id, state, body: `review ${id}`, user: bob, submitted_at, ...o });

    it("the first poll only sets the review time: no review is read or delivered", async () => {
      const { client, forge } = make();
      client.open = [pull(14, "factory/wi_a", { updated_at: at(5) })];
      client.byNumber[14] = { ...pull(14, "factory/wi_a"), mergeable: true };
      client.responses["/repos/o/r/pulls/14/reviews"] = [rv(1, "CHANGES_REQUESTED", at(1))];
      const { events, next_cursor } = await forge.poll(null);
      expect(events.filter((e) => e.kind === "pr_changes_requested")).toEqual([]);
      expect(client.calls.some((c) => c.path.includes("/reviews"))).toBe(false);
      expect(JSON.parse(next_cursor)).toMatchObject({ reviews: at(5), review_ids: [] });
    });

    it("a later poll delivers each new 'Request changes' review by a person with its line comments, once", async () => {
      const { client, forge } = make();
      client.open = [pull(14, "factory/wi_a", { updated_at: at(5) }), pull(10, "feature/x", { updated_at: at(1) })];
      client.byNumber[14] = { ...pull(14, "factory/wi_a"), mergeable: true };
      const first = (await forge.poll(null)).next_cursor;

      client.open = [pull(14, "factory/wi_a", { updated_at: at(9) }), pull(10, "feature/x", { updated_at: at(1) })];
      client.responses["/repos/o/r/pulls/14/reviews"] = [
        rv(1, "CHANGES_REQUESTED", at(2)), // before the review time: never delivered
        rv(2, "APPROVED", at(6)),
        rv(3, "COMMENTED", at(7)),
        rv(4, "CHANGES_REQUESTED", at(8), { user: { id: 9, login: "ci-bot", type: "Bot" } }),
        rv(5, "CHANGES_REQUESTED", at(9), { body: "Two problems." }),
        rv(6, "PENDING", null),
      ];
      client.responses["/repos/o/r/pulls/14/reviews/5/comments"] = [
        { path: "src/core/a.ts", line: 12, original_line: 12, body: "this throws on an empty list" },
        { path: "tests/a.test.ts", line: null, original_line: 40, body: "add a case" },
      ];
      const second = await forge.poll(first);
      expect(second.events.filter((e) => e.kind === "pr_changes_requested")).toEqual([
        {
          kind: "pr_changes_requested", source: prRef(14), change_ref: "14", head_branch: "factory/wi_a", review_id: "5",
          reviewer: bobId, body: "Two problems.",
          comments: [
            { path: "src/core/a.ts", line: 12, body: "this throws on an empty list" },
            { path: "tests/a.test.ts", line: 40, body: "add a case" },
          ],
        },
      ]);
      // PR 10 was not updated since the review time: its reviews are not read. Only review 5's comments are.
      const reads = client.calls.filter((c) => c.path.includes("/reviews")).map((c) => c.path.split("?")[0]);
      expect([...new Set(reads)]).toEqual(["/repos/o/r/pulls/14/reviews", "/repos/o/r/pulls/14/reviews/5/comments"]);
      expect(second.events.findIndex((e) => e.kind === "pr_changes_requested"))
        .toBeGreaterThan(second.events.findIndex((e) => e.kind === "change_open"));

      // The same reviews on the next poll: nothing again.
      const third = await forge.poll(second.next_cursor);
      expect(third.events.filter((e) => e.kind === "pr_changes_requested")).toEqual([]);
    });
  });

  it("prFiles lists every changed path, both sides of a rename", async () => {
    const { client, forge } = make();
    client.files[10] = [
      { filename: "src/a.ts", status: "modified" },
      { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed" },
    ];
    expect(await forge.prFiles(10)).toEqual(["src/a.ts", "src/new.ts", "src/old.ts"]);
    expect(client.calls.map((c) => c.path)).toEqual(["/repos/o/r/pulls/10/files?per_page=100&page=1"]);
  });

  it("labelAddedBy names the actor of the latest `labeled` event for that label, or null", async () => {
    const { client, forge } = make();
    client.timeline[10] = [
      { event: "labeled", label: { name: "factory: skip" }, actor: user },
      { event: "commented", actor: user },
      { event: "labeled", label: { name: "bug" }, actor: user },
      { event: "labeled", label: { name: "factory: skip" }, actor: bob },
    ];
    expect(await forge.labelAddedBy(10, "factory: skip")).toEqual(bobId);
    expect(await forge.labelAddedBy(10, "other")).toBeNull();
    expect(await forge.labelAddedBy(11, "factory: skip")).toBeNull();
  });

  it("commitAuthor names the commit's linked account, or null", async () => {
    const { client, forge } = make();
    client.commits.abc = { sha: "abc", author: bob };
    client.commits.def = { sha: "def", author: null };
    expect(await forge.commitAuthor("abc")).toEqual(bobId);
    expect(await forge.commitAuthor("def")).toBeNull();
  });
});

describe("GitHubForge: commitsBetween (design §4, implicit verdicts)", () => {
  /** Answers the compare endpoint from `compare` by range; a status in `fail` throws a GitHubError. */
  class CompareClient extends FakeClient {
    compare: Record<string, unknown> = {};
    fail: Record<string, number> = {};
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const m = /^\/repos\/o\/r\/compare\/(.+)$/.exec(path);
      if (!m) return super.request<T>(method, path, body);
      this.calls.push({ method, path, body });
      const status = this.fail[m[1]!];
      if (status) throw new GitHubError(status, "no");
      return this.compare[m[1]!] as T;
    }
  }

  it("is the compare endpoint's ahead count, read with one GET and no write", async () => {
    const client = new CompareClient();
    client.compare["h1...h2"] = { ahead_by: 3, behind_by: 0, status: "ahead" };
    expect(await forgeOf(client).commitsBetween("h1", "h2")).toBe(3);
    expect(client.calls).toEqual([{ method: "GET", path: "/repos/o/r/compare/h1...h2", body: undefined }]);
  });

  it("is null when GitHub cannot compare the two (an unknown sha) or gives no count; other failures throw", async () => {
    const client = new CompareClient();
    client.fail["gone...h2"] = 404;
    client.fail["bad...h2"] = 422;
    client.compare["h1...h3"] = { status: "diverged" };
    const forge = forgeOf(client);
    expect(await forge.commitsBetween("gone", "h2")).toBeNull();
    expect(await forge.commitsBetween("bad", "h2")).toBeNull();
    expect(await forge.commitsBetween("h1", "h3")).toBeNull();
    client.fail["h1...h4"] = 500;
    await expect(forge.commitsBetween("h1", "h4")).rejects.toThrow();
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("GitHubForge: the starting point for merges (design §5, Merges)", () => {
  const bob = { id: 2, login: "bob", type: "User" };
  /** A time `m` minutes after 2026-10-01T00:00:00Z, in GitHub's format. */
  const t = (m: number) => new Date(Date.UTC(2026, 9, 1) + m * 60_000).toISOString().replace(".000Z", "Z");
  const merged = (number: number, at: string) => ({
    number, merged_at: at, merge_commit_sha: `m${number}`, updated_at: at,
    head: { ref: `feature/${number}`, sha: `h${number}`, repo: { full_name: "o/r" } }, base: { ref: "main", sha: "b" },
  });

  /** Counts every request; answers the closed-PR list by page (newest-updated first) and each single PR. */
  class HistoryClient extends FakeClient {
    closed: ReturnType<typeof merged>[] = [];
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (method === "GET" && path.startsWith("/repos/o/r/pulls?state=closed")) {
        this.calls.push({ method, path, body });
        const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
        const desc = [...this.closed].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        return desc.slice((page - 1) * 100, page * 100) as T;
      }
      if (method === "GET" && /^\/repos\/o\/r\/pulls\/\d+$/.test(path)) {
        this.calls.push({ method, path, body });
        return { merged_by: bob } as T;
      }
      return super.request<T>(method, path, body);
    }
    closedReads() {
      return this.calls.filter((c) => c.path.startsWith("/repos/o/r/pulls?state=closed")).map((c) => c.path);
    }
    prReads() {
      return this.calls.filter((c) => /^\/repos\/o\/r\/pulls\/\d+$/.test(c.path)).map((c) => c.path);
    }
  }
  function make(o: { now?: string; history_since?: string | null } = {}) {
    const client = new HistoryClient();
    const clock = new FakeClock(o.now ?? "2026-11-07T00:00:00Z");
    const log = recordingLog();
    const ctx = { clock, history_since: o.history_since ?? null, log };
    const forge = forgeOf(client, ctx);
    return { client, clock, log, forge };
  }
  const merges = (events: ForgeEvent[]) => events.flatMap((e) => (e.kind === "change_merged" ? [Number(e.change_ref)] : []));

  it("a first start with 50 old merged PRs reports no merge and makes no per-PR read, only the list read", async () => {
    const { client, forge } = make();
    client.closed = Array.from({ length: 50 }, (_, i) => merged(100 + i, t(i)));
    const { events, next_cursor } = await forge.poll(null);
    expect(merges(events)).toEqual([]);
    expect(client.prReads()).toEqual([]);
    expect(client.closedReads()).toEqual(["/repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1"]);
    expect(JSON.parse(next_cursor)).toMatchObject({ start: "2026-11-07T00:00:00Z", pulls: t(49) });
  });

  it("the starting point comes from the Clock, in GitHub's UTC format, even with no closed PR", async () => {
    const { forge } = make({ now: "2026-11-07T08:09:10.123Z" });
    const { next_cursor } = await forge.poll(null);
    expect(JSON.parse(next_cursor)).toMatchObject({ start: "2026-11-07T08:09:10Z", pulls: "2026-11-07T08:09:10Z" });
  });

  it("with no closed PR at the first start, a PR merged after it is reported on the next poll", async () => {
    const { client, clock, forge } = make();
    const first = await forge.poll(null);
    clock.advance(60_000);
    client.closed = [merged(7, "2026-11-07T00:00:30Z")];
    const { events } = await forge.poll(first.next_cursor);
    expect(merges(events)).toEqual([7]);
    expect(client.prReads()).toEqual(["/repos/o/r/pulls/7"]);
  });

  it("a later start continues from the stored starting point: one page, merges after it only", async () => {
    const { client, forge } = make();
    client.closed = Array.from({ length: 150 }, (_, i) => merged(100 + i, t(i)));
    const first = await forge.poll(null);
    client.calls = [];
    client.closed.push(merged(300, "2026-11-07T00:05:00Z"));
    // A restart: a new forge on the stored cursor, the clock later.
    const later = make({ now: "2026-11-08T00:00:00Z" });
    later.client.closed = client.closed;
    const { events, next_cursor } = await later.forge.poll(first.next_cursor);
    expect(merges(events)).toEqual([300]);
    expect(later.client.prReads()).toEqual(["/repos/o/r/pulls/300"]);
    expect(later.client.closedReads()).toEqual(["/repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1"]);
    expect(JSON.parse(next_cursor).start).toBe("2026-11-07T00:00:00Z");
  });

  it("a cursor from before the starting point keeps its place: its closed-PR time becomes the start", async () => {
    const { client, forge } = make();
    client.closed = [merged(1, t(10)), merged(2, t(20))];
    const old = JSON.stringify({ issues: null, comments: null, pulls: t(15) });
    const { events, next_cursor } = await forge.poll(old);
    expect(merges(events)).toEqual([2]);
    expect(JSON.parse(next_cursor)).toMatchObject({ start: t(15), pulls: t(20) });
  });

  it("an older github.history_since checks merges after it, not before, once", async () => {
    const first = make();
    first.client.closed = [merged(1, t(10)), merged(2, t(20)), merged(3, t(30))];
    const start = await first.forge.poll(null);
    const { client, forge } = make({ history_since: t(15) });
    client.closed = first.client.closed;
    const { events, next_cursor } = await forge.poll(start.next_cursor);
    expect(merges(events).sort()).toEqual([2, 3]);
    expect(JSON.parse(next_cursor)).toMatchObject({ start: t(15), history_since: t(15) });
    // A restart does not read that history again.
    client.calls = [];
    const again = await make({ history_since: t(15) }).forge.poll(next_cursor);
    expect(merges(again.events)).toEqual([]);
  });

  it("the history read stops at 5 pages of closed PRs", async () => {
    const first = make();
    const start = await first.forge.poll(null);
    const { client, forge } = make({ history_since: t(0) });
    client.closed = Array.from({ length: 700 }, (_, i) => merged(1000 + i, t(1 + i)));
    await forge.poll(start.next_cursor);
    expect(client.closedReads()).toEqual([1, 2, 3, 4, 5].map((p) => `/repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${p}`));
  });

  it("a github.history_since newer than the starting point does not move it and warns once, naming the setting", async () => {
    const first = make();
    const start = await first.forge.poll(null);
    const { client, log, forge } = make({ history_since: "2026-11-07T12:00:00Z" });
    client.closed = [merged(1, "2026-11-07T06:00:00Z")];
    const { events, next_cursor } = await forge.poll(start.next_cursor);
    expect(merges(events)).toEqual([1]);
    expect(JSON.parse(next_cursor).start).toBe("2026-11-07T00:00:00Z");
    await forge.poll(next_cursor);
    const warnings = log.lines.filter((l) => l.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toContain("github.history_since");
  });
});

describe("GitHubForge: PR comments and PR status (issue #273)", () => {
  it("posts a PR comment and writes a PR label through the GitHub source's store-backed paths, on the PR ref", async () => {
    const calls: unknown[][] = [];
    const issues = {
      postComment: async (...args: unknown[]) => (calls.push(["postComment", ...args]), { url: "u" }),
      setStatus: async (...args: unknown[]) => void calls.push(["setStatus", ...args]),
    };
    const forge = new GitHubForge(new FakeClient(), { owner: "o", name: "r" }, "factory/", "main", issues);
    expect(await forge.postPrComment(42, "body", "<!-- m -->")).toEqual({ url: "u" });
    await forge.setPrStatus(issueRef(7), "in_review", 42);
    const pr = { type: "github_issue", id: "o/r#42", link: "https://github.com/o/r/pull/42" };
    expect(calls).toEqual([["postComment", pr, "body", "<!-- m -->"], ["setStatus", issueRef(7), "in_review", "42"]]);
  });

  it("names its own PR refs only", () => {
    const forge = forgeOf(new FakeClient());
    expect(forge.prNumberOf(forge.prRef(42))).toBe(42);
    expect(forge.prNumberOf(issueRef(42))).toBeNull();
    expect(forge.prNumberOf({ type: "github_issue", id: "x/y#42", link: "https://github.com/x/y/pull/42" })).toBeNull();
    expect(forge.prNumberOf({ type: "slack_thread", id: "o/r#42", link: "https://github.com/o/r/pull/42" })).toBeNull();
  });

  it("polls only with a PollContext", async () => {
    const forge = new GitHubForge(new FakeClient(), { owner: "o", name: "r" }, "factory/", "main", noWrites);
    await expect(forge.poll(null)).rejects.toThrow(/PollContext/);
  });
});
