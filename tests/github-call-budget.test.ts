import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubClient, GitHubError, githubMinRemaining } from "../src/impl/github/github-client.js";
import { OpaqueSecret } from "../src/impl/secrets/env-file-secret-store.js";
import { secretName } from "../src/interfaces/secret-store.js";
import { GitHubIssueSource } from "../src/impl/source/github-issue-source.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import { recordingLog } from "./helpers/fakes.js";

const credentials: GitHubCredentials = { token: async () => new OpaqueSecret(secretName("GITHUB_TOKEN"), "ghs_test") };

/**
 * A GitHub REST fake over fetch: answers by route, gives every 200 an ETag (hash of the body), answers a matching
 * If-None-Match with 304, and sets the x-ratelimit-* headers from `remaining` / `reset`. `counted` is the calls
 * GitHub would count against the rate limit (every answer but a 304).
 */
function fakeGitHub(clock: FakeClock, n: number) {
  const user = { id: 1, login: "alice", type: "User" };
  const t = (i: number) => `2026-11-01T00:${String(i).padStart(2, "0")}:00Z`;
  const openIssues = Array.from({ length: n }, (_, i) => ({ number: 100 + i, title: `i${i}`, body: "", user, updated_at: t(i) }));
  const openPulls = Array.from({ length: n }, (_, i) => ({
    number: 200 + i, updated_at: t(i), title: `p${i}`, body: "", user, labels: [], draft: false,
    head: { ref: `factory/wi_${i}`, sha: `h${i}`, repo: { full_name: "o/r" } }, base: { ref: "main", sha: "b0" },
  }));
  // 250 closed PRs, all older than any cursor the test polls with.
  const closedPulls = Array.from({ length: 250 }, (_, i) => ({
    number: 1000 + i, updated_at: `2026-10-01T00:00:${String(59 - (i % 60)).padStart(2, "0")}Z`, merged_at: null,
    head: { ref: `x${i}`, sha: "s", repo: { full_name: "o/r" } }, base: { ref: "main", sha: "b0" },
  }));
  const state = {
    remaining: 4000,
    reset: Math.floor(clock.now().getTime() / 1000) + 3600,
    calls: [] as { method: string; path: string; status: number }[],
    get counted() {
      return this.calls.filter((c) => c.status !== 304).length;
    },
  };
  const route = (path: string): unknown => {
    const u = new URL(path, "https://gh.test");
    const page = Number(u.searchParams.get("page") ?? "1");
    const per = Number(u.searchParams.get("per_page") ?? "30");
    const paged = (all: unknown[]) => all.slice((page - 1) * per, page * per);
    const p = u.pathname;
    const q = u.searchParams;
    if (p === "/repos/o/r/issues" && q.get("state") === "open") return paged(openIssues);
    if (p === "/repos/o/r/issues") return [];
    if (p === "/repos/o/r/issues/comments") return [];
    if (p === "/repos/o/r/pulls" && q.get("state") === "closed") return paged(closedPulls);
    if (p === "/repos/o/r/pulls" && q.get("state") === "open") return paged(openPulls);
    let m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(p);
    if (m) return { ...openPulls.find((x) => x.number === Number(m![1])), mergeable: true, merged_by: null };
    if (/^\/repos\/o\/r\/pulls\/\d+\/reviews$/.test(p)) return [];
    if (p === "/repos/o/r/commits") return [];
    m = /^\/repos\/o\/r\/commits\/(\w+)\/check-runs$/.exec(p);
    if (m) return { total_count: 0, check_runs: [] };
    if (/^\/repos\/o\/r\/commits\/\w+\/status$/.test(p)) return { statuses: [] };
    if (/^\/repos\/o\/r\/issues\/\d+\/labels$/.test(p)) return [{ name: "sf: implementing" }];
    throw new Error(`unrouted ${path}`);
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const rate = {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": String(state.remaining),
      "x-ratelimit-reset": String(state.reset),
      "x-ratelimit-resource": "core",
    };
    const body = JSON.stringify(route(path));
    const etag = `W/"${createHash("sha1").update(body).digest("hex")}"`;
    if (method === "GET" && headers.get("if-none-match") === etag) {
      state.calls.push({ method, path, status: 304 });
      return new Response(null, { status: 304, headers: { etag, ...rate } });
    }
    state.calls.push({ method, path, status: 200 });
    return new Response(body, { status: 200, headers: { etag, "content-type": "application/json", ...rate } });
  }) as typeof fetch;
  return { state, fetchFn };
}

function setup(n: number, opts: { etag_entries?: number; min_remaining?: number } = {}) {
  const clock = new FakeClock("2026-11-07T00:00:00Z");
  const gh = fakeGitHub(clock, n);
  const log = recordingLog();
  const client = new GitHubClient(credentials, "https://gh.test", { fetch: gh.fetchFn, clock, log, ...opts });
  const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main", undefined, null, { clock, history_since: null, log });
  return { clock, gh, log, client, source };
}

describe("GitHubClient conditional requests (ETag / 304)", () => {
  it("sends the stored ETag back and answers a 304 with the kept body", async () => {
    const { gh, client } = setup(2);
    const first = await client.request<unknown[]>("GET", "/repos/o/r/issues?state=open&per_page=100&page=1");
    const second = await client.request<unknown[]>("GET", "/repos/o/r/issues?state=open&per_page=100&page=1");
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
    expect(gh.state.calls.map((c) => c.status)).toEqual([200, 304]);
    expect(gh.state.counted).toBe(1);
  });

  it("makes plain calls with the cache off, and never makes a write conditional", async () => {
    const { gh, client } = setup(2, { etag_entries: 0 });
    await client.request("GET", "/repos/o/r/issues?state=open&per_page=100&page=1");
    await client.request("GET", "/repos/o/r/issues?state=open&per_page=100&page=1");
    expect(gh.state.calls.map((c) => c.status)).toEqual([200, 200]);
  });

  it("keeps at most etag_entries URLs (least recently used goes first)", async () => {
    const { gh, client } = setup(2, { etag_entries: 1 });
    await client.request("GET", "/repos/o/r/pulls/200");
    await client.request("GET", "/repos/o/r/pulls/201");
    await client.request("GET", "/repos/o/r/pulls/200");
    await client.request("GET", "/repos/o/r/pulls/200");
    expect(gh.state.calls.map((c) => c.status)).toEqual([200, 200, 200, 304]);
  });
});

describe("GitHubClient rate-limit budget", () => {
  it("exposes the x-ratelimit headers", async () => {
    const { gh, client } = setup(1);
    expect(client.budget()).toBeNull();
    gh.state.remaining = 4321;
    await client.request("GET", "/repos/o/r/pulls/200");
    expect(client.budget()).toEqual({ limit: 5000, remaining: 4321, reset_at: new Date(gh.state.reset * 1000).toISOString() });
  });

  it("under min_remaining skips the optional reads until the reset, logging one line on entering and one on leaving", async () => {
    const { gh, client, source, clock, log } = setup(3, { min_remaining: 200 });
    const first = await source.poll(null);
    gh.state.remaining = 150;
    gh.state.calls = [];
    await client.request("GET", "/repos/o/r/pulls/200"); // the response that reports the low budget
    gh.state.calls = [];
    const low = await source.poll(first.next_cursor);
    const paths = gh.state.calls.map((c) => c.path.split("?")[0]);
    // The intake lists still run; the per-PR mergeable reads, the reviews and the commits wait.
    expect(paths).toEqual(["/repos/o/r/issues", "/repos/o/r/issues", "/repos/o/r/issues/comments", "/repos/o/r/pulls", "/repos/o/r/pulls"]);
    expect(low.events.filter((e) => e.kind === "pr_open")).toHaveLength(3);
    // The commit and review cursors stay put, so the next poll reads them.
    const before = JSON.parse(first.next_cursor);
    const after = JSON.parse(low.next_cursor);
    expect([after.commits, after.reviews]).toEqual([before.commits, before.reviews]);
    gh.state.calls = [];
    expect(await source.prChecks(200)).toEqual({ state: "pending" });
    expect(gh.state.calls).toEqual([]);
    expect(log.lines.filter((l) => l.msg.startsWith("GitHub budget"))).toEqual([
      { level: "warn", msg: "GitHub budget low: optional reads wait for the reset", fields: { remaining: 150, min_remaining: 200, reset_at: new Date(gh.state.reset * 1000).toISOString() } },
    ]);

    clock.advance(3601_000);
    expect(client.lowBudget()).toBe(false);
    gh.state.calls = [];
    await source.poll(low.next_cursor);
    expect(gh.state.calls.some((c) => c.path.startsWith("/repos/o/r/commits"))).toBe(true);
    expect(gh.state.calls.some((c) => /\/pulls\/\d+$/.test(c.path))).toBe(true);
    expect(log.lines.filter((l) => l.msg.startsWith("GitHub budget")).map((l) => l.msg)).toEqual([
      "GitHub budget low: optional reads wait for the reset",
      "GitHub budget back: optional reads resume",
    ]);
  });

  it("with no calls left, refuses with GitHub's 403 without sending until the reset", async () => {
    const { gh, client, clock } = setup(1);
    gh.state.remaining = 0;
    await client.request("GET", "/repos/o/r/pulls/200");
    gh.state.calls = [];
    const err = await client.request("GET", "/repos/o/r/pulls/200").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(403);
    expect((err as Error).message).toMatch(/rate limit exceeded/);
    expect(gh.state.calls).toEqual([]);
    clock.advance(3601_000);
    gh.state.remaining = 5000;
    await client.request("GET", "/repos/o/r/pulls/200");
    expect(gh.state.calls).toHaveLength(1);
  });

  it("github.min_remaining defaults to 200 and must be a whole number", () => {
    expect(githubMinRemaining(undefined)).toBe(200);
    expect(githubMinRemaining({ min_remaining: 0 })).toBe(0);
    expect(() => githubMinRemaining({ min_remaining: -1 })).toThrow(/whole number/);
    expect(() => githubMinRemaining({ min_remaining: "10" })).toThrow(/whole number/);
  });
});

describe("GitHub calls per poll", () => {
  /** Counted calls of the third poll (the steady state: the cursor has settled, nothing changed on GitHub). */
  async function steadyPoll(n: number, etag_entries?: number) {
    const { gh, source } = setup(n, etag_entries === undefined ? {} : { etag_entries });
    const first = await source.poll(null);
    const second = await source.poll(first.next_cursor);
    gh.state.calls = [];
    await source.poll(second.next_cursor);
    return { counted: gh.state.counted, sent: gh.state.calls.length };
  }

  it("drops from 6 + N to 0 for N open factory PRs when nothing changed", async () => {
    const n = 10;
    const before = await steadyPoll(n, 0);
    const after = await steadyPoll(n);
    // open issues, closed issues, comments, closed PRs (one page), open PRs, N mergeable reads, the newest PR's
    // reviews, base commits.
    expect(before.counted).toBe(6 + n + 1);
    expect(after.sent).toBe(before.sent);
    expect(after.counted).toBe(0);
  });

  it("reads one page of closed PRs past the cursor, not every page", async () => {
    const { gh, source } = setup(1);
    const first = await source.poll(null);
    gh.state.calls = [];
    await source.poll(first.next_cursor);
    expect(gh.state.calls.filter((c) => c.path.startsWith("/repos/o/r/pulls?state=closed")).map((c) => c.path)).toEqual([
      "/repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1",
    ]);
  });

  it("a status label already right costs no counted call the second time", async () => {
    const { gh, source } = setup(1);
    const ref = { type: "github_issue" as const, id: "o/r#100", link: "https://github.com/o/r/issues/100" };
    await source.setStatus(ref, "implementing", null);
    await source.setStatus(ref, "implementing", null);
    expect(gh.state.calls.map((c) => [c.method, c.status])).toEqual([["GET", 200], ["GET", 304]]);
  });
});
