// The shared forge budget (design 05-sources, call budget): each GitHub response's rate limit is written to the store
// (`forge_budget`, newer updated_at wins), and each client reads the row at most once per tick. So when one replica's
// response drops it under 10% left, the others skip their optional reads on their next tick, until reset_at. Outbox
// delivery and the sync lease never wait on it.

import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { syncLeaseName } from "../src/core/lease.js";
import type { Timestamp } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { FORGE_BUDGET_PLUGIN, GitHubClient } from "../src/impl/github/github-client.js";
import { OpaqueSecret } from "../src/impl/secrets/env-file-secret-store.js";
import { GitHubIssueSource } from "../src/impl/github/github-issue-source.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import { secretName } from "../src/interfaces/secret-store.js";
import { syncChecks } from "../src/ui/health.js";
import { FakeAuth, cleanScanner, config, recordingLog } from "./helpers/fakes.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

const credentials: GitHubCredentials = { token: async () => new OpaqueSecret(secretName("GITHUB_TOKEN"), "ghs_test") };
const REPO = { owner: "o", name: "r" };

/** GitHub over fetch: `remaining` of 5000 left until `reset`; every call recorded with the client that made it. */
function fakeGitHub(clock: FakeClock) {
  const state = { remaining: 4000, reset: Math.floor(clock.now().getTime() / 1000) + 3600, calls: [] as { by: string; method: string; path: string }[] };
  const fetchFor = (by: string) => (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    state.calls.push({ by, method, path: url.pathname });
    const body = method === "GET" ? [] : { id: state.calls.length, html_url: `https://github.com/o/r/issues/1#issuecomment-${state.calls.length}` };
    return new Response(JSON.stringify(body), {
      status: method === "POST" ? 201 : 200,
      headers: {
        "content-type": "application/json", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": String(state.remaining),
        "x-ratelimit-reset": String(state.reset), "x-ratelimit-resource": "core",
      },
    });
  }) as typeof fetch;
  const by = (who: string) => state.calls.filter((c) => c.by === who);
  return { state, fetchFor, by };
}

async function setup() {
  const clock = new FakeClock("2026-11-08T09:00:00Z");
  const { store } = await newStore(clock);
  const gh = fakeGitHub(clock);
  const client = (who: string, s: Pick<FactoryStore, "getForgeBudget" | "putForgeBudget"> = store) => {
    const c = new GitHubClient(credentials, "https://gh.test", { fetch: gh.fetchFor(who), clock, etag_entries: 0, min_remaining: 0 });
    c.shareBudget({ store: s, project: PROJECT_KEY, refresh_ms: config.tick_ms });
    return c;
  };
  /** A replica's controller over its own client; `sources` gets the GitHub issue source on that client. */
  const controller = (who: string) => {
    const c = client(who);
    const source = new GitHubIssueSource(c, REPO, "factory", "factory/", "main", "sf: ", store);
    const log = recordingLog();
    const ctl = new ControllerRole({
      store, sources: [source], auth: new FakeAuth(), clock, config, log, scanner: cleanScanner, replica_id: who,
      refresh_forge_budget: () => c.refreshSharedBudget(), github_budget: () => c.status(),
    });
    return { client: c, source, controller: ctl, log };
  };
  /** Past the reset: GitHub's window starts again with the full limit. */
  const reset = () => {
    clock.set(new Date(gh.state.reset * 1000 + 1000));
    gh.state.remaining = 5000;
    gh.state.reset += 3600;
  };
  return { clock, store, gh, client, controller, reset };
}

describe("GitHubClient: the budget is shared through the store", () => {
  it("a response under 10% left makes another replica's client low on its next refresh, until reset_at", async () => {
    const { store, gh, client, clock } = await setup();
    const a = client("a");
    const b = client("b");
    gh.state.remaining = 400;
    await a.request("GET", "/repos/o/r");
    expect(await store.getForgeBudget(PROJECT_KEY, FORGE_BUDGET_PLUGIN)).toMatchObject({
      project: PROJECT_KEY, plugin: "github", remaining: 400, limit: 5000, reset_at: new Date(gh.state.reset * 1000).toISOString(), updated_at: clock.now().toISOString(),
    });
    // b made no call of its own: it knows nothing until it reads the shared row.
    expect(b.lowBudget()).toBe(false);
    await b.refreshSharedBudget();
    expect(b.lowBudget()).toBe(true);
    expect(gh.by("b")).toEqual([]);
    clock.set(new Date(gh.state.reset * 1000));
    expect(b.lowBudget()).toBe(false);
  });

  it("reads the row at most once per tick, however many responses; writes after each response", async () => {
    const { store, client, clock } = await setup();
    let reads = 0;
    let writes = 0;
    const counting: Pick<FactoryStore, "getForgeBudget" | "putForgeBudget"> = {
      getForgeBudget: (p, plugin) => (reads++, store.getForgeBudget(p, plugin)),
      putForgeBudget: (b) => (writes++, store.putForgeBudget(b)),
    };
    const c = client("a", counting);
    for (let i = 0; i < 5; i++) await c.request("GET", "/repos/o/r");
    await c.refreshSharedBudget();
    expect([reads, writes]).toEqual([1, 5]);
    clock.advance(config.tick_ms);
    await c.request("GET", "/repos/o/r");
    expect([reads, writes]).toEqual([2, 6]);
  });

  it("an older reading never replaces a newer one: a slow replica's write changes nothing", async () => {
    const { store, gh, client, clock } = await setup();
    const slow = client("slow");
    const fast = client("fast");
    await slow.request("GET", "/repos/o/r");
    clock.advance(1);
    gh.state.remaining = 300;
    await fast.request("GET", "/repos/o/r");
    // The slow replica writes its (older) reading again: the row keeps the newer one.
    await store.putForgeBudget({ ...(await store.getForgeBudget(PROJECT_KEY, "github"))!, remaining: 4000, updated_at: new Date(clock.now().getTime() - 1).toISOString() as Timestamp });
    expect(await store.getForgeBudget(PROJECT_KEY, "github")).toMatchObject({ remaining: 300 });
  });

  it("with no store shared, the client keeps main's per-process behaviour: no row, the same calls", async () => {
    const { store, gh, clock } = await setup();
    const alone = new GitHubClient(credentials, "https://gh.test", { fetch: gh.fetchFor("alone"), clock, etag_entries: 0 });
    await alone.request("GET", "/repos/o/r");
    expect(gh.by("alone")).toHaveLength(1);
    expect(await store.getForgeBudget(PROJECT_KEY, "github")).toBeNull();
  });
});

describe("controller: optional reads wait for the shared budget's reset", () => {
  it("another replica's low response makes this one skip the status catch-up on its next tick, with no call; it runs after reset_at", async () => {
    const { store, gh, client, controller, reset } = await setup();
    await store.createWorkItem(issue(7), system);
    const b = controller("b");
    gh.state.remaining = 400;
    await client("a").request("GET", "/repos/o/r");

    expect(await b.controller.catchUpStatus()).toBe(false);
    expect(gh.by("b")).toEqual([]);

    reset();
    expect(await b.controller.catchUpStatus()).toBe(true);
    expect(gh.by("b").some((c) => c.path.startsWith("/repos/o/r/issues/7"))).toBe(true);
  });

  it("a poll while low skips its optional commit reads; after reset_at they come back", async () => {
    const { gh, client, controller, reset } = await setup();
    const b = controller("b");
    gh.state.remaining = 400;
    await client("a").request("GET", "/repos/o/r");
    await b.controller.tickIntake();
    const paths = gh.by("b").map((c) => c.path);
    expect(paths).toContain("/repos/o/r/issues/comments");
    expect(paths).not.toContain("/repos/o/r/commits");

    reset();
    await b.controller.tickIntake();
    expect(gh.by("b").map((c) => c.path)).toContain("/repos/o/r/commits");
  });

  it("outbox delivery and the sync lease still run while the budget is low", async () => {
    const { store, gh, client, controller, clock } = await setup();
    const { item } = await store.createWorkItem(issue(1), system);
    const b = controller("b");
    gh.state.remaining = 400;
    await client("a").request("GET", "/repos/o/r");
    await store.recordItemMessage({ work_item_id: item.id, marker: "<!-- factory:m1 -->", body: "hello", delivery: { source_type: "github_issue", target: issue(1).source } });

    await b.controller.tickOutbox();
    expect(b.client.lowBudget()).toBe(true);
    expect(gh.by("b").filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/repos/o/r/issues/1/comments"]);
    expect((await store.listDeliveries(item.id)).map((d) => d.delivered_at !== null)).toEqual([true]);

    const name = syncLeaseName("github_issue", config.project.key);
    const first = (await store.getSyncLease(name))!;
    expect(first.owner).toBe("b");
    clock.advance(config.heartbeat_ms);
    await b.controller.tickOutbox();
    const renewed = (await store.getSyncLease(name))!;
    expect(renewed).toMatchObject({ owner: "b", token: first.token });
    expect(Date.parse(renewed.expires_at)).toBeGreaterThan(Date.parse(first.expires_at));
  });
});

describe("Health: the sync line", () => {
  it("shows the shared budget, its reset (UTC) and the replica holding the sync lease; a warn below 10% or with no holder", async () => {
    const { store, gh, client, controller, clock } = await setup();
    await store.advanceCursor("project_key:o/r", null, PROJECT_KEY);
    expect(await syncChecks(store, REPO, FORGE_BUDGET_PLUGIN, clock.now())).toEqual([]);
    const b = controller("replica-7");
    gh.state.remaining = 812;
    gh.state.reset = Date.parse("2026-11-08T09:12:00Z") / 1000;
    await b.controller.tickOutbox();
    await client("a").request("GET", "/repos/o/r");
    expect(await syncChecks(store, REPO, FORGE_BUDGET_PLUGIN, clock.now())).toEqual([
      { ok: true, msg: "GitHub: 812/5000 left, resets 09:12, synced by replica replica-7" },
    ]);
    gh.state.remaining = 400;
    clock.advance(1);
    await client("a").request("GET", "/repos/o/r");
    expect(await syncChecks(store, REPO, FORGE_BUDGET_PLUGIN, clock.now())).toMatchObject([{ ok: false, warn: true }]);
    clock.advance(config.lease_ms);
    expect((await syncChecks(store, REPO, FORGE_BUDGET_PLUGIN, clock.now()))[0]!.msg).toMatch(/no replica holds the sync lease$/);
  });
});
