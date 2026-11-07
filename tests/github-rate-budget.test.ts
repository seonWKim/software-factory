import { describe, expect, it } from "vitest";
import type { DependencyLink, DependencySource } from "../src/core/coordination.js";
import { Controller } from "../src/core/controller.js";
import type { DependencyState, SourceRef } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubClient, GitHubError } from "../src/impl/github/github-client.js";
import { OpaqueSecret } from "../src/impl/secrets/env-file-secret-store.js";
import { GitHubIssueSource } from "../src/impl/github/github-issue-source.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import { secretName } from "../src/interfaces/secret-store.js";
import { FakeAuth, FakeSource, cleanScanner, config, recordingLog, silent } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// The GitHub request budget (issue #254): every response's rate-limit headers are kept, and under 10% (or
// github.min_remaining) left the optional reads (dependency state refreshes, status catch-up) wait for the reset.

const credentials: GitHubCredentials = { token: async () => new OpaqueSecret(secretName("GITHUB_TOKEN"), "ghs_test") };
const LOW_MSG = "GitHub budget low: optional reads wait for the reset";
const BACK_MSG = "GitHub budget back: optional reads resume";

/** A fetch that answers every call with `status` and the current rate-limit headers. */
function fakeFetch(clock: FakeClock) {
  const state = { limit: 5000, remaining: 4000, reset: Math.floor(clock.now().getTime() / 1000) + 3600, status: 200 };
  const fetchFn = (async () =>
    new Response(state.status === 204 ? null : JSON.stringify({}), {
      status: state.status,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-limit": String(state.limit),
        "x-ratelimit-remaining": String(state.remaining),
        "x-ratelimit-reset": String(state.reset),
        "x-ratelimit-resource": "core",
      },
    })) as typeof fetch;
  return { state, fetchFn };
}

function client(opts: { min_remaining?: number } = {}) {
  const clock = new FakeClock();
  const log = recordingLog();
  const gh = fakeFetch(clock);
  const c = new GitHubClient(credentials, "https://gh.test", { fetch: gh.fetchFn, clock, log, min_remaining: opts.min_remaining ?? 0, etag_entries: 0 });
  return { clock, log, gh, c };
}

describe("GitHubClient: x-ratelimit headers on every response", () => {
  it("keeps remaining and reset from each answer: a GET, a write, a 204 and an error", async () => {
    const { gh, c } = client();
    const resetAt = (s: number) => new Date(s * 1000).toISOString();
    await c.request("GET", "/a");
    expect(c.budget()).toEqual({ limit: 5000, remaining: 4000, reset_at: resetAt(gh.state.reset) });
    gh.state.remaining = 3999;
    await c.request("POST", "/b", { x: 1 });
    expect(c.budget()?.remaining).toBe(3999);
    gh.state.remaining = 3998;
    gh.state.status = 204;
    await c.request("DELETE", "/c");
    expect(c.budget()?.remaining).toBe(3998);
    gh.state.remaining = 3997;
    gh.state.reset += 60;
    gh.state.status = 404;
    await expect(c.request("GET", "/d")).rejects.toBeInstanceOf(GitHubError);
    expect(c.budget()).toEqual({ limit: 5000, remaining: 3997, reset_at: resetAt(gh.state.reset) });
  });
});

describe("GitHubClient: under 10% left, optional reads wait for the reset", () => {
  it("is low below 10% of the limit even with min_remaining 0, until the reset passes; logs once entering and once leaving", async () => {
    const { clock, log, gh, c } = client();
    gh.state.remaining = 500;
    await c.request("GET", "/a");
    expect(c.lowBudget()).toBe(false);
    gh.state.remaining = 499;
    await c.request("GET", "/a");
    for (let i = 0; i < 5; i++) expect(c.lowBudget()).toBe(true);
    // Still low after more calls and a minute later.
    await c.request("GET", "/a");
    clock.advance(60_000);
    expect(c.lowBudget()).toBe(true);
    // The reset passes: optional reads resume, even before another response arrives.
    clock.advance(3600_000);
    for (let i = 0; i < 3; i++) expect(c.lowBudget()).toBe(false);
    expect(log.lines.map((l) => l.msg)).toEqual([LOW_MSG, BACK_MSG]);
  });

  it("the share follows the reported limit (an App installation's larger limit)", async () => {
    const { gh, c } = client();
    gh.state.limit = 15000;
    gh.state.remaining = 1499;
    await c.request("GET", "/a");
    expect(c.lowBudget()).toBe(true);
  });

  it("the GitHub source reports its client's budget", async () => {
    const { gh, c } = client();
    const source = new GitHubIssueSource(c, { owner: "o", name: "r" }, "factory", "factory/", "main");
    await c.request("GET", "/a");
    expect(source.lowBudget()).toBe(false);
    gh.state.remaining = 10;
    await c.request("GET", "/a");
    expect(source.lowBudget()).toBe(true);
  });
});

/** A dependency source whose budget the test sets; counts its forge reads. */
class BudgetSource extends FakeSource implements DependencySource {
  low = false;
  links = new Map<string, DependencyLink[]>();
  states = new Map<string, DependencyState>();
  stateReads = 0;
  lowBudget(): boolean {
    return this.low;
  }
  async dependencyLinks(source: SourceRef): Promise<DependencyLink[]> {
    return this.links.get(source.id) ?? [];
  }
  async dependencyState(id: string): Promise<DependencyState> {
    this.stateReads++;
    return this.states.get(id) ?? "open";
  }
}

async function controller(source: BudgetSource) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const c = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  return { clock, store, c };
}

describe("controller: optional reads skipped while the budget is low, resumed after", () => {
  it("dependency state refresh: no forge read while low; the stored state stays; the read comes back after", async () => {
    const source = new BudgetSource();
    const f = await controller(source);
    source.links.set("o/r#1", [{ depends_on: "other/repo#5", kind: "blocked_by" }]);
    const { item } = await f.store.createWorkItem(issue(1), system);
    await f.store.transition({ id: item.id, expected_version: 1, actor: system, reason: "x", patch: { stage: "RUNNING", tier: 2, allowed_paths: ["lib/"] } });
    await f.store.transition({ id: item.id, expected_version: 2, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: "1:implement" } });
    await f.c.tickCoordination();
    expect(source.stateReads).toBe(1);
    expect((await f.store.getWorkItem(item.id))?.blocked_on).toBe("dependency");

    source.low = true;
    source.states.set("other/repo#5", "merged");
    f.clock.advance(11 * 60_000);
    await f.c.tickCoordination();
    expect(source.stateReads).toBe(1);
    expect(await f.store.listDependencyEdges({ work_item_id: item.id })).toMatchObject([{ state: "open" }]);

    source.low = false;
    await f.c.tickCoordination();
    expect(source.stateReads).toBe(2);
    expect((await f.store.getWorkItem(item.id))?.blocked_on).toBe("none");
  });

  it("status catch-up: nothing written while low; it runs once the budget is back", async () => {
    const source = new BudgetSource();
    const f = await controller(source);
    await f.store.createWorkItem(issue(1), system);
    source.low = true;
    expect(await f.c.catchUpStatus()).toBe(false);
    expect(source.statusCalls).toEqual([]);
    source.low = false;
    expect(await f.c.catchUpStatus()).toBe(true);
    expect(source.statusCalls.map((s) => s.source.id)).toEqual(["o/r#1"]);
  });
});
