import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { Controller, GITHUB_BUDGET_CURSOR } from "../src/core/controller.js";
import { GitHubClient, GitHubError, githubBudgetShare, githubMinRemaining } from "../src/impl/github/github-client.js";
import { OpaqueSecret } from "../src/impl/secrets/env-file-secret-store.js";
import { secretName } from "../src/interfaces/secret-store.js";
import { GitHubIssueSource } from "../src/impl/source/github-issue-source.js";
import { GitHubForge } from "../src/impl/github/github-forge.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, recordingLog, slackRef, waitFor } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";
import { readGitHubBudget } from "../src/ui/github-budget.js";

const credentials: GitHubCredentials = { token: async () => new OpaqueSecret(secretName("GITHUB_TOKEN"), "ghs_test") };

/**
 * A GitHub REST fake over fetch: answers by route, gives every 200 an ETag (hash of the body), answers a matching
 * If-None-Match with 304, and sets the x-ratelimit-* headers from `remaining` / `reset`. `counted` is the calls
 * GitHub would count against the rate limit (every answer but a 304).
 */
function fakeGitHub(clock: FakeClock, n: number, closed = 0) {
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
  // Closed factory issues, oldest first (a first start reads them all: the catch-up).
  const closedIssues = Array.from({ length: closed }, (_, i) => ({
    number: 500 + i, title: `c${i}`, body: "", user, updated_at: `2026-10-${String(1 + Math.floor(i / 60)).padStart(2, "0")}T00:${String(i % 60).padStart(2, "0")}:00Z`,
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
    if (p === "/repos/o/r/issues" && q.get("state") === "closed") return paged(closedIssues.filter((i) => i.updated_at >= (q.get("since") ?? "")));
    if (p === "/repos/o/r/issues") return [];
    if (/^\/repos\/o\/r\/issues\/\d+$/.test(p)) return { closed_by: user, state_reason: "completed" };
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

function setup(n: number, opts: { etag_entries?: number; min_remaining?: number; budget_share?: number } = {}, closed = 0) {
  const clock = new FakeClock("2026-11-07T00:00:00Z");
  const gh = fakeGitHub(clock, n, closed);
  const log = recordingLog();
  const client = new GitHubClient(credentials, "https://gh.test", { fetch: gh.fetchFn, clock, log, ...opts });
  const repo = { owner: "o", name: "r" };
  const ctx = { clock, history_since: null, log };
  const source = new GitHubIssueSource(client, repo, "factory", "factory/", "main", undefined, null);
  // Both GitHub plugins selected (issue #273): the forge reads the PRs, the source everything else.
  const forge = new GitHubForge(client, repo, "factory/", "main", source, ctx);
  /** One poll tick as the controller makes it: the source, then the forge, each through its own cursor. */
  const tick = async (cursors: Cursors = { source: null, forge: null }) => {
    const s = await source.poll(cursors.source);
    const f = await forge.poll(cursors.forge);
    return { events: [...s.events, ...f.events], next: { source: s.next_cursor, forge: f.next_cursor } };
  };
  return { clock, gh, log, client, source, forge, tick };
}
type Cursors = { source: string | null; forge: string | null };

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
    const { gh, client, forge, tick, clock, log } = setup(3, { min_remaining: 200 });
    const first = await tick();
    gh.state.remaining = 150;
    gh.state.calls = [];
    await client.request("GET", "/repos/o/r/pulls/200"); // the response that reports the low budget
    gh.state.calls = [];
    const low = await tick(first.next);
    const paths = gh.state.calls.map((c) => c.path.split("?")[0]);
    // The intake lists still run; the per-PR mergeable reads, the reviews and the commits wait.
    expect(paths).toEqual(["/repos/o/r/issues", "/repos/o/r/issues", "/repos/o/r/issues/comments", "/repos/o/r/pulls", "/repos/o/r/pulls"]);
    expect(low.events.filter((e) => e.kind === "pr_open")).toHaveLength(3);
    // The commit and review cursors stay put, so the next poll reads them.
    expect(JSON.parse(low.next.source).commits).toEqual(JSON.parse(first.next.source).commits);
    expect(JSON.parse(low.next.forge).reviews).toEqual(JSON.parse(first.next.forge).reviews);
    gh.state.calls = [];
    expect(await forge.prChecks(200)).toEqual({ state: "pending" });
    expect(gh.state.calls).toEqual([]);
    expect(log.lines.filter((l) => l.msg.startsWith("GitHub budget"))).toEqual([
      { level: "warn", msg: "GitHub budget low: optional reads wait for the reset", fields: { remaining: 150, min_remaining: 200, reset_at: new Date(gh.state.reset * 1000).toISOString() } },
    ]);

    clock.advance(3601_000);
    expect(client.lowBudget()).toBe(false);
    gh.state.calls = [];
    await tick(low.next);
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
  /** Counted calls of the third poll tick (the steady state: the cursors have settled, nothing changed on GitHub). */
  async function steadyPoll(n: number, etag_entries?: number) {
    const { gh, tick } = setup(n, etag_entries === undefined ? {} : { etag_entries });
    const first = await tick();
    const second = await tick(first.next);
    gh.state.calls = [];
    await tick(second.next);
    return { counted: gh.state.counted, sent: gh.state.calls.length, paths: gh.state.calls.map((c) => c.path.split("?")[0]!) };
  }

  it("drops from 6 + N to 0 for N open factory PRs when nothing changed", async () => {
    const n = 10;
    const before = await steadyPoll(n, 0);
    const after = await steadyPoll(n);
    // open issues, closed issues, comments, closed PRs (one page), open PRs, N mergeable reads, the newest PR's
    // reviews, base commits: the same calls as when the source read the PRs itself (issue #273), each made once.
    expect(before.counted).toBe(6 + n + 1);
    expect(before.paths.filter((p) => p === "/repos/o/r/pulls")).toEqual(["/repos/o/r/pulls", "/repos/o/r/pulls"]);
    expect(after.sent).toBe(before.sent);
    expect(after.counted).toBe(0);
  });

  it("a first tick with both GitHub plugins makes 6 + N calls, as the source alone did before issue #273", async () => {
    const n = 4;
    const { gh, tick } = setup(n, { etag_entries: 0 });
    await tick();
    // open issues, closed issues, comments, base commits; closed PRs (one page), open PRs, N mergeable reads (no
    // review is read on the first poll).
    expect(gh.state.counted).toBe(6 + n);
    const lists = gh.state.calls.map((c) => c.path.split("?")[0]!).filter((p) => !/\/pulls\/\d+$/.test(p));
    expect(lists).toEqual(["/repos/o/r/issues", "/repos/o/r/issues", "/repos/o/r/issues/comments", "/repos/o/r/commits", "/repos/o/r/pulls", "/repos/o/r/pulls"]);
  });

  it("reads one page of closed PRs past the cursor, not every page", async () => {
    const { gh, tick } = setup(1);
    const first = await tick();
    gh.state.calls = [];
    await tick(first.next);
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

describe("GitHubClient budget share (github.budget_share)", () => {
  /** `k` counted calls (each a full 200: a different URL every time). */
  async function spend(client: GitHubClient, k: number) {
    for (let i = 0; i < k; i++) await client.request("GET", `/repos/o/r/pulls/200?n=${i}`);
  }

  it("with a share of 0.5 of a 5000 limit, optional reads stop after 2500 counted calls; the intake reads still run", async () => {
    const { gh, client, tick, log } = setup(3, { budget_share: 0.5 });
    const first = await tick();
    await spend(client, 2499 - gh.state.counted);
    expect(client.counted()).toBe(2499);
    expect(client.lowBudget()).toBe(false);
    await spend(client, 1);
    expect(client.counted()).toBe(2500);
    expect(client.lowBudget()).toBe(true);
    // GitHub still reports plenty left: the share, not min_remaining, holds the optional reads.
    expect(client.budget()!.remaining).toBe(4000);
    gh.state.calls = [];
    await tick(first.next);
    expect(gh.state.calls.map((c) => c.path.split("?")[0])).toEqual([
      "/repos/o/r/issues", "/repos/o/r/issues", "/repos/o/r/issues/comments", "/repos/o/r/pulls", "/repos/o/r/pulls",
    ]);
    expect(log.lines.find((l) => l.msg === "GitHub budget low: optional reads wait for the reset")?.fields).toMatchObject({ counted: 2500, budget_share: 0.5 });
    expect(client.status()).toMatchObject({ limit: 5000, remaining: 4000, budget_share: 0.5, share_limit: 2500, state: "low" });
  });

  it("after the reset the window's count starts again at zero and optional reads resume", async () => {
    const { gh, client, tick, clock } = setup(3, { budget_share: 0.5 });
    const first = await tick();
    await spend(client, 2500 - gh.state.counted);
    expect(client.lowBudget()).toBe(true);
    clock.advance(3601_000);
    expect(client.counted()).toBe(0);
    expect(client.lowBudget()).toBe(false);
    gh.state.reset += 3600;
    gh.state.calls = [];
    await tick(first.next);
    expect(gh.state.calls.some((c) => c.path.startsWith("/repos/o/r/commits"))).toBe(true);
    expect(gh.state.calls.some((c) => /\/pulls\/\d+$/.test(c.path))).toBe(true);
    // The new window counts from zero: only this tick's calls.
    expect(client.counted()).toBe(gh.state.counted);
  });

  it("absent means 1.0 (today's behaviour); anything not greater than 0 and at most 1 is refused naming the key", async () => {
    expect(githubBudgetShare(undefined)).toBe(1);
    expect(githubBudgetShare({})).toBe(1);
    expect(githubBudgetShare({ budget_share: 0.25 })).toBe(0.25);
    for (const budget_share of [0, -1, 1.01, "0.5", Number.NaN, null]) {
      expect(() => githubBudgetShare({ budget_share })).toThrow(/github\.budget_share/);
    }
    const { client } = setup(1);
    await client.request("GET", "/repos/o/r/pulls/200");
    expect(client.status()).toMatchObject({ budget_share: 1, share_limit: 5000, counted: 1, state: "ok" });
  });

  it("a 304 is not counted", async () => {
    const { client } = setup(1);
    await client.request("GET", "/repos/o/r/pulls/200");
    await client.request("GET", "/repos/o/r/pulls/200");
    expect(client.counted()).toBe(1);
  });
});

describe("first start: catch-up reads spread over polls", () => {
  it("no poll takes more than (budget_share × limit) / 60 catch-up reads a minute, and every close arrives once", async () => {
    // 0.12 × 5000 = 600 calls a window, so at most 10 catch-up reads a minute.
    const cap = Math.floor((0.12 * 5000) / 60);
    const { gh, source, clock } = setup(1, { budget_share: 0.12 }, 150);
    const closed: string[] = [];
    let cursor: string | null = null;
    const perPoll: number[] = [];
    for (let i = 0; i < 30 && closed.length < 150; i++) {
      gh.state.calls = [];
      const r = await source.poll(cursor);
      cursor = r.next_cursor;
      for (const e of r.events) if (e.kind === "source_closed") closed.push(e.source.id);
      perPoll.push(gh.state.calls.filter((c) => /^\/repos\/o\/r\/(issues\/\d+|commits)(\?|$)/.test(c.path)).length);
      clock.advance(60_000);
    }
    expect(perPoll.every((n) => n <= cap)).toBe(true);
    expect(perPoll.filter((n) => n > 0).length).toBeGreaterThan(1);
    expect(closed).toHaveLength(150);
    expect(new Set(closed).size).toBe(150);
    // Caught up: the cursor no longer marks a catch-up.
    expect(JSON.parse(cursor!).closed_catch_up).toBeUndefined();
  });

  it("with the default share the first start's reads fit one poll, as before", async () => {
    const { gh, source } = setup(1, {}, 20);
    const r = await source.poll(null);
    expect(r.events.filter((e) => e.kind === "source_closed")).toHaveLength(20);
    expect(gh.state.calls.some((c) => c.path.startsWith("/repos/o/r/commits"))).toBe(true);
  });
});

describe("no calls left: a wait, not an error", () => {
  it("logs a wait with the reset time, stores a waiting budget for the status page, and keeps the loop and other work going", async () => {
    const { gh, client, source, clock } = setup(1);
    const { store } = await newStore(clock);
    const other = new FakeSource("slack_thread");
    const log = recordingLog();
    const controller = new Controller({
      store, sources: [source, other], auth: new FakeAuth(), clock, config, log, scanner: cleanScanner,
      replica_id: "host:1", github_budget: () => client.status(),
    });
    gh.state.remaining = 0;
    await client.request("GET", "/repos/o/r/pulls/200");
    const reset_at = new Date(gh.state.reset * 1000).toISOString();
    gh.state.calls = [];
    other.queue.push({ kind: "item_requested", source: slackRef(1), requester: alice, title: "t", body: "b" });

    const stop = new AbortController();
    const running = controller.run(stop.signal);
    await waitFor(() => other.polls.length >= 1, "first poll");
    clock.advance(config.poll_interval_ms);
    await waitFor(() => other.polls.length >= 2, "second poll: the loop goes on");
    stop.abort();
    await running;

    expect(gh.state.calls).toEqual([]);
    expect(await store.getWorkItemBySource("slack_thread", slackRef(1).id)).not.toBeNull();
    expect(log.lines.filter((l) => l.msg === "loop step failed")).toEqual([]);
    expect(log.lines.find((l) => l.msg === "waiting for the GitHub rate-limit reset")).toEqual({
      level: "warn", msg: "waiting for the GitHub rate-limit reset", fields: { step: "intake:github_issue", until: reset_at },
    });
    expect(JSON.parse((await store.getCursor(GITHUB_BUDGET_CURSOR))!)).toMatchObject({ remaining: 0, reset_at, state: "waiting", replica_id: "host:1" });
    expect(await readGitHubBudget(store, clock.now())).toMatchObject({ state: "waiting", wait_reason: `waiting for the GitHub rate-limit reset at ${reset_at}` });
  });
});
