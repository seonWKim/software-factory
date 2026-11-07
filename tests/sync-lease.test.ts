// One GitHub sync per project (design 05-coordination, sync lease): only the holder of `sync:<type>:<project>` polls
// GitHub and delivers the GitHub outbox, so N replicas on one store make the calls one does. A takeover comes within
// lease_ms of the holder's last renew, and the token fences every cursor write and delivery claim.

import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import { syncLeaseName } from "../src/core/lease.js";
import type { WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubClient } from "../src/impl/github/github-client.js";
import { OpaqueSecret } from "../src/impl/secrets/env-file-secret-store.js";
import { GitHubIssueSource } from "../src/impl/github/github-issue-source.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import { secretName } from "../src/interfaces/secret-store.js";
import { FakeAuth, FakeSource, cleanScanner, config, recordingLog } from "./helpers/fakes.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

const credentials: GitHubCredentials = { token: async () => new OpaqueSecret(secretName("GITHUB_TOKEN"), "ghs_test") };
const LEASE = syncLeaseName("github_issue", config.project.key);

/** GitHub over fetch for o/r: one open factory issue, nothing else; each call recorded with the replica that made it. */
function fakeGitHub(clock: FakeClock) {
  const state = {
    remaining: 4000,
    reset: Math.floor(clock.now().getTime() / 1000) + 3600,
    calls: [] as { by: string; method: string; path: string }[],
    posted: 0,
  };
  const user = { id: 1, login: "alice", type: "User" };
  const open = [{ number: 7, title: "t", body: "b", user, updated_at: "2026-11-08T00:00:00Z" }];
  const route = (method: string, url: URL): unknown => {
    if (method !== "GET") return { id: ++state.posted, html_url: `https://github.com/o/r/issues/7#issuecomment-${state.posted}` };
    const first = (url.searchParams.get("page") ?? "1") === "1";
    return url.pathname === "/repos/o/r/issues" && url.searchParams.get("state") === "open" && first ? open : [];
  };
  const fetchFor = (by: string) => (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    state.calls.push({ by, method, path: url.pathname + url.search });
    return new Response(JSON.stringify(route(method, url)), {
      status: method === "POST" ? 201 : 200,
      headers: {
        "content-type": "application/json", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": String(state.remaining),
        "x-ratelimit-reset": String(state.reset), "x-ratelimit-resource": "core",
      },
    });
  }) as typeof fetch;
  return { state, fetchFor };
}

/** `n` replicas on one store and one GitHub, each with its own client (its own process) sharing the budget. */
async function replicas(n: number) {
  const clock = new FakeClock("2026-11-08T09:00:00Z");
  const { store } = await newStore(clock);
  const gh = fakeGitHub(clock);
  const log = recordingLog();
  const controllers = Array.from({ length: n }, (_, i) => {
    const client = new GitHubClient(credentials, "https://gh.test", { fetch: gh.fetchFor(`host:${i}`), clock, etag_entries: 0 });
    client.shareBudget({ store, project: PROJECT_KEY, refresh_ms: config.tick_ms });
    const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main", "sf: ", store);
    return new Controller({
      store, sources: [source], auth: new FakeAuth(), clock, config, log, scanner: cleanScanner, replica_id: `host:${i}`,
      refresh_forge_budget: () => client.refreshSharedBudget(), github_budget: () => client.status(),
    });
  });
  /** One poll tick on every replica, in turn; the GitHub calls it made. */
  const tick = async () => {
    const before = gh.state.calls.length;
    for (const c of controllers) await c.tickIntake();
    clock.advance(config.poll_interval_ms);
    return gh.state.calls.slice(before);
  };
  return { clock, store, gh, log, controllers, tick };
}

/** The rows of `table`, for before/after comparisons. */
async function rows(store: FactoryStore, table: string) {
  return (await store.listTableRows({ table, limit: 200 }))!.rows;
}

describe("one GitHub sync per project", () => {
  it("three controllers on one store and one GitHub make the same calls per tick as one controller", async () => {
    const one = await replicas(1);
    const three = await replicas(3);
    for (let t = 0; t < 3; t++) {
      const [a, b] = [await one.tick(), await three.tick()];
      expect(b.length).toBeGreaterThan(0);
      expect(b.map((c) => [c.method, c.path])).toEqual(a.map((c) => [c.method, c.path]));
      // Exactly one replica syncs: the one holding the lease.
      expect(new Set(b.map((c) => c.by))).toEqual(new Set(["host:0"]));
    }
    expect(await three.store.getSyncLease(LEASE)).toMatchObject({ owner: "host:0" });
    expect(await three.store.getWorkItemBySource("github_issue", "o/r#7")).not.toBeNull();
  });

  it("running the same tick twice at one time writes no new lease, budget or cursor row", async () => {
    const r = await replicas(2);
    for (const c of r.controllers) await c.tickIntake();
    // The sync cursors only: `github:budget` is this process's call count for the status page, a report, not a sync write.
    const cursors = async () => (await rows(r.store, "cursors")).filter((c) => String(c.name).startsWith("intake:"));
    const snapshot = async () => [await rows(r.store, "sync_leases"), await rows(r.store, "forge_budget"), await cursors()];
    const before = await snapshot();
    expect(before[0]).toHaveLength(1);
    expect(before[1]).toHaveLength(1);
    for (const c of r.controllers) await c.tickIntake();
    expect(await snapshot()).toEqual(before);
  });

  it("with no GitHub plugin selected, no sync lease or budget row is written", async () => {
    const clock = new FakeClock("2026-11-08T09:00:00Z");
    const { store } = await newStore(clock);
    const source = new FakeSource("slack_thread");
    const controller = new Controller({ store, sources: [source], auth: new FakeAuth(), clock, config, log: recordingLog(), scanner: cleanScanner });
    await controller.tickIntake();
    await controller.tickOutbox();
    await controller.catchUpStatus();
    expect(source.polls).toHaveLength(1);
    expect(await rows(store, "sync_leases")).toEqual([]);
    expect(await rows(store, "forge_budget")).toEqual([]);
  });
});

describe("sync lease takeover", () => {
  /** Two replicas, each with its own GitHub source stand-in, delivering one item's thread. */
  async function pair() {
    const clock = new FakeClock("2026-11-08T09:00:00Z");
    const { store } = await newStore(clock);
    const log = recordingLog();
    const { item } = await store.createWorkItem(issue(1), system);
    const make = (id: string) => {
      const source = new FakeSource("github_issue");
      const controller = new Controller({ store, sources: [source], auth: new FakeAuth(), clock, config, log, scanner: cleanScanner, replica_id: id });
      return { source, controller };
    };
    let n = 0;
    const write = async () => {
      const marker = `<!-- factory:m${++n} -->`;
      await store.recordItemMessage({ work_item_id: item.id as WorkItemId, marker, body: `message ${n}`, delivery: { source_type: "github_issue", target: issue(1).source } });
      return marker;
    };
    return { clock, store, log, item, a: make("host:a"), b: make("host:b"), write };
  }

  it("when the holder stops heartbeating another replica takes the lease within lease_ms; no comment is posted twice or skipped", async () => {
    const { clock, store, log, item, a, b, write } = await pair();
    const written = [await write(), await write()];
    const t0 = clock.now().getTime();
    await a.controller.tickOutbox();
    await b.controller.tickOutbox();
    expect(await store.getSyncLease(LEASE)).toMatchObject({ owner: "host:a", token: 1 });
    expect(a.source.comments.map((c) => c.marker)).toEqual(written);
    expect(b.source.comments).toEqual([]);

    // Replica a stops (no more ticks, no more renews). b keeps ticking and delivers nothing while a's lease lives.
    written.push(await write(), await write());
    let takenAt: number | null = null;
    while (takenAt === null) {
      clock.advance(config.heartbeat_ms);
      await b.controller.tickOutbox();
      if ((await store.getSyncLease(LEASE))?.owner === "host:b") takenAt = clock.now().getTime();
      else expect(b.source.comments).toEqual([]);
    }
    expect(takenAt - t0).toBeLessThanOrEqual(config.lease_ms);
    expect(await store.getSyncLease(LEASE)).toMatchObject({ owner: "host:b", token: 2 });
    expect(b.source.comments.map((c) => c.marker)).toEqual(written.slice(2));

    // a comes back: its renew is refused, so it delivers nothing more; b delivers what is written next.
    written.push(await write());
    await a.controller.tickOutbox();
    await b.controller.tickOutbox();
    const posted = [...a.source.comments, ...b.source.comments].map((c) => c.marker);
    expect([...posted].sort()).toEqual([...written].sort());
    expect(new Set(posted).size).toBe(posted.length);
    expect((await store.listDeliveries(item.id)).every((d) => d.delivered_at !== null)).toBe(true);
    expect(log.lines.filter((l) => l.msg === "sync lease lost").map((l) => l.fields)).toEqual([
      expect.objectContaining({ sync: "github_issue", owner: "host:a", reason: "renew_refused", holder: "host:b" }),
    ]);
  });

  it("a fenced cursor write from the old holder moves nothing once the lease was taken over", async () => {
    const { clock, store, a, b } = await pair();
    a.source.queue.push({ kind: "help_requested", source: issue(1).source, comment_id: "1", requester: { provider: "github", subject: "1", login: "alice" } });
    await a.controller.tickIntake();
    const cursor = await store.getCursor("intake:github_issue");
    expect(cursor).not.toBeNull();
    clock.advance(config.lease_ms);
    await b.controller.tickIntake();
    expect(await store.getSyncLease(LEASE)).toMatchObject({ owner: "host:b", token: 2 });
    const moved = await store.getCursor("intake:github_issue");
    expect(moved).not.toBe(cursor);
    expect(await store.advanceSyncCursor({ name: LEASE, token: 1 }, "intake:github_issue", moved, "stale")).toBe(false);
    expect(await store.getCursor("intake:github_issue")).toBe(moved);
  });

  it("a holder whose fenced write is refused drops the lease at once and logs it", async () => {
    const { store, log, a, b, write } = await pair();
    await a.controller.tickOutbox();
    expect(await store.getSyncLease(LEASE)).toMatchObject({ owner: "host:a", token: 1 });
    // Another replica takes the lease before a's next heartbeat: a still believes it holds token 1.
    await store.releaseSyncLease(LEASE, 1);
    expect(await store.acquireSyncLease(LEASE, "host:b", config.lease_ms)).toMatchObject({ ok: true });
    const markers = [await write(), await write()];
    await a.controller.tickOutbox();
    expect(a.source.comments).toEqual([]);
    expect(log.lines.filter((l) => l.msg === "sync lease lost").map((l) => l.fields)).toEqual([
      expect.objectContaining({ sync: "github_issue", owner: "host:a", reason: "fenced_write_refused" }),
    ]);
    await b.controller.tickOutbox();
    expect(b.source.comments.map((c) => c.marker)).toEqual(markers);
  });

  it("a refused cursor write under a live lease keeps the lease", async () => {
    const { store, log, a } = await pair();
    await a.controller.tickIntake();
    // The cursor moved under a (e.g. the same tick ran twice); the lease token is still a's.
    const cursor = await store.getCursor("intake:github_issue");
    await store.advanceCursor("intake:github_issue", cursor, "elsewhere");
    a.source.queue.push({ kind: "help_requested", source: issue(1).source, comment_id: "1", requester: { provider: "github", subject: "1", login: "alice" } });
    await a.controller.tickIntake();
    expect(log.lines.filter((l) => l.msg === "sync lease lost")).toEqual([]);
    expect(await store.getSyncLease(LEASE)).toMatchObject({ owner: "host:a", token: 1 });
  });

  it("a controller that stops releases the lease, so another replica takes it at once", async () => {
    const { store, a, b } = await pair();
    const stop = new AbortController();
    const running = a.controller.run(stop.signal);
    for (let i = 0; i < 50 && (await store.getSyncLease(LEASE))?.owner !== "host:a"; i++) await new Promise((r) => setTimeout(r, 5));
    stop.abort();
    await running;
    await b.controller.tickOutbox();
    expect(await store.getSyncLease(LEASE)).toMatchObject({ owner: "host:b", token: 2 });
  });
});
