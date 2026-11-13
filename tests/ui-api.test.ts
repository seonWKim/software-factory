// The read-only JSON API under /api/v1 (design §9): its contract, its request guards, that it lists the same
// rows as the HTML page, that store text leaves only through the Withholder, and that it never writes.
// Everything goes through respond(), the server's whole request handling without a socket.

import { describe, expect, it, vi } from "vitest";
import { commandState, commandsFor } from "../src/core/commands.js";
import { APP_COMMANDS, type PageAction } from "../src/ui/commands.js";
import type { AuthDecision } from "../src/interfaces/auth-provider.js";
import type { Timestamp, UserId, WorkItem, WorkItemId, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ALERT_DEDUPE_MS } from "../src/core/alarms.js";
import { saveProjectLabel } from "../src/core/project-labels.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, type UiDeps, type UiResponse, respond, wire } from "../src/ui/server.js";
import { type FileKeysView, type UiSettings, fileKeysOf, newCsrfToken, writeSettings } from "../src/ui/settings-api.js";
import type { ConfigEditRequest, ConfigEditResult } from "../src/core/config-writer.js";
import { checkoutRevision } from "../src/ui/system-actions.js";
import viteConfig from "../web/vite.config.js";
import { PROJECT_KEY, issue, newStore, system, w1 } from "./helpers/store.js";

const LEASE = 60_000;
// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const ROUTES = [
  "/api/v1/overview", "/api/v1/items", "/api/v1/items/ITEM", "/api/v1/runs", "/api/v1/queue", "/api/v1/workers", "/api/v1/health", "/api/v1/unreviewed-merges",
  "/api/v1/data/tables", "/api/v1/data/tables/controller_work_items", "/api/v1/data/tables/worker_runs", "/api/v1/data/tables/controller_state_changes",
];

function get(d: UiDeps, path: string, opts: { method?: string; host?: string } = {}): Promise<UiResponse> {
  return respond(d, { method: opts.method ?? "GET", url: path, host: opts.host ?? "127.0.0.1:4310" });
}

async function json<T = Record<string, unknown>>(d: UiDeps, path: string): Promise<T> {
  const r = await get(d, path);
  expect(r.status, path).toBe(200);
  return JSON.parse(r.body) as T;
}

async function make(store: FactoryStore, n: number, title: string | null): Promise<WorkItem> {
  return (await store.createWorkItem({ ...issue(n), ...(title === null ? {} : { title }) }, system)).item;
}

async function patch(store: FactoryStore, item: WorkItem, p: Parameters<FactoryStore["transition"]>[0]["patch"], reason = "seed") {
  const cur = (await store.getWorkItem(item.id))!;
  const r = await store.transition({ id: item.id, expected_version: cur.version, patch: p, actor: system, reason });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

async function enqueue(store: FactoryStore, item: WorkItem, kind: "triage" | "implement" | "review", key: string, p: Parameters<FactoryStore["transition"]>[0]["patch"] = {}) {
  const cur = (await store.getWorkItem(item.id))!;
  const r = await store.transition({ id: item.id, expected_version: cur.version, patch: p, actor: system, reason: "x", enqueue: { kind, idempotency_key: key } });
  if (!r.ok) throw new Error(r.reason);
}

/** One item per level, finished runs in the last 24 h, two running runs on two workers, and a secret in every free-text field. */
async function seeded(opts: { store?: (s: FactoryStore) => FactoryStore } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);

  const approve = await make(store, 1, "Spec for <script>alert(1)</script> the gate");
  await patch(store, approve, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
  const merge = await make(store, 2, "Merge me");
  await patch(store, merge, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42", tier: 2 });
  // Secrets: a title, a blocked reason, a state-change reason and detail value.
  const secretive = await make(store, 3, `Leaky ${SECRET} title`);
  await patch(store, secretive, { blocked_on: "human", blocked_reason: `custom ${SECRET}` }, `reason ${SECRET}`);
  const cur = (await store.getWorkItem(secretive.id))!;
  await store.transition({ id: secretive.id, expected_version: cur.version, patch: { tier: 3 }, actor: system, reason: "x", detail: { note: `detail ${SECRET}` } });

  // Finished runs: one succeeded with tokens, one failed carrying a secret in its error detail.
  const done = await make(store, 4, "Done item");
  await enqueue(store, done, "triage", "done:t");
  let r = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
  clock.advance(90_000);
  await store.completeRun(r.id, r.lease!.token, { status: "succeeded", summary: "ok", data: { tokens: 1234 } });
  await enqueue(store, done, "implement", "done:i");
  r = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
  await store.completeRun(r.id, r.lease!.token, { status: "failed", error_code: "agent_error", detail: `push failed: token ${SECRET} rejected`, infra: false });
  await patch(store, done, { stage: "CLOSED", close_reason: "completed", token_cost: 1234 });

  // Running: one on a plain worker (heartbeat goes stale), one on a worker whose id carries a secret.
  const running = await make(store, 5, "Running item");
  await enqueue(store, running, "implement", "run:i", { stage: "RUNNING" });
  const claimed = (await store.claimRun({ worker_id: "host:11:1" as WorkerId, kinds: ["implement"], lease_ms: LEASE }))!;
  const running2 = await make(store, 6, "Second running item");
  await enqueue(store, running2, "review", "run:r", { stage: "REVIEW" });
  const claimed2 = (await store.claimRun({ worker_id: `host:${SECRET}:2` as WorkerId, kinds: ["review"], lease_ms: LEASE }))!;
  const running3 = await make(store, 7, "Third running item");
  await enqueue(store, running3, "implement", "run:i3", { stage: "RUNNING" });
  await store.claimRun({ worker_id: "host:11:1" as WorkerId, kinds: ["implement"], lease_ms: LEASE });

  // Queued, one without a title.
  const queued = await make(store, 8, null);
  await enqueue(store, queued, "triage", "q:t");
  const queued2 = await make(store, 9, "Queued two");
  clock.advance(1_000);
  await enqueue(store, queued2, "triage", "q:t2");

  clock.advance(LEASE + 5_000);

  const scanner = new PatternEgressScanner(async () => []);
  let healthRuns = 0;
  const health = new HealthMonitor(async () => {
    healthRuns++;
    return [{ ok: true, msg: "secret file is outside the repository" }, { ok: false, msg: `mysql said ${SECRET}` }];
  }, clock);
  const d: UiDeps = {
    store: opts.store ? opts.store(store) : store,
    scanner,
    clock,
    lease_ms: LEASE,
    health,
  };
  return { d, store, clock, items: { approve, merge, secretive, done, running, running2, running3, queued, queued2 }, claimed, claimed2, healthRuns: () => healthRuns };
}

/** The data-key of every row in the HTML list, in order. */
function htmlKeys(body: string): string[] {
  const start = body.indexOf(`<section id="items">`);
  const sec = body.slice(start, body.indexOf("</section>", start));
  return [...sec.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]!);
}

function sectionOf(body: string, id: string): string {
  const start = body.indexOf(`<section id="${id}">`);
  return body.slice(start, body.indexOf("</section>", start));
}

describe("ui api: contract", () => {
  it("every route answers 200 JSON with no-store and the security headers", async () => {
    const { d, items } = await seeded();
    for (const route of ROUTES) {
      const path = route.replace("ITEM", items.approve.id);
      const r = await get(d, path);
      expect(r.status, path).toBe(200);
      expect(r.headers["content-type"], path).toBe("application/json; charset=utf-8");
      expect(r.headers["cache-control"], path).toBe("no-store");
      expect(r.headers["x-content-type-options"], path).toBe("nosniff");
      expect(r.headers["x-frame-options"], path).toBe("DENY");
      expect(r.headers["referrer-policy"], path).toBe("no-referrer");
      expect(r.headers["content-security-policy"], path).toMatch(/^default-src 'none'/);
      expect(() => JSON.parse(r.body), path).not.toThrow();
    }
  });

  it("HEAD gives the same status and headers as GET, and no body on the wire", async () => {
    const { d, items } = await seeded();
    for (const route of [...ROUTES, "/api/v1/nope", "/api/v1/items/nope"]) {
      const path = route.replace("ITEM", items.approve.id);
      const g = wire(await get(d, path), false);
      const h = wire(await get(d, path, { method: "HEAD" }), true);
      expect(h.status, path).toBe(g.status);
      expect(h.headers, path).toEqual(g.headers);
      expect(h.body.length, path).toBe(0);
      expect(g.body.length, path).toBe(Number(g.headers["content-length"]));
    }
  });

  it("other methods get 405 with allow: GET, HEAD; a foreign Host gets 403; both as JSON", async () => {
    const { d } = await seeded();
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const r = await get(d, "/api/v1/items", { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe("GET, HEAD");
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(r.body)).toHaveProperty("error");
    }
    for (const host of ["evil.example", "127.0.0.1.evil.example", "localhost.evil:4310", ""]) {
      const r = await get(d, "/api/v1/overview", { host });
      expect(r.status, host).toBe(403);
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    }
    expect((await get(d, "/api/v1/overview", { host: "localhost:4310" })).status).toBe(200);
  });

  it("an unknown /api/v1 path and an unknown item id are 404 JSON", async () => {
    const { d } = await seeded();
    for (const path of ["/api/v1", "/api/v1/", "/api/v1/nope", "/api/v1/items/", "/api/v1/items/a/b", "/api/v1/items/wi_nope", "/api/v1/items/%E0%A4%A"]) {
      const r = await get(d, path);
      expect(r.status, path).toBe(404);
      expect(r.headers["content-type"], path).toBe("application/json; charset=utf-8");
      expect(JSON.parse(r.body), path).toHaveProperty("error");
    }
  });
});

describe("ui api: items", () => {
  it("lists the same rows in the same order as / for the same query string, every filter included", async () => {
    const { d } = await seeded();
    const queries = [
      "", "?closed=1", "?state=needs", "?state=running", "?state=queued", "?state=closed", "?stage=REVIEW", "?stage=CLOSED",
      "?tier=2", "?kind=triage", "?kind=implement", "?unblocks=1", "?q=merge", "?q=%233", "?q=leaky", "?state=needs&tier=3",
    ];
    for (const q of queries) {
      const page = await get(d, `/classic${q}`);
      expect(page.status, q).toBe(200);
      const api = await json<{ total: number; items: { id: string }[] }>(d, `/api/v1/items${q}`);
      expect(api.items.map((i) => i.id), q).toEqual(htmlKeys(page.body));
      expect(api.total, q).toBe(api.items.length);
    }
  });

  it("the default list has every open item ranked, and the filters narrow it", async () => {
    const { d, items } = await seeded();
    const all = await json<{ items: { id: string; level: string; badges: string[]; stage: string; run_status: string | null }[] }>(d, "/api/v1/items");
    expect(all.items.length).toBe(8); // nine items, one closed
    expect(all.items[0]).toMatchObject({ id: items.merge.id, level: "ready_to_merge", badges: ["ready to merge"], stage: "REVIEW" });
    expect(all.items[1]).toMatchObject({ id: items.approve.id, level: "needs_approval" });
    const needs = await json<{ items: { id: string }[] }>(d, "/api/v1/items?state=needs");
    expect(needs.items.map((i) => i.id)).toEqual([items.merge.id, items.approve.id, items.secretive.id]);
    const closed = await json<{ items: { id: string }[] }>(d, "/api/v1/items?stage=CLOSED");
    expect(closed.items.map((i) => i.id)).toEqual([items.done.id]);
    const kind = await json<{ items: { id: string; run_status: string | null }[] }>(d, "/api/v1/items?kind=review");
    expect(kind.items).toMatchObject([{ id: items.running2.id, run_status: "running" }]);
  });

  it("returns the filter counts the page's options show", async () => {
    const { d } = await seeded();
    const api = await json<{ facets: { allStates: number; state: Record<string, number>; stage: Record<string, number> } }>(d, "/api/v1/items");
    expect(api.facets.state.needs).toBe(3);
    // The closed item counts under Closed though the default list leaves it out (same rule as every facet).
    expect(api.facets.stage.CLOSED).toBe(1);
    expect(api.facets.state.closed).toBe(1);
    const page = (await get(d, "/classic")).body;
    expect(page).toContain(`<option value="needs">Needs you (3)</option>`);
    expect(page).toContain(`>All (${api.facets.allStates})</option>`);
  });

  it("the Closed facet counts the closed items that match the other filters (148 closed items)", async () => {
    const { store } = await newStore(new FakeClock());
    for (let n = 1; n <= 148; n++) {
      const it = await make(store, 1000 + n, n % 4 === 0 ? `Old cleanup ${n}` : `Closed work ${n}`);
      await patch(store, it, { stage: "CLOSED", close_reason: "completed", tier: n % 2 === 0 ? 2 : 3 });
    }
    await make(store, 1, "Open work");
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock: new FakeClock(), lease_ms: LEASE, health: new HealthMonitor(async () => [], new FakeClock()) };
    const all = await json<{ items: { id: string }[]; facets: { allStates: number; state: Record<string, number>; stage: Record<string, number> } }>(d, "/api/v1/items");
    expect(all.items).toHaveLength(1);
    expect(all.facets.state.closed).toBe(148);
    expect(all.facets.stage.CLOSED).toBe(148);
    expect(all.facets.allStates).toBe(1);
    // Every other filter still applies to the Closed count.
    expect((await json<{ facets: { state: Record<string, number> } }>(d, "/api/v1/items?tier=2")).facets.state.closed).toBe(74);
    expect((await json<{ facets: { state: Record<string, number> } }>(d, "/api/v1/items?q=cleanup")).facets.state.closed).toBe(37);
    // Choosing Closed shows that many rows, and its own count stays the same.
    const closed = await json<{ items: unknown[]; facets: { state: Record<string, number> } }>(d, "/api/v1/items?state=closed");
    expect(closed.items).toHaveLength(148);
    expect(closed.facets.state.closed).toBe(148);
  });

  it("an unknown filter value is a 400 JSON, for each filter", async () => {
    const { d } = await seeded();
    for (const q of ["state=nope", "stage=DONE", "tier=9", "kind=deploy", "unblocks=yes", "closed=2"]) {
      const r = await get(d, `/api/v1/items?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(r.body).error, q).toMatch(/^Unknown /);
      expect((await get(d, `/classic?${q}`)).status, q).toBe(400);
    }
  });

  it("item detail has the facts, the timeline and the runs, and never a fencing token", async () => {
    const { d, items } = await seeded();
    const body = await json<{
      item: { id: string; title: string; stage: string; close_reason: string; token_cost: number; change_ref: string | null; conflicts: unknown };
      timeline: { version: number; reason: string; actor: { kind: string; id: string }; changes: Record<string, { from: string; to: string }> }[];
      runs: { kind: string; status: string; attempt: number; tokens: number | null; error: { code: string; detail: string } | null }[];
    }>(d, `/api/v1/items/${encodeURIComponent(items.done.id)}`);
    expect(body.item).toMatchObject({ id: items.done.id, title: "Done item", stage: "CLOSED", close_reason: "completed", token_cost: 1234 });
    expect(body.item.conflicts).toEqual({ automatic: 0, person: 0 });
    expect(body.timeline[0]).toMatchObject({ version: 1, reason: "intake", actor: { kind: "system", id: "system:test" } });
    expect(body.timeline.at(-1)!.changes.stage).toEqual({ from: `"NEW"`, to: `"CLOSED"` });
    expect(body.runs.map((r) => [r.kind, r.status, r.tokens])).toEqual([["triage", "succeeded", 1234], ["implement", "failed", null]]);
    expect(body.runs[1]!.error).toEqual({ code: "agent_error", detail: "[withheld: github_token]" });
    expect(JSON.stringify(body)).not.toMatch(/token"?\s*:\s*\d|"lease"/);
  });

  it("item detail has spec_comment_url, parent_id, phase and the parent's phases (id, phase, title, stage, source) in phase order", async () => {
    const { d, store } = await seeded();
    const parent = await make(store, 50, "Split parent");
    await patch(store, parent, { spec_comment_url: "https://github.com/o/r/issues/50#issuecomment-1" });
    // Filed out of order: the list follows phase order.
    const p2 = (await store.createWorkItem({ ...issue(52), title: `Phase two ${SECRET}`, parent: { id: parent.id, phase: 2 } }, system)).item;
    const p1 = (await store.createWorkItem({ ...issue(51), title: "Phase one", parent: { id: parent.id, phase: 1 } }, system)).item;
    type Detail = { item: { spec_comment_url: string | null; parent_id: string | null; phase: number | null; phases: unknown[] } };
    const top = await json<Detail>(d, `/api/v1/items/${encodeURIComponent(parent.id)}`);
    expect(top.item).toMatchObject({ spec_comment_url: "https://github.com/o/r/issues/50#issuecomment-1", parent_id: null, phase: null });
    expect(top.item.phases).toEqual([
      { id: p1.id, phase: 1, title: "Phase one", stage: "NEW", source: { type: p1.source.type, id: p1.source.id, link: p1.source.link } },
      { id: p2.id, phase: 2, title: "[withheld: github_token]", stage: "NEW", source: { type: p2.source.type, id: p2.source.id, link: p2.source.link } },
    ]);
    const phase = await json<Detail>(d, `/api/v1/items/${encodeURIComponent(p2.id)}`);
    expect(phase.item).toMatchObject({ spec_comment_url: null, parent_id: parent.id, phase: 2, phases: [] });
  });

  it("each run has its attempts in attempt order, with worker, status, times, error code, failure class and tokens", async () => {
    const { d, items } = await seeded();
    const body = await json<{ runs: { id: string; attempt: number; attempts: Record<string, unknown>[] }[] }>(
      d, `/api/v1/items/${encodeURIComponent(items.done.id)}`,
    );
    // The run fields as before, plus attempts.
    for (const r of body.runs) {
      expect(Object.keys(r)).toEqual(["id", "kind", "status", "attempt", "started_at", "finished_at", "created_at", "tokens", "error", "attempts"]);
    }
    const keys = ["attempt", "worker_id", "status", "started_at", "finished_at", "error_code", "failure_class", "tokens"];
    for (const r of body.runs) for (const a of r.attempts) expect(Object.keys(a)).toEqual(keys);
    expect(body.runs.map((r) => r.attempts.map((a) => [a.attempt, a.worker_id, a.status, a.error_code, a.failure_class, a.tokens]))).toEqual([
      [[1, w1, "succeeded", null, null, 1234]],
      [[1, w1, "failed", "agent_error", "task", 0]],
    ]);
    // A queued run that was never claimed has none; a running run has its open attempt.
    const queued = await json<{ runs: { attempts: unknown[] }[] }>(d, `/api/v1/items/${encodeURIComponent(items.queued.id)}`);
    expect(queued.runs[0]!.attempts).toEqual([]);
    const running = await json<{ runs: { attempts: Record<string, unknown>[] }[] }>(d, `/api/v1/items/${encodeURIComponent(items.running2.id)}`);
    expect(running.runs[0]!.attempts).toMatchObject([{ attempt: 1, worker_id: "[withheld: github_token]", status: "running", finished_at: null }]);
  });

  it("a step that fails twice and then succeeds shows three attempts across its three runs, each with its own start, end and tokens", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const it0 = await make(store, 50, "Retried");
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, model: null };
    const outcomes = [
      { status: "failed" as const, error_code: "push_failed", detail: "", infra: true, usage },
      { status: "failed" as const, error_code: "rate_limited", detail: "", infra: true },
      { status: "succeeded" as const, summary: "ok", data: { tokens: 400 } },
    ];
    for (const [i, outcome] of outcomes.entries()) {
      await enqueue(store, it0, "implement", `retried:i:${i}`);
      clock.advance(1_000);
      const r = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
      clock.advance(10_000 * (i + 1));
      await store.completeRun(r.id, r.lease!.token, outcome);
    }
    const d: UiDeps = {
      store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: LEASE,
      health: new HealthMonitor(async () => [], clock),
    };
    const body = await json<{ runs: { attempts: { started_at: string; finished_at: string; status: string; failure_class: string | null; tokens: number }[] }[] }>(
      d, `/api/v1/items/${encodeURIComponent(it0.id)}`,
    );
    const attempts = body.runs.flatMap((r) => r.attempts);
    expect(attempts.map((a) => [a.status, a.failure_class, a.tokens])).toEqual([
      ["failed", "infra", 15],
      ["failed", "rate_limited", 0],
      ["succeeded", null, 400],
    ]);
    expect(new Set(attempts.map((a) => a.started_at)).size).toBe(3);
    expect(new Set(attempts.map((a) => a.finished_at)).size).toBe(3);
    for (const a of attempts) expect(a.finished_at > a.started_at).toBe(true);
  });
});

describe("ui api: item thread (issue #286)", () => {
  it("item detail returns the thread from the store, oldest first: seq, time, kind, author ID or unknown, channel, anchor, withheld body", async () => {
    const { d, store, clock, items } = await seeded();
    const it = items.secretive;
    await store.recordItemMessage({ work_item_id: it.id, marker: "<!-- factory:spec:1 -->", body: "## Spec\n\nthe spec" });
    clock.advance(1_000);
    await store.recordItemMessage({ work_item_id: it.id, marker: "github:77", body: `a comment with ${SECRET}` });
    clock.advance(1_000);
    await store.recordItemMessage({ work_item_id: it.id, marker: "<!-- factory:refused:app-3 -->", body: "`/approve` was not applied" });
    await store.recordItemMessage({ work_item_id: items.approve.id, marker: "<!-- factory:spec:2 -->", body: "another item's" });
    const body = await json<{ thread: Record<string, unknown>[] }>(d, `/api/v1/items/${encodeURIComponent(it.id)}`);
    const listed = await store.listItemMessages(it.id);
    expect(body.thread).toEqual(listed.map((m, i) => ({
      seq: m.seq,
      at: m.created_at,
      kind: ["spec", "comment", "refused"][i],
      author: i === 1 ? "unknown" : "factory",
      role: i === 1 ? "owner" : "factory",
      channel: "github_issue",
      anchor: `msg-${m.seq}`,
      body: i === 1 ? "[withheld: github_token]" : m.body,
    })));
    expect(JSON.stringify(body)).not.toContain(SECRET);
    // An item with no entries has an empty thread.
    expect((await json<{ thread: unknown[] }>(d, `/api/v1/items/${encodeURIComponent(items.done.id)}`)).thread).toEqual([]);
  });

  it("the thread lists the owner's CLI and dashboard commands with their text, withheld; no other item's, no GitHub origin", async () => {
    const { d, store, clock, items } = await seeded();
    const it = items.secretive;
    await store.appendCliCommand({ key: "app:n1", actor: "local:me", command: "approve", args: { work_item_id: it.id, note: `go ${SECRET}` } });
    clock.advance(1_000);
    await store.appendCliCommand({ key: "cli:n2", actor: "local:me", command: "revise", args: { item: it.id, text: "split it" } });
    await store.appendCliCommand({ key: "cli:n3", actor: "local:me", command: "approve", args: { item: items.approve.id, text: "other item" } });
    await store.appendCliCommand({ key: "github:9", actor: "github:7", command: "retry", args: { item: it.id } });
    await store.appendCliCommand({ key: "cli:n4", actor: "local:me", command: "confirm", args: { item: it.id, proposal: "p" } });
    const body = await json<{ thread: Record<string, unknown>[] }>(d, `/api/v1/items/${encodeURIComponent(it.id)}`);
    expect(body.thread.map((e) => [e.kind, e.author, e.role, e.channel, e.body])).toEqual([
      ["approve", "local:me", "owner", "app", "[withheld: github_token]"],
      ["revise", "local:me", "owner", "cli", "split it"],
    ]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("the thread's non-factory entries are the owner's, with the stored actor ID when there is one", async () => {
    const { d, store, items } = await seeded();
    await store.recordItemMessage({ work_item_id: items.secretive.id, marker: "github:5", body: "from github", actor: "github:42" });
    const body = await json<{ thread: Record<string, unknown>[] }>(d, `/api/v1/items/${encodeURIComponent(items.secretive.id)}`);
    expect(body.thread.map((e) => [e.author, e.role])).toEqual([["github:42", "owner"]]);
  });

  it("the thread shows each verdict with its kind, actor ID and feedback text (withheld like any body)", async () => {
    const { d, store, clock, items } = await seeded();
    const it = items.secretive;
    clock.advance(1_000);
    const actor = { kind: "user" as const, id: "slack-linked:owner" as UserId };
    const base = { id: it.id, actor, target: "issue" as const, implicit: false, pr_head: null };
    const good = await store.recordVerdict({ ...base, expected_version: (await store.getWorkItem(it.id))!.version, verdict: "accept", severity: "none", reason: null, comment_id: "button:C1:1.1" });
    if (!good.ok) throw new Error(good.reason);
    const fb = await store.recordVerdict({
      ...base, expected_version: good.item.version, verdict: "changes", severity: "none", reason: `rename the flag ${SECRET}`, comment_id: "button:C1:1.2",
    });
    if (!fb.ok) throw new Error(fb.reason);
    const body = await json<{ thread: Record<string, unknown>[] }>(d, `/api/v1/items/${encodeURIComponent(it.id)}`);
    const verdicts = body.thread.filter((e) => e.kind === "verdict");
    expect(verdicts).toEqual([
      { seq: 0, at: good.verdict.at, kind: "verdict", author: actor.id, role: "owner", channel: "github_issue", anchor: `verdict-${good.verdict.id}`, body: "Verdict **accept**, severity none" },
      {
        seq: 0, at: fb.verdict.at, kind: "verdict", author: actor.id, role: "owner", channel: "github_issue", anchor: `verdict-${fb.verdict.id}`,
        body: "Verdict **changes**, severity none\n\n[withheld: github_token]",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("each Needs-you row's need has the anchor of the item's newest factory entry; null when it has none", async () => {
    const { d, store, items } = await seeded();
    await store.recordItemMessage({ work_item_id: items.secretive.id, marker: "<!-- factory:needs-human:1 -->", body: "first why" });
    const why = (await store.recordItemMessage({ work_item_id: items.secretive.id, marker: "<!-- factory:failed:2 -->", body: "second why" })).message;
    await store.recordItemMessage({ work_item_id: items.secretive.id, marker: "github:5", body: "a later comment" });
    const needs = await json<{ items: { id: string; need: { anchor: string | null } }[] }>(d, "/api/v1/items?state=needs");
    const anchors = Object.fromEntries(needs.items.map((i) => [i.id, i.need.anchor]));
    expect(anchors[items.secretive.id]).toBe(`msg-${why.seq}`);
    expect(anchors[items.approve.id]).toBeNull();
  });
});

describe("ui api: runs, queue, workers, overview, health", () => {
  it("/runs lists running then queued runs with owner, heartbeat, start and lease expiry, and no fencing token", async () => {
    const { d, items, claimed } = await seeded();
    const body = await json<{ runs: Record<string, unknown>[] }>(d, "/api/v1/runs");
    expect(body.runs.map((r) => r.status)).toEqual(["running", "running", "running", "queued", "queued"]);
    const first = body.runs.find((r) => r.id === claimed.id)!;
    expect(first).toEqual({
      id: claimed.id,
      status: "running",
      kind: "implement",
      work_item_id: items.running.id,
      attempt: 1,
      owner: "host:11:1",
      heartbeat_at: claimed.updated_at,
      started_at: claimed.started_at,
      lease_expires_at: claimed.lease!.expires_at,
      created_at: claimed.created_at,
    });
    const queued = body.runs.filter((r) => r.status === "queued");
    expect(queued.map((r) => r.work_item_id)).toEqual([items.queued.id, items.queued2.id]);
    expect(queued[0]).toMatchObject({ owner: null, heartbeat_at: null, lease_expires_at: null });
    for (const r of body.runs) expect(Object.keys(r)).not.toContain("token");
    expect(JSON.stringify(body)).not.toContain(`"token"`);
  });

  it("/queue is the queued runs oldest first, as the page's Queue section", async () => {
    const { d, items } = await seeded();
    const body = await json<{ queue: { position: number; kind: string; work_item_id: string; attempt: number }[] }>(d, "/api/v1/queue");
    expect(body.queue.map((q) => [q.position, q.kind, q.work_item_id])).toEqual([
      [1, "triage", items.queued.id],
      [2, "triage", items.queued2.id],
    ]);
    const rows = sectionOf((await get(d, "/classic")).body, "queue").split("<tr").length - 2; // minus the leading text and the header row
    expect(body.queue.length).toBe(rows);
  });

  it("/workers lists each current lease owner once with its running count, as IDs", async () => {
    const { d } = await seeded();
    const body = await json<{ workers: { owner: string; running: number }[] }>(d, "/api/v1/workers");
    expect(body.workers).toEqual([
      { owner: "[withheld: github_token]", running: 1 },
      { owner: "host:11:1", running: 2 },
    ]);
  });

  it("/workers adds processes: one entry per live process, idle ones too, each with its runs; workers is unchanged", async () => {
    const { d, store, clock, claimed } = await seeded();
    const started_at = clock.now().toISOString() as Timestamp;
    // A dead process's row: older than lease_ms, so not listed.
    await store.reportWorkerProcess({ process_id: "gone:3", pid: 3, host: "gone", slots: 1, max_slots: 1, busy: 1, index_base: 0, started_at });
    clock.advance(LEASE + 1);
    await store.reportWorkerProcess({ process_id: "host:11", pid: 11, host: "host", slots: 3, max_slots: 4, busy: 2, index_base: 0, started_at });
    await store.reportWorkerProcess({ process_id: "idle:5", pid: 5, host: "idle", slots: 2, max_slots: 2, busy: 0, index_base: 4, started_at });
    const body = await json<{ workers: unknown[]; processes: Record<string, unknown>[] }>(d, "/api/v1/workers");
    expect(body.workers).toEqual([
      { owner: "[withheld: github_token]", running: 1 },
      { owner: "host:11:1", running: 2 },
    ]);
    const reported_at = clock.now().toISOString();
    expect(body.processes.map((p) => [p.host, p.pid])).toEqual([["host", 11], ["idle", 5]]);
    expect(body.processes[0]).toMatchObject({
      process_id: "host:11", pid: 11, host: "host", slots: 3, max_slots: 4, busy: 2, idle: 1, index_base: 0, started_at, reported_at,
    });
    const runs = body.processes[0]!.runs as Record<string, unknown>[];
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.id === claimed.id)).toEqual({
      id: claimed.id, kind: "implement", work_item_id: claimed.work_item_id, worker_id: "host:11:1", started_at: claimed.started_at,
    });
    expect(body.processes[1]).toMatchObject({ pid: 5, slots: 2, max_slots: 2, busy: 0, idle: 2, index_base: 4, runs: [] });
    for (const p of body.processes) {
      for (const k of ["pid", "host", "slots", "max_slots", "busy", "reported_at"]) expect(Object.keys(p)).toContain(k);
    }
  });

  it("/workers still answers when the processes read fails (e.g. the table is missing): workers as before, processes empty, the error named", async () => {
    const { d, store } = await seeded();
    store.listWorkerProcesses = async () => {
      throw new Error("Table 'sf.worker_processes' doesn't exist");
    };
    const body = await json<{ workers: unknown[]; processes: unknown[]; processes_error?: string }>(d, "/api/v1/workers");
    expect(body.workers).toEqual([
      { owner: "[withheld: github_token]", running: 1 },
      { owner: "host:11:1", running: 2 },
    ]);
    expect(body.processes).toEqual([]);
    expect(body.processes_error).toBe("Table 'sf.worker_processes' doesn't exist");
  });

  it("/overview gives the numbers the page shows for the same store", async () => {
    const { d } = await seeded();
    const o = await json<{
      stages: Record<string, number>; needs_you: number; running: number; queued: number; last_24h: { succeeded: number; failed: number; tokens: number };
    }>(d, "/api/v1/overview");
    expect(o).toMatchObject({ needs_you: 3, running: 3, queued: 2, last_24h: { succeeded: 1, failed: 1, tokens: 1234 } });
    expect(o.stages).toEqual({ NEW: 3, READY: 1, RUNNING: 2, REVIEW: 2, CLOSED: 1 });

    const page = (await get(d, "/classic")).body;
    expect(page).toContain(`<title>(${o.needs_you}) software-factory status</title>`);
    const totals = sectionOf(page, "totals");
    const cell = (k: string) => Number(new RegExp(`<th scope="row">${k}</th><td>(\\d+)</td>`).exec(totals)![1]);
    for (const [stage, n] of Object.entries(o.stages)) expect(cell(stage), stage).toBe(n);
    expect(cell("succeeded")).toBe(o.last_24h.succeeded);
    expect(cell("failed")).toBe(o.last_24h.failed);
    expect(cell("tokens")).toBe(o.last_24h.tokens);
    const rows = (id: string) => sectionOf(page, id).split("<tr").length - 2;
    expect(rows("running")).toBe(o.running);
    expect(rows("queue")).toBe(o.queued);
  });

  it("/health returns what /api/health returns, from the one HealthMonitor (one run for both), and /api/health is unchanged", async () => {
    const { d, healthRuns } = await seeded();
    const v1 = await get(d, "/api/v1/health");
    const old = await get(d, "/api/health");
    // /api/v1/health is /api/health plus the host sleeps (issue #218); none are seeded here.
    expect(JSON.parse(v1.body)).toEqual({ ...JSON.parse(old.body), sleeps: [] });
    expect(healthRuns()).toBe(1);
    expect(JSON.parse(old.body)).toEqual({
      checked_at: d.clock.now().toISOString(),
      checks: [{ status: "ok", msg: "secret file is outside the repository" }, { status: "fail", msg: "[withheld: github_token]" }],
    });
    expect(old.headers["content-type"]).toBe("application/json; charset=utf-8");
  });
});

describe("ui api: host sleeps (issue #218)", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString() as Timestamp;

  it("/health lists the 10 newest host sleeps, newest first, as ids, times and numbers only; /api/health keeps its shape", async () => {
    const { d, store, claimed } = await seeded();
    for (let i = 0; i < 12; i++) {
      await store.recordHostSleep({ worker_id: w1, woke_at: at(i * 1000), gap_ms: 60_001 + i, run_id: i === 11 ? claimed.id : null });
    }
    const v1 = await json<{ sleeps: Record<string, unknown>[] }>(d, "/api/v1/health");
    expect(v1.sleeps.map((s) => s.woke_at)).toEqual(Array.from({ length: 10 }, (_, i) => at((11 - i) * 1000)));
    expect(v1.sleeps[0]).toEqual({ worker_id: w1, woke_at: at(11_000), gap_ms: 60_012, run_id: claimed.id });
    expect(v1.sleeps[1]).toEqual({ worker_id: w1, woke_at: at(10_000), gap_ms: 60_011, run_id: null });
    for (const s of v1.sleeps) {
      expect(Object.keys(s).sort()).toEqual(["gap_ms", "run_id", "woke_at", "worker_id"]);
      expect(typeof s.gap_ms).toBe("number");
    }
    const old = JSON.parse((await get(d, "/api/health")).body) as Record<string, unknown>;
    expect(Object.keys(old).sort()).toEqual(["checked_at", "checks"]);
  });

  it("/health answers with an empty sleeps list when the sleeps read fails", async () => {
    const { d } = await seeded({
      store: (s) => new Proxy(s, {
        get(target, prop, receiver) {
          if (prop === "listHostSleeps") return async () => { throw new Error("no such table: host_sleeps"); };
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }),
    });
    const v1 = await json<{ sleeps: unknown[]; checks: unknown[] }>(d, "/api/v1/health");
    expect(v1.sleeps).toEqual([]);
    expect(v1.checks).toHaveLength(2);
    expect(JSON.stringify(v1)).not.toContain("no such table");
  });

  it("item detail lists the sleeps recorded during that item's runs only, newest first", async () => {
    const { d, store, items, claimed, claimed2 } = await seeded();
    await store.recordHostSleep({ worker_id: w1, woke_at: at(1000), gap_ms: 120_000, run_id: claimed.id });
    await store.recordHostSleep({ worker_id: w1, woke_at: at(2000), gap_ms: 180_000, run_id: claimed.id });
    await store.recordHostSleep({ worker_id: w1, woke_at: at(3000), gap_ms: 240_000, run_id: claimed2.id });
    await store.recordHostSleep({ worker_id: w1, woke_at: at(4000), gap_ms: 300_000, run_id: null });
    const body = await json<{ sleeps: unknown[] }>(d, `/api/v1/items/${encodeURIComponent(items.running.id)}`);
    expect(body.sleeps).toEqual([
      { worker_id: w1, woke_at: at(2000), gap_ms: 180_000, run_id: claimed.id },
      { worker_id: w1, woke_at: at(1000), gap_ms: 120_000, run_id: claimed.id },
    ]);
    expect((await json<{ sleeps: unknown[] }>(d, `/api/v1/items/${encodeURIComponent(items.done.id)}`)).sleeps).toEqual([]);
  });
});

describe("ui api: withholding and read-only", () => {
  it("every withheld field is the [withheld: <rule>] marker, and the seeded secret is in no response body", async () => {
    const { d, items } = await seeded();
    const ids = Object.values(items).map((i) => i.id as WorkItemId);
    const paths = [
      ...ROUTES.filter((r) => !r.includes("ITEM")),
      ...ids.map((id) => `/api/v1/items/${encodeURIComponent(id)}`),
      "/api/v1/items?closed=1", "/api/v1/items?q=leaky", "/api/v1/items?state=needs",
    ];
    for (const path of paths) {
      const r = await get(d, path);
      expect(r.status, path).toBe(200);
      expect(r.body, path).not.toContain(SECRET);
      expect(r.body, path).not.toContain("Ab3Ab3");
    }
    const list = await json<{ items: { id: string; title: string; blocked_reason: string }[] }>(d, "/api/v1/items");
    const row = list.items.find((i) => i.id === items.secretive.id)!;
    expect(row.title).toBe("[withheld: github_token]");
    expect(row.blocked_reason).toBe("[withheld: github_token]");
    // A withheld title cannot be found by its text.
    expect((await json<{ items: unknown[] }>(d, "/api/v1/items?q=leaky")).items).toEqual([]);

    const detail = await json<{
      item: { title: string; blocked_reason: string };
      timeline: { reason: string; changes: Record<string, { from: string; to: string }>; detail: Record<string, string> | null }[];
    }>(d, `/api/v1/items/${encodeURIComponent(items.secretive.id)}`);
    expect(detail.item.title).toBe("[withheld: github_token]");
    expect(detail.timeline[1]!.reason).toBe("[withheld: github_token]");
    expect(detail.timeline[1]!.changes.blocked_reason!.to).toBe("[withheld: github_token]");
    expect(detail.timeline[2]!.detail).toEqual({ note: "[withheld: github_token]" });
  });

  it("titles are not HTML-escaped in JSON (the app escapes), and an untitled item has a null title", async () => {
    const { d, items } = await seeded();
    const list = await json<{ items: { id: string; title: string | null; source: { id: string } }[] }>(d, "/api/v1/items");
    expect(list.items.find((i) => i.id === items.approve.id)!.title).toBe("Spec for <script>alert(1)</script> the gate");
    expect(list.items.find((i) => i.id === items.queued.id)).toMatchObject({ title: null, source: { id: "o/r#8" } });
  });

  it("every route still answers 200 when any store method that is not a read throws", async () => {
    const calls: string[] = [];
    const readOnly = (s: FactoryStore): FactoryStore =>
      new Proxy(s, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver) as unknown;
          if (typeof v !== "function") return v;
          const name = String(prop);
          if (!/^(get|list|count)[A-Z]/.test(name) && name !== "schemaVersion") {
            return () => {
              throw new Error(`store.${name} is not a read`);
            };
          }
          return (...args: unknown[]) => {
            calls.push(name);
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const { d, items } = await seeded({ store: readOnly });
    for (const route of ROUTES) {
      const path = route.replace("ITEM", encodeURIComponent(items.done.id));
      expect((await get(d, path)).status, path).toBe(200);
      expect((await get(d, path, { method: "HEAD" })).status, path).toBe(200);
    }
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("ui api: plugins, issue and PR links (issue #240)", () => {
  type Row = { id: string; issue: { number: number; url: string } | null; change_ref: string | null; change_url: string | null };

  it("overview reports the plugins in use (issues only); absent deps mean none", async () => {
    const { d } = await seeded();
    expect((await json<{ plugins: unknown }>(d, "/api/v1/overview")).plugins).toEqual({ issues: null });
    const gh = { ...d, plugins: { issues: "github" } } as UiDeps;
    expect((await json<{ plugins: unknown }>(gh, "/api/v1/overview")).plugins).toEqual({ issues: "github" });
  });

  it("items carry the issue, null for an adopted PR, and the PR link the store keeps as change_url", async () => {
    const { d, store, items } = await seeded();
    await saveProjectLabel(store, { key: items.merge.project, label: "github.com/o/r" });
    const adopted = (await store.createWorkItem(
      { ...issue(90), source: { type: "github_issue", id: "o/r#90", link: "https://github.com/o/r/pull/90" } }, system,
    )).item;
    await patch(store, adopted, { change_ref: "90" });
    const stored = (await store.getWorkItem(adopted.id))!.change_url;
    expect(stored).toBe("https://github.com/o/r/pull/90");
    const list = (await json<{ items: Row[] }>(d, "/api/v1/items")).items;
    const merge = list.find((i) => i.id === items.merge.id)!;
    expect(merge.issue).toEqual({ number: 2, url: "https://github.com/o/r/issues/2" });
    const pr = list.find((i) => i.id === adopted.id)!;
    expect(pr.issue).toBeNull();
    expect(pr).toMatchObject({ change_ref: "90", change_url: stored });
    expect(Object.keys(pr)).not.toContain("pr_number");
    expect(Object.keys(pr)).not.toContain("pr_url");
    // The item page returns the same stored link.
    const one = await json<{ item: Row }>(d, `/api/v1/items/${adopted.id}`);
    expect(one.item).toMatchObject({ change_ref: "90", change_url: stored });
    expect(Object.keys(one.item)).not.toContain("pr_url");
  });

  it("a change_ref with no stored change_url has no link, even once a label is stored later (no link is built)", async () => {
    const { d, store, items } = await seeded();
    const before = (await json<{ items: Row[] }>(d, "/api/v1/items")).items.find((i) => i.id === items.merge.id)!;
    expect(before).toMatchObject({ change_ref: "42", change_url: null });
    await saveProjectLabel(store, { key: items.merge.project, label: "github.com/o/r" });
    const after = (await json<{ items: Row[] }>(d, "/api/v1/items")).items.find((i) => i.id === items.merge.id)!;
    expect(after).toMatchObject({ change_ref: "42", change_url: null });
    const none = (await json<{ items: Row[] }>(d, "/api/v1/items")).items.find((i) => i.id === items.running.id)!;
    expect(none).toMatchObject({ change_ref: null, change_url: null });
  });
});

describe("ui api: item commands POST (issue #227)", () => {
  const HOST = "127.0.0.1:4310";
  const ORIGIN = "http://127.0.0.1:4310";
  const ACTOR = "github:7" as UserId;
  const TOKEN = newCsrfToken();

  async function setup(actor: UserId | null = ACTOR) {
    const s = await seeded();
    s.d.commands = { actor, source: actor === null ? null : "config", token: TOKEN };
    return s;
  }

  interface PostOpts {
    path?: string; host?: string; origin?: string | null; contentType?: string | null; token?: string | null; raw?: string; bodyTooLarge?: boolean;
  }

  function post(d: UiDeps, id: string, body: unknown, o: PostOpts = {}): Promise<UiResponse> {
    return respond(d, {
      method: "POST",
      url: o.path ?? `/api/v1/items/${encodeURIComponent(id)}/commands`,
      host: o.host ?? HOST,
      origin: o.origin === null ? undefined : (o.origin ?? ORIGIN),
      contentType: o.contentType === null ? undefined : (o.contentType ?? "application/json"),
      csrfToken: o.token === null ? undefined : (o.token ?? TOKEN),
      body: o.raw ?? JSON.stringify(body),
      ...(o.bodyTooLarge ? { bodyTooLarge: true } : {}),
    });
  }

  async function appRequestRows(store: FactoryStore): Promise<number | undefined> {
    return (await store.listCliCommandsAfter(0, 100)).filter((c) => c.origin === "app").length;
  }

  async function nothingWritten(store: FactoryStore) {
    expect(await appRequestRows(store)).toBe(0);
  }

  async function refused(r: UiResponse, status: number, what: string) {
    expect(r.status, what).toBe(status);
    expect(r.headers["content-type"], what).toBe("application/json; charset=utf-8");
    expect(JSON.parse(r.body), what).toHaveProperty("error");
  }

  it("a valid request answers 202 with a request ID and writes one row for that item, acting as ui.user_id", async () => {
    const { d, store, items } = await setup();
    const r = await post(d, items.approve.id, { command: "approve", note: "  keep it small  " });
    expect(r.status).toBe(202);
    const got = JSON.parse(r.body) as { request_id: string; seq: number };
    expect(typeof got.request_id).toBe("string");
    expect(got.request_id).not.toBe("");
    expect(await appRequestRows(store)).toBe(1);
    expect(await store.getAppCommandRequest(got.seq)).toMatchObject({
      key: got.request_id, seq: got.seq, actor: ACTOR, command: "approve", args: { work_item_id: items.approve.id, note: "keep it small" },
    });
    // localhost with its own origin is accepted too; a note is optional on approve.
    const r2 = await post(d, items.approve.id, { command: "approve" }, { host: "localhost:4310", origin: "http://localhost:4310" });
    expect(r2.status).toBe(202);
    const keys = (await store.listAppCommandRequestsForItem(items.approve.id, 10)).map((x) => x.key);
    expect(keys).toEqual([got.request_id, (JSON.parse(r2.body) as { request_id: string }).request_id]);
    expect((await store.getAppCommandRequest((JSON.parse(r2.body) as { seq: number }).seq))!.args).toEqual({ work_item_id: items.approve.id });
  });

  it("a missing or wrong token is a 403 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const token of [null, "", "nope", newCsrfToken(), `${TOKEN}x`]) {
      await refused(await post(d, items.approve.id, { command: "approve" }, { token }), 403, String(token));
    }
    await nothingWritten(store);
  });

  it("a foreign Host is a 403 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const host of ["evil.example", "127.0.0.1.evil.example", "localhost.evil:4310", ""]) {
      await refused(await post(d, items.approve.id, { command: "approve" }, { host, origin: `http://${host}` }), 403, host);
    }
    await nothingWritten(store);
  });

  it("an Origin that is missing or not this server's own is a 403 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const origin of [null, "", "null", "http://evil.example", "https://127.0.0.1:4310", "http://127.0.0.1:4311", "http://localhost:4310", "http://127.0.0.1"]) {
      await refused(await post(d, items.approve.id, { command: "approve" }, { origin }), 403, String(origin));
    }
    await nothingWritten(store);
  });

  it("without an actor (a non-loopback server without ui.user_id, or the route not wired) a POST is a 503 and writes nothing", async () => {
    const { d, store, items } = await setup(null);
    await refused(await post(d, items.approve.id, { command: "approve" }), 503, "no user_id");
    expect(JSON.parse((await post(d, items.approve.id, { command: "approve" })).body).error).toContain("ui.user_id");
    const { commands: _, ...unwired } = d;
    await refused(await post(unwired, items.approve.id, { command: "approve" }), 503, "unwired");
    await nothingWritten(store);
  });

  it("a Content-Type other than application/json is a 415 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const contentType of [null, "", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonx"]) {
      await refused(await post(d, items.approve.id, { command: "approve" }, { contentType }), 415, String(contentType));
    }
    expect((await post(d, items.approve.id, { command: "approve" }, { contentType: "Application/JSON; charset=utf-8" })).status).toBe(202);
  });

  it("an unknown command, help and link included, is a 400 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const command of ["help", "link", "nope", "", "APPROVE", "/approve", 1, null, undefined]) {
      await refused(await post(d, items.approve.id, { command, note: "x" }), 400, String(command));
    }
    for (const body of [[], "approve", 1, null, { command: "approve", extra: 1 }, { command: "approve", note: 5 }]) {
      await refused(await post(d, items.approve.id, body), 400, JSON.stringify(body));
    }
    await nothingWritten(store);
  });

  it("every other item command is accepted for the controller to answer", async () => {
    const { d, store, items } = await setup();
    for (const command of ["reject", "revise", "retry", "resolve", "budget", "verdict"]) {
      expect((await post(d, items.approve.id, { command, note: "why" })).status, command).toBe(202);
    }
    expect((await store.listAppCommandRequestsForItem(items.approve.id, 50)).map((r) => r.command)).toEqual([
      "reject", "revise", "retry", "resolve", "budget", "verdict",
    ]);
  });

  it("merge is accepted with no note, and a 400 with one; a 403 without the token and a 404 for no item, as every command", async () => {
    const { d, store, items } = await setup();
    await refused(await post(d, items.merge.id, { command: "merge", note: "now" }), 400, "note");
    await refused(await post(d, items.merge.id, { command: "merge" }, { token: "wrong" }), 403, "token");
    await refused(await post(d, "wi_none", { command: "merge" }), 404, "item");
    await nothingWritten(store);
    const r = await post(d, items.merge.id, { command: "merge" });
    expect(r.status).toBe(202);
    const [row] = await store.listAppCommandRequestsForItem(items.merge.id, 50);
    expect(row).toMatchObject({ actor: ACTOR, command: "merge", args: { work_item_id: items.merge.id } });
  });

  it("reject or revise with no text is a 400 and writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const command of ["reject", "revise"]) {
      for (const note of [undefined, "", "   \n "]) {
        await refused(await post(d, items.approve.id, note === undefined ? { command } : { command, note }), 400, `${command} ${String(note)}`);
      }
    }
    await nothingWritten(store);
  });

  it("a POST to any other path is a JSON 405; every GET is unchanged", async () => {
    const { d, store, items } = await setup();
    const before = new Map<string, string>();
    for (const route of ROUTES) {
      const path = route.replace("ITEM", items.done.id);
      const r = await get(d, path);
      before.set(path, `${r.status} ${route.includes("ITEM") ? "" : r.body}`);
    }
    const id = encodeURIComponent(items.approve.id);
    for (const path of [
      `/api/v1/items/${id}`, `/api/v1/items/${id}/commands/x`, `/api/v1/items/${id}/commandsx`, "/api/v1/items//commands", "/api/v1/session",
      "/api/v1/overview", "/api/v1/nope", "/classic", "/", `/items/${id}`, "/app/", "/app/items/x", "/api/health",
    ]) {
      const r = await post(d, items.approve.id, { command: "approve" }, { path });
      await refused(r, 405, path);
      expect(r.headers.allow, path).toBe("GET, HEAD");
    }
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const r = await respond(d, { method, url: `/api/v1/items/${id}/commands`, host: HOST, origin: ORIGIN, contentType: "application/json", csrfToken: TOKEN, body: "{}" });
      expect(r.status, method).toBe(405);
    }
    await nothingWritten(store);
    for (const route of ROUTES) {
      const path = route.replace("ITEM", items.done.id);
      const r = await get(d, path);
      expect(`${r.status} ${route.includes("ITEM") ? "" : r.body}`, path).toBe(before.get(path));
    }
  });

  it("a body that is not JSON is a 400; an unknown item id is a 404; a body over 16 KB is a 413; each writes nothing", async () => {
    const { d, store, items } = await setup();
    for (const raw of ["not json", "", "{", "{'command':'approve'}"]) await refused(await post(d, items.approve.id, null, { raw }), 400, raw);
    for (const id of ["wi_nope", "%E0%A4%A"]) {
      await refused(await post(d, id, { command: "approve" }, { path: `/api/v1/items/${id}/commands` }), 404, id);
    }
    await refused(await post(d, items.approve.id, { command: "approve" }, { bodyTooLarge: true }), 413, "flag");
    const big = JSON.stringify({ command: "approve", note: "x".repeat(1000), pad: "y".repeat(16 * 1024) });
    await refused(await post(d, items.approve.id, null, { raw: big }), 413, "long body");
    await nothingWritten(store);
  });

  it("a note over 2000 characters on approve is a 400 and writes nothing; 2000 is accepted", async () => {
    const { d, store, items } = await setup();
    await refused(await post(d, items.approve.id, { command: "approve", note: "n".repeat(2001) }), 400, "2001");
    await nothingWritten(store);
    expect((await post(d, items.approve.id, { command: "approve", note: "n".repeat(2000) })).status).toBe(202);
  });

  it("GET /api/v1/session gives the token behind the Host guard; 404 when commands are not wired", async () => {
    const { d } = await setup();
    const s = await json<{ csrf_token: string; commands_enabled: boolean }>(d, "/api/v1/session");
    expect(s).toMatchObject({ csrf_token: TOKEN, commands_enabled: true, actor: ACTOR, actor_source: "config" });
    expect((await get(d, "/api/v1/session", { host: "evil.example" })).status).toBe(403);
    expect((await get(d, "/api/v1/session", { host: "evil.example" })).body).not.toContain(TOKEN);
    d.commands = { actor: null, source: null, token: TOKEN };
    expect((await json<{ commands_enabled: boolean }>(d, "/api/v1/session")).commands_enabled).toBe(false);
    const { commands: _, ...unwired } = d;
    expect((await get(unwired, "/api/v1/session")).status).toBe(404);
  });
});

describe("ui api: item commands and replies on GET /api/v1/items/:id (issue #227)", () => {
  type Detail = { commands: { name: string; usage: string; description: string; allowed: boolean; reason: string | null }[]; replies: Record<string, unknown>[] };

  it("commands are the footer table's commands for the item's state the page can send: never /help or /link", async () => {
    const { d, store, items } = await seeded();
    for (const it of Object.values(items)) {
      const cur = (await store.getWorkItem(it.id))!;
      const body = await json<Detail>(d, `/api/v1/items/${encodeURIComponent(it.id)}`);
      const want = commandsFor(commandState(cur)).filter((c) => c.name !== "help").map((c) => ({ name: c.name, usage: c.usage, description: c.description, allowed: true, reason: null }));
      expect(body.commands, it.id).toEqual(want);
      // Every listed command is one the commands route accepts, so no button can only be refused.
      for (const c of body.commands) expect(APP_COMMANDS, `${it.id} ${c.name}`).toContain(c.name);
    }
    const approve = await json<Detail>(d, `/api/v1/items/${encodeURIComponent(items.approve.id)}`);
    expect(approve.commands.map((c) => c.name)).toContain("approve");
    const done = await json<Detail>(d, `/api/v1/items/${encodeURIComponent(items.done.id)}`);
    expect(done.commands.map((c) => c.name)).not.toContain("approve");
  });

  it("replies are the item's stored requests with seq, command, times and the withheld refusal; the note is only in the thread", async () => {
    const { d, store, items, clock } = await seeded();
    const note = "private note text";
    const a = (await store.recordAppCommandRequest({ key: "a", actor: "github:7" as UserId, command: "approve", args: { work_item_id: items.approve.id, note } })).request;
    const b = (await store.recordAppCommandRequest({ key: "b", actor: "github:7" as UserId, command: "retry", args: { work_item_id: items.approve.id } })).request;
    await store.recordAppCommandRequest({ key: "c", actor: "github:7" as UserId, command: "approve", args: { work_item_id: items.merge.id } });
    clock.advance(1000);
    await store.markAppCommandRequest(b.seq, `\`retry\` was not applied: ${SECRET}.`);
    const r = await get(d, `/api/v1/items/${encodeURIComponent(items.approve.id)}`);
    expect(r.body).not.toContain(SECRET);
    const body = JSON.parse(r.body) as Detail & { thread: { kind: string; body: string }[] };
    expect(JSON.stringify(body.replies)).not.toContain(note);
    expect(body.thread.filter((e) => e.kind === "approve").map((e) => e.body)).toEqual([note]);
    expect(body.replies).toEqual([
      { seq: a.seq, command: "approve", created_at: a.created_at, handled_at: null, refusal: null },
      { seq: b.seq, command: "retry", created_at: b.created_at, handled_at: clock.now().toISOString(), refusal: "[withheld: github_token]" },
    ]);
    expect((await json<Detail>(d, `/api/v1/items/${encodeURIComponent(items.queued.id)}`)).replies).toEqual([]);
  });
});

describe("ui api: the waiting spec's In short and decisions on GET /api/v1/items/:id (issue #526)", () => {
  type Detail = { spec: { in_short: string; decisions: Record<string, unknown>[] } | null };
  const IN_SHORT = "AS-IS: nothing checks the scope.\nTO-BE: CI checks the scope.";
  const SPEC = {
    in_short: IN_SHORT, problem: "p", done_criteria: ["d"], desired_output: "o", in_scope: [], out_of_scope: [], allowed_paths: ["src/"],
    files_to_change: [], tier: 2, tier_reason: "r", estimated_lines: 10, estimated_files: 1,
    decisions: [
      { question: "Fail the job, or only warn?", reason: `It blocks merges ${SECRET}`, options: ["Fail the job", "Only warn"], default: "Only warn", owner_only: false },
      { question: "Name the step?", reason: "It shows in CI.", options: [], default: "scope", owner_only: true },
    ],
  };

  /** An item whose triage run wrote `spec`, applied (acknowledged) with `patch`. */
  async function triaged(store: FactoryStore, n: number, spec: object, p: Parameters<FactoryStore["transition"]>[0]["patch"]) {
    const it = await make(store, n, `Item ${n}`);
    await enqueue(store, it, "triage", `t:${n}`);
    // The seeded store has other triage runs queued: claim until this item's.
    let run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
    while (run.work_item_id !== it.id) run = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
    await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { spec } });
    const cur = (await store.getWorkItem(it.id))!;
    const r = await store.transition({ id: it.id, expected_version: cur.version, patch: p, actor: system, reason: "triaged", ack_run: run.id });
    if (!r.ok) throw new Error(r.reason);
    return it;
  }

  it("returns in_short and each decision's question, options, default, reason and owner_only, every text through the Withholder", async () => {
    const { d, store } = await seeded();
    const it = await triaged(store, 50, SPEC, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    const r = await get(d, `/api/v1/items/${encodeURIComponent(it.id)}`);
    expect(r.body).not.toContain(SECRET);
    expect((JSON.parse(r.body) as Detail).spec).toEqual({
      in_short: IN_SHORT,
      decisions: [
        { question: "Fail the job, or only warn?", options: ["Fail the job", "Only warn"], default: "Only warn", reason: "[withheld: github_token]", owner_only: false },
        { question: "Name the step?", options: [], default: "scope", reason: "It shows in CI.", owner_only: true },
      ],
    });
  });

  it("a stored plain-text decision from an older triage is a question with no options, default or reason", async () => {
    const { d, store } = await seeded();
    const it = await triaged(store, 51, { ...SPEC, decisions: ["Ship behind a flag?"] }, { stage: "READY", blocked_on: "human", blocked_reason: "max_revisions" });
    const body = await json<Detail>(d, `/api/v1/items/${encodeURIComponent(it.id)}`);
    expect(body.spec!.decisions).toEqual([{ question: "Ship behind a flag?", options: [], default: null, reason: null, owner_only: true }]);
  });

  it("is null for an item whose spec is not waiting for approval, or with no applied triage run", async () => {
    const { d, store, items } = await seeded();
    const it = await triaged(store, 52, SPEC, { stage: "RUNNING" });
    expect((await json<Detail>(d, `/api/v1/items/${encodeURIComponent(it.id)}`)).spec).toBeNull();
    expect((await json<Detail>(d, `/api/v1/items/${encodeURIComponent(items.approve.id)}`)).spec).toBeNull();
  });
});

describe("ui api: the merge field on /api/v1/items and /api/v1/items/:id (the Merge button)", () => {
  const TOKEN = newCsrfToken();
  const ACTOR = "local:me" as UserId;
  const MERGE_PENDING = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" } as const;
  type Merge = { enabled: boolean; reason: string | null };

  async function localItem(store: FactoryStore, n: number) {
    return (await store.createWorkItem({ ...issue(n), source: { type: "local", id: `local-${n}`, link: `local:local-${n}` } }, system)).item;
  }
  /** The item's `merge` on its page and on its list row: always the same. */
  const mergeOf = async (d: UiDeps, id: WorkItemId): Promise<Merge> => {
    const page = (await json<{ item: { merge: Merge } }>(d, `/api/v1/items/${encodeURIComponent(id)}`)).item.merge;
    const row = (await json<{ items: { id: string; merge: Merge }[] }>(d, "/api/v1/items?closed=1")).items.find((i) => i.id === id);
    if (row) expect(row.merge, id).toEqual(page);
    return page;
  };
  const enabled = { enabled: true, reason: null };
  const off = (reason: string) => ({ enabled: false, reason });

  it("enabled for a GitHub PR or a local item waiting for its merge, for a user allowed approve_merge", async () => {
    const { d, store, items } = await seeded();
    const asked = vi.fn(async (_action: PageAction): Promise<AuthDecision> => ({ allow: true }));
    d.commands = { actor: ACTOR, source: "config", token: TOKEN, allowed: asked };
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: "a".repeat(40), base_sha: "b".repeat(40) });
    const local = await patch(store, await localItem(store, 40), MERGE_PENDING);

    expect(await mergeOf(d, items.merge.id)).toEqual(enabled);
    expect(await mergeOf(d, local.id)).toEqual(enabled);
    // A list asks each grant at most once, however many rows it has.
    asked.mockClear();
    await json(d, "/api/v1/items?closed=1");
    const actions = asked.mock.calls.map(([a]) => a);
    expect(actions).toContain("approve_merge");
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("disabled with a reason: not waiting, merge check running, conflicts, no forge, no sandbox, commands off, not allowed", async () => {
    const { d, store, items } = await seeded();
    let allowed = true;
    d.commands = { actor: ACTOR, source: "config", token: TOKEN, allowed: async () => (allowed ? { allow: true } : { allow: false, reason: "no_role" }) };
    const local = await patch(store, await localItem(store, 40), MERGE_PENDING);

    for (const it of [items.approve, items.done, items.running]) expect(await mergeOf(d, it.id), it.id).toEqual(off("not waiting for a merge"));
    // No stored merge check result for the PR's head yet.
    expect(await mergeOf(d, items.merge.id)).toEqual(off("merge check running"));
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: false, conflicts: ["a.ts", "b.ts"], head_sha: "a".repeat(40), base_sha: "b".repeat(40) });
    expect(await mergeOf(d, items.merge.id)).toEqual(off("2 conflicting files"));
    // A local item has no merge check: its own merge refuses a conflict.
    expect(await mergeOf(d, local.id)).toEqual(enabled);

    d.commands = { ...d.commands, forge: false, localMerge: false };
    expect(await mergeOf(d, items.merge.id)).toEqual(off("no forge selected"));
    expect(await mergeOf(d, local.id)).toEqual(off("no sandbox that can merge"));
    d.commands = { ...d.commands, forge: true, localMerge: true };

    allowed = false;
    expect(await mergeOf(d, local.id)).toEqual(off("not allowed to merge (approve_merge)"));
    d.commands = { actor: ACTOR, source: "config", token: TOKEN };
    expect(await mergeOf(d, local.id)).toEqual(off("not allowed to merge (approve_merge)"));
    d.commands = { actor: null, source: null, token: TOKEN, allowed: async () => ({ allow: true }) };
    expect(await mergeOf(d, local.id)).toEqual(off("commands are off"));
    const { commands: _, ...unwired } = d;
    expect(await mergeOf(unwired, local.id)).toEqual(off("commands are off"));
  });

  it("a local item that already has a PR merges through its PR: it needs a forge, not a sandbox that can merge", async () => {
    const { d, store } = await seeded();
    d.commands = { actor: ACTOR, source: "config", token: TOKEN, allowed: async () => ({ allow: true }), forge: true, localMerge: false };
    const withPr = await patch(store, await localItem(store, 41), { ...MERGE_PENDING, change_ref: "77" });
    await store.recordMergeCheck({ work_item_id: withPr.id, mergeable: true, conflicts: [], head_sha: "a".repeat(40), base_sha: "b".repeat(40) });

    expect(await mergeOf(d, withPr.id)).toEqual(enabled);
    d.commands = { ...d.commands, forge: false, localMerge: true };
    expect(await mergeOf(d, withPr.id)).toEqual(off("no forge selected"));
  });
});

describe("ui api: local merge check (issue #248)", () => {
  type Check = { state: string; conflicts: string[]; head_sha: string | null; base_sha: string | null; checked_at: string | null } | null;
  type Row = { id: string; merge_check: Check };
  const HEAD = "a".repeat(40);
  const BASE = "b".repeat(40);

  it("a ready-to-merge item with no result is checking; other items have no merge check", async () => {
    const { d, items } = await seeded();
    const list = (await json<{ items: Row[] }>(d, "/api/v1/items")).items;
    expect(list.find((i) => i.id === items.merge.id)!.merge_check).toEqual({ state: "checking", conflicts: [], head_sha: null, base_sha: null, checked_at: null });
    expect(list.find((i) => i.id === items.approve.id)!.merge_check).toBeNull();
    expect((await json<{ item: Row }>(d, `/api/v1/items/${items.approve.id}`)).item.merge_check).toBeNull();
  });

  it("returns the stored result on the list and the item page, file names through the Withholder", async () => {
    const { d, store, clock, items } = await seeded();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: false, conflicts: ["src/a.ts", `leak-${SECRET}.txt`], head_sha: HEAD, base_sha: BASE });
    const want = { state: "conflicts", conflicts: ["src/a.ts", "[withheld: github_token]"], head_sha: HEAD, base_sha: BASE, checked_at: clock.now().toISOString() };
    const list = (await json<{ items: Row[] }>(d, "/api/v1/items")).items;
    expect(list.find((i) => i.id === items.merge.id)!.merge_check).toEqual(want);
    expect((await json<{ item: Row }>(d, `/api/v1/items/${items.merge.id}`)).item.merge_check).toEqual(want);
    expect(JSON.stringify(await json(d, "/api/v1/items"))).not.toContain(SECRET);
  });

  it("a clean result is mergeable; a result for an older head than the recorded one is checking", async () => {
    const { d, store, items } = await seeded();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: HEAD, base_sha: BASE });
    const row = async () => (await json<{ items: Row[] }>(d, "/api/v1/items")).items.find((i) => i.id === items.merge.id)!.merge_check!;
    expect((await row()).state).toBe("mergeable");
    await store.recordPrHead({ id: items.merge.id, expected_head: null, head_sha: "c".repeat(40), manual: null });
    expect((await row()).state).toBe("checking");
  });

  it("reads the result with store read methods only", async () => {
    const calls: string[] = [];
    const spy = (s: FactoryStore): FactoryStore =>
      new Proxy(s, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver) as unknown;
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            calls.push(String(prop));
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const { d, items } = await seeded({ store: spy });
    calls.length = 0;
    await json(d, "/api/v1/items");
    await json(d, `/api/v1/items/${items.merge.id}`);
    expect(calls).toContain("listMergeChecks");
    expect(calls).toContain("getMergeCheck");
    expect(calls.filter((n) => !/^(get|list|count)[A-Z]/.test(n))).toEqual([]);
  });
});

describe("ui api: unreviewed merges", () => {
  type Merge = { project: string; change_ref: string; change_url: string | null; merge_sha: string; merged_by: string; recorded_at: string };
  const list = async (d: UiDeps, q = "") => (await json<{ merges: Merge[] }>(d, `/api/v1/unreviewed-merges${q}`)).merges;
  const rec = (store: FactoryStore, n: number, merger: string | null = null, sha = `${n}`.repeat(40)) =>
    store.recordUnreviewedMerge({ project: PROJECT_KEY, change_ref: String(n), merge_sha: sha, merger_id: merger as UserId | null });

  it("lists rows newest first with the label, a short sha and the merger id, never the project key", async () => {
    const { d, store, clock } = await seeded();
    await saveProjectLabel(store, { key: PROJECT_KEY, label: "github.com/o/r" });
    await rec(store, 1, "github:7");
    clock.advance(1000);
    await rec(store, 2, null);
    const gh = { ...d, plugins: { issues: "github" } } as UiDeps;
    const rows = await list(gh);
    expect(rows.map((r) => r.change_ref)).toEqual(["2", "1"]);
    expect(rows[1]).toMatchObject({ project: "github.com/o/r", merge_sha: "1111111", merged_by: "github:7", change_url: null });
    expect(rows[0]!.merged_by).toBe("unknown");
    expect(typeof rows[0]!.recorded_at).toBe("string");
    expect(JSON.stringify(rows)).not.toContain(PROJECT_KEY);
  });

  it("limit: default 50, at most 200, and a bad value is a 400", async () => {
    const { d, store } = await seeded();
    for (let n = 1; n <= 205; n++) await rec(store, n);
    expect(await list(d)).toHaveLength(50);
    expect(await list(d, "?limit=3")).toHaveLength(3);
    expect(await list(d, "?limit=1000")).toHaveLength(200);
    for (const bad of ["0", "-1", "x"]) expect((await get(d, `/api/v1/unreviewed-merges?limit=${bad}`)).status).toBe(400);
  });

  it("no PR link: the store keeps none for an unreviewed merge, so the ref is text, with or without plugin and label", async () => {
    const { d, store } = await seeded();
    await rec(store, 1);
    await saveProjectLabel(store, { key: PROJECT_KEY, label: "github.com/o/r" });
    for (const deps of [d, { ...d, plugins: { issues: "github" } } as UiDeps, { ...d, plugins: { issues: null } } as UiDeps]) {
      const [row] = await list(deps);
      expect(row).toMatchObject({ change_ref: "1", change_url: null });
      expect(Object.keys(row!)).not.toContain("pr_number");
    }
  });

  it("strings from the store go through the Withholder", async () => {
    const { d, store } = await seeded();
    await rec(store, 1, `github:${SECRET}`, SECRET);
    const r = await get(d, "/api/v1/unreviewed-merges");
    expect(r.body).not.toContain(SECRET);
    expect((await list(d))[0]).toMatchObject({ merged_by: "[withheld: github_token]", merge_sha: "[withheld: github_token]" });
  });

  it("overview counts the rows recorded in the last 7 days", async () => {
    const { d, store, clock } = await seeded();
    const count = async () => (await json<{ unreviewed_merges_7d: number }>(d, "/api/v1/overview")).unreviewed_merges_7d;
    expect(await count()).toBe(0);
    await rec(store, 1);
    clock.advance(8 * 24 * 3600_000);
    await rec(store, 2);
    expect(await count()).toBe(1);
  });
});

describe("ui api: why an item waits (issue #310)", () => {
  type WhyBody = { code: string; text: string; next_actor: string; refs: number[]; ref_url: string | null };
  type Decision = Awaited<ReturnType<FactoryStore["listClaimDecisions"]>>[number];
  /** The seeded store, with the claim decisions the test sets (only the claim writes real ones). */
  async function withDecisions() {
    const decisions = new Map<string, Decision[]>();
    const s = await seeded({
      store: (store) =>
        new Proxy(store, {
          get(target, prop, receiver) {
            if (prop === "listClaimDecisions") return async (id: WorkItemId) => decisions.get(id) ?? [];
            if (prop === "listLatestClaimDecisions") {
              return async (ids: readonly WorkItemId[]) => new Map(ids.flatMap((id) => decisions.get(id)?.slice(-1).map((x) => [id, x] as const) ?? []));
            }
            const v = Reflect.get(target, prop, receiver) as unknown;
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        }),
    });
    const decide = (item: WorkItem, run_id: string, decision: Decision["decision"], holder_kind: Decision["holder_kind"] = "pr") =>
      decisions.set(item.id, [{
        run_id, work_item_id: item.id, decision, holder_work_item_id: null, holder_ref: "#92", holder_kind,
        shared: [], cost: 4, threshold: 2.5, fallback: false, approved_by: null, at: s.clock.now().toISOString(),
      } as unknown as Decision]);
    return { ...s, decide };
  }
  const whyOn = async (d: UiDeps, id: string) => {
    const list = await json<{ items: { id: string; level: string; badges: string[]; why: WhyBody }[] }>(d, "/api/v1/items");
    const queue = await json<{ queue: { work_item_id: string; why: WhyBody | null }[] }>(d, "/api/v1/queue");
    const item = await json<{ item: { why: WhyBody } }>(d, `/api/v1/items/${encodeURIComponent(id)}`);
    return { row: list.items.find((i) => i.id === id)!, queued: queue.queue.find((q) => q.work_item_id === id) ?? null, item: item.item.why };
  };

  it("a held run reads 'Held behind #N' with its holder on Items, the item page and the Queue's why", async () => {
    const { d, store, decide } = await withDecisions();
    const held = await make(store, 20, "Held item");
    await enqueue(store, held, "implement", "held:i", { stage: "RUNNING" });
    const run = (await store.listRuns(held.id)).find((r) => r.kind === "implement")!;
    decide(held, run.id, "held", "pr");
    const w = await whyOn(d, held.id);
    const expected = { code: "held", text: "Held behind #92, which has an open PR", next_actor: "other_item", refs: [92], ref_url: "https://github.com/o/r/issues/" };
    expect(w.row.level).toBe("blocked_by_task");
    expect(w.row.badges).toEqual(["waits on #92"]);
    expect(w.row.why).toEqual(expected);
    expect(w.queued!.why).toEqual(expected);
    expect(w.item).toEqual(expected);
  });

  it("a dependency blocker waits (not queued) and reads the same sentence on Items, Queue and the item page", async () => {
    const { d, store } = await withDecisions();
    const dep = await make(store, 21, "Dependent item");
    await enqueue(store, dep, "implement", "dep:i", { stage: "RUNNING", blocked_on: "dependency", blocked_reason: "waiting for #12 and #13 to merge" });
    const w = await whyOn(d, dep.id);
    expect(w.row.level).toBe("blocked_by_task");
    for (const why of [w.row.why, w.queued!.why!, w.item]) {
      expect(why).toMatchObject({ code: "dependency", text: "Waiting for #12 and #13 to merge", next_actor: "other_item", refs: [12, 13] });
    }
  });

  it("an ordinary queued run reads its queue position, the same on Items and the Queue", async () => {
    const { d, items } = await withDecisions();
    const w = await whyOn(d, items.queued2.id);
    expect(w.queued!.why).toMatchObject({ code: "queued", text: "Queued at position 2" });
    expect(w.row.why.text).toBe(w.queued!.why!.text);
    expect(w.item.text).toBe(w.queued!.why!.text);
  });

  it("a claim pause names itself on a run its kind stops, by the claim rule", async () => {
    const { d, store, clock, items } = await withDecisions();
    await store.pauseClaims(new Date(clock.now().getTime() + 3_600_000).toISOString() as Timestamp, "forge_auth");
    const dep = await make(store, 22, "Implement waits");
    await enqueue(store, dep, "implement", "p:i", { stage: "RUNNING" });
    expect((await whyOn(d, dep.id)).queued!.why).toMatchObject({ code: "paused", next_actor: "human" });
    // A triage run is not stopped by a forge pause.
    expect((await whyOn(d, items.queued.id)).queued!.why).toMatchObject({ code: "queued" });
  });

  it("a deadlock claim decision puts its item in Blocked by another task, naming the holder, and out of Needs you and needs_you", async () => {
    const { d, store, items, claimed, decide } = await withDecisions();
    const before = (await json<{ needs_you: number }>(d, "/api/v1/overview")).needs_you;
    decide(items.running, claimed.id, "deadlock", "waiting");
    // The seeded run's heartbeat is stale (stuck); a fresh one is running.
    await store.heartbeat(claimed.id, claimed.lease!.token, LEASE);
    const o = await json<{ needs_you: number; system_actions: { code: string }[] }>(d, "/api/v1/overview");
    expect(o.needs_you).toBe(before);
    expect(o.system_actions.map((a) => a.code)).not.toContain("claim_deadlock");
    const w = await whyOn(d, items.running.id);
    expect(w.row.level).toBe("blocked_by_task");
    expect(w.row.badges).toEqual(["deadlock with #92"]);
    const why = { code: "deadlock", text: "Started past a deadlock with #92: a person checks the overlap", next_actor: "factory", refs: [92] };
    expect(w.row.why).toMatchObject(why);
    expect(w.item).toMatchObject(why);
    const needs = await json<{ items: { id: string }[] }>(d, "/api/v1/items?state=needs");
    expect(needs.items.map((i) => i.id)).not.toContain(items.running.id);
  });

  it("a merge conflict the resolve run gives up on still needs you", async () => {
    const { d, store, items } = await withDecisions();
    await patch(store, items.running, { blocked_on: "human", blocked_reason: "merge_conflict_pending" });
    expect((await whyOn(d, items.running.id)).row.level).toBe("needs_you");
  });

  it("free text in why passes the Withholder", async () => {
    const { d, items } = await withDecisions();
    const w = await whyOn(d, items.secretive.id);
    expect(w.row.why.text).toBe("[withheld: github_token]");
    expect(w.item.text).toBe("[withheld: github_token]");
  });
});

describe("ui api: the server's revision and the app's (issue #311)", () => {
  it("the overview returns the server's revision; the web build has the checkout's HEAD built in through Vite define, the one the build stamps", async () => {
    const root = new URL("..", import.meta.url).pathname;
    const server = await checkoutRevision(root);
    expect(server).toMatch(/^[0-9a-f]{40}$/);
    const define = (viteConfig as { define?: Record<string, string> }).define ?? {};
    expect(JSON.parse(define.__FACTORY_REV__ ?? "null")).toBe(server);

    const { d } = await seeded();
    const withRev: ApiDeps = { ...d, revision: server };
    expect((await json<{ server_rev: string | null }>(withRev, "/api/v1/overview")).server_rev).toBe(server);
    // Without a revision (a test, a checkout without git) it is null, never the supervisor's.
    expect((await json<{ server_rev: string | null }>(d, "/api/v1/overview")).server_rev).toBeNull();
  });
});

describe("ui api: pauses and Needs-you reasons (issue: floor banner)", () => {
  type Pause = { name: string; ends_at: string; since?: string | null };
  const pausesOf = async (d: UiDeps) => (await json<{ pauses: Pause[] }>(d, "/api/v1/pauses")).pauses;
  const at = (clock: FakeClock, ms: number) => new Date(clock.now().getTime() + ms).toISOString() as Timestamp;

  it("returns each active pause with its end time and a model stall's start; an ended pause is not returned", async () => {
    const { d, store, clock } = await seeded();
    expect(await pausesOf(d)).toEqual([]);
    const began = clock.now().toISOString();
    await store.pauseClaims(at(clock, 60_000), "model_stall");
    await store.pauseClaims(at(clock, 120_000), "rate_limit");
    await store.pauseClaims(at(clock, 30_000), "forge_auth");
    const list = await pausesOf(d);
    expect(list.map((p) => p.name).sort()).toEqual(["forge_auth", "model_stall", "rate_limit"]);
    expect(list.find((p) => p.name === "model_stall")).toMatchObject({ ends_at: at(clock, 60_000), since: began });
    expect(list.find((p) => p.name === "rate_limit")).toEqual({ name: "rate_limit", ends_at: at(clock, 120_000) });
    clock.advance(45_000);
    expect((await pausesOf(d)).map((p) => p.name).sort()).toEqual(["model_stall", "rate_limit"]);
    // A model stall whose probe is due stays until a probe answers.
    clock.advance(200_000);
    const due = await pausesOf(d);
    expect(due.map((p) => p.name)).toEqual(["model_stall"]);
    expect(due[0]!.ends_at < clock.now().toISOString()).toBe(true);
  });

  type NeedRow = { id: string; level: string; need?: { reason: string }; commands?: { name: string; allowed: boolean; reason: string | null }[] };
  const LABELS: Record<string, string> = { ready_to_merge: "Ready to merge", needs_approval: "Needs approval", needs_you: "Needs you", needs_triage: "Needs triage" };

  it("each Needs-you reason is its own words, never the State label, and names what to do", async () => {
    const { d, store, items } = await seeded();
    const more: Record<string, WorkItem> = {};
    for (const [n, reason] of [[20, "run_failed:implement:diff_too_large"], [21, "max_loops"], [22, "merge_conflict_pending"], [23, "something_new"], [24, "rule_of_two"], [25, "dependency_closed:#92"], [26, null]] as const) {
      more[String(reason)] = await make(store, n, `Item ${n}`);
      await patch(store, more[String(reason)]!, { blocked_on: "human", blocked_reason: reason });
    }
    const rows = (await json<{ items: NeedRow[] }>(d, "/api/v1/items?state=needs")).items;
    const need = (id: string) => rows.find((r) => r.id === id)!.need!;
    expect(need(more["run_failed:implement:diff_too_large"]!.id).reason).toBe("failed: diff_too_large");
    const commands = (id: string) => rows.find((r) => r.id === id)!.commands!.map((c) => c.name);
    expect(commands(items.approve.id)).toEqual(["approve", "reject", "revise"]);
    expect(need(items.merge.id).reason).toBe("merge check running");
    expect(need(more["null"]!.id).reason).toBe("waiting for a person");
    for (const r of rows) {
      expect(r.need, r.id).toBeDefined();
      expect(r.need!.reason.toLowerCase(), r.id).not.toBe(LABELS[r.level]!.toLowerCase());
      expect(r.need!.reason.trim(), r.id).not.toBe("");
      expect(r.need!.reason, r.id).not.toContain("no reason");
    }
    expect(rows.filter((r) => r.need!.reason === "failed: diff_too_large")).toHaveLength(1);
  });

  it("a ready-to-merge row shows the merge check: mergeable, or the conflict count", async () => {
    const { d, store, items } = await seeded();
    const row = async () => (await json<{ items: NeedRow[] }>(d, "/api/v1/items")).items.find((i) => i.id === items.merge.id)!.need!;
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: "a".repeat(40), base_sha: "b".repeat(40) });
    expect((await row()).reason).toBe("mergeable");
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: false, conflicts: ["a.ts", "b.ts"], head_sha: "a".repeat(40), base_sha: "b".repeat(40) });
    expect((await row()).reason).toBe("2 conflicting files");
  });

  it("a row that does not wait for you has no need and no commands", async () => {
    const { d, items } = await seeded();
    const rows = (await json<{ items: NeedRow[] }>(d, "/api/v1/items")).items;
    expect(rows.find((r) => r.id === items.running.id)!.need).toBeUndefined();
    expect(rows.find((r) => r.id === items.running.id)!.commands).toBeUndefined();
  });

  it("a row's commands are the state-changing ones that apply, never budget, then verdict where it applies, each with the viewer's allowed and reason (issues #453, #513)", async () => {
    const { d, store, items } = await seeded();
    const failed = await make(store, 20, "Failed");
    await patch(store, failed, { stage: "RUNNING", blocked_on: "human", blocked_reason: "run_failed:implement:agent_error" });
    const checkpoint = await make(store, 21, "At a checkpoint");
    await patch(store, checkpoint, { stage: "RUNNING", blocked_on: "human", blocked_reason: "budget_checkpoint" });
    const ACTOR = "local:me" as UserId;
    let grant: AuthDecision = { allow: true };
    const asked = vi.fn(async (_action: PageAction) => grant);
    d.commands = { actor: ACTOR, source: "config", token: newCsrfToken(), allowed: asked };
    const rows = async () => (await json<{ items: NeedRow[] }>(d, "/api/v1/items?state=needs")).items;
    const of = (all: NeedRow[], id: string) => all.find((r) => r.id === id)!.commands!;

    let all = await rows();
    expect(of(all, items.approve.id)).toEqual(["approve", "reject", "revise"].map((name) => ({ name, usage: expect.any(String), description: expect.any(String), allowed: true, reason: null })));
    expect(of(all, failed.id).map((c) => c.name)).toEqual(["reject", "revise", "retry"]);
    expect(of(all, checkpoint.id).map((c) => c.name)).toEqual(["reject"]);
    // Waiting for its merge, with a PR: reject (any open phase), then verdict, which changes no state but has its own form in the row.
    expect(of(all, items.merge.id).map((c) => c.name)).toEqual(["reject", "verdict"]);
    // approve_spec asked once for the whole list, approve_merge at most once.
    expect(asked.mock.calls.filter(([a]) => a === "approve_spec")).toHaveLength(1);
    expect(asked.mock.calls.filter(([a]) => a === "approve_merge").length).toBeLessThanOrEqual(1);

    grant = { allow: false, reason: "no_role" };
    all = await rows();
    for (const c of of(all, items.approve.id)) {
      expect(c).toMatchObject({ allowed: false, reason: "only the owner may send this command (`no_role`)" });
    }
  });

  it("the overview, items and pauses reads make no forge or other remote call: store reads only", async () => {
    const calls: string[] = [];
    const spy = (s: FactoryStore): FactoryStore =>
      new Proxy(s, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver) as unknown;
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            calls.push(String(prop));
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const forge = { calls: 0 };
    const { d, store, clock } = await seeded({ store: spy });
    // A forge stub in the deps: nothing in the UI may reach it.
    const withForge = { ...d, forge: new Proxy({}, { get: () => { forge.calls++; } }) } as UiDeps;
    await store.pauseClaims(at(clock, 60_000), "model_stall");
    calls.length = 0;
    for (const path of ["/api/v1/overview", "/api/v1/items?state=needs", "/api/v1/pauses"]) await json(withForge, path);
    expect(forge.calls).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((n) => !/^(get|list|count|schemaVersion)/.test(n))).toEqual([]);
  });
});

describe("ui api: GitHub budget (design §5 Sources, GitHub call budget)", () => {
  const stored = (clock: FakeClock, over: Record<string, unknown> = {}) => JSON.stringify({
    limit: 5000, remaining: 0, reset_at: new Date(clock.now().getTime() + 600_000).toISOString(), budget_share: 0.5,
    share_limit: 2500, counted: 1234, state: "waiting", as_of: clock.now().toISOString(), replica_id: "host:1", ...over,
  });

  it("the overview shows remaining calls, the reset time, this factory's count and, at 0, a wait with the reset as its reason", async () => {
    const { d, store, clock } = await seeded();
    expect((await json<{ github_budget: unknown }>(d, "/api/v1/overview")).github_budget).toBeNull();
    const reset_at = new Date(clock.now().getTime() + 600_000).toISOString();
    await store.advanceCursor("github:budget", null, stored(clock));
    const o = await json<{ github_budget: Record<string, unknown>; system_actions: unknown[] }>(d, "/api/v1/overview");
    expect(o.github_budget).toMatchObject({
      limit: 5000, remaining: 0, reset_at, budget_share: 0.5, share_limit: 2500, counted: 1234, replica_id: "host:1",
      state: "waiting", wait_reason: `waiting for the GitHub rate-limit reset at ${reset_at}`,
    });
    // A wait, not an error: nothing for the operator to do.
    expect(JSON.stringify(o.system_actions)).not.toContain("rate-limit");
    const html = (await get(d, "/classic")).body;
    expect(sectionOf(html, "github-budget")).toContain(`waiting for the GitHub rate-limit reset at ${reset_at}`);
    expect(sectionOf(html, "github-budget")).toContain("this factory counted 1234 of 2500");
  });

  it("once the stored reset has passed, the window is over: no wait and a count of 0", async () => {
    const { d, store, clock } = await seeded();
    await store.advanceCursor("github:budget", null, stored(clock));
    clock.advance(600_000);
    const o = await json<{ github_budget: Record<string, unknown> }>(d, "/api/v1/overview");
    expect(o.github_budget).toMatchObject({ state: "ok", counted: 0, wait_reason: null });
  });
});

describe("ui api: items for the tree (issue #295)", () => {
  type Row = {
    id: string; parent_id: string | null; phase: number | null; title: string | null; change_url: string | null;
    run: { kind: string; status: string; attempt: number; worker_id: string | null; started_at: string | null; position: number | null } | null;
    claim: { decision: string; holder: string | null; holder_id: string | null; approved: boolean; cost: number; threshold: number } | null;
  };
  const rowsOf = async (d: UiDeps) => new Map((await json<{ items: Row[] }>(d, "/api/v1/items")).items.map((r) => [r.id, r]));

  it("each row has parent_id and phase, and its run with the worker (through the Withholder), start and queue position", async () => {
    const { d, store, items, claimed, claimed2 } = await seeded();
    const parent = await make(store, 50, "Split parent");
    const phase = (await store.createWorkItem({ ...issue(51), title: "Phase", parent: { id: parent.id, phase: 2 } }, system)).item;
    const rows = await rowsOf(d);
    expect(rows.get(parent.id)).toMatchObject({ parent_id: null, phase: null, run: null, claim: null });
    expect(rows.get(phase.id)).toMatchObject({ parent_id: parent.id, phase: 2 });
    expect(rows.get(items.running.id)!.run).toEqual({
      kind: "implement", status: "running", attempt: claimed.attempt, worker_id: "host:11:1", started_at: claimed.started_at, position: null,
    });
    expect(rows.get(items.running2.id)!.run!.worker_id).toBe("[withheld: github_token]");
    expect(rows.get(items.queued.id)!.run).toMatchObject({ kind: "triage", status: "queued", worker_id: null, started_at: null, position: 1 });
    expect(rows.get(items.queued2.id)!.run!.position).toBe(2);
    expect(rows.get(items.approve.id)!.run).toBeNull();
    void claimed2;
  });

  it("a held run carries the latest claim decision: holder, cost and threshold, from one batched read", async () => {
    const { d, store, clock } = await seeded();
    const PATHS = { files_to_change: ["src/worker/runner.ts"], allowed_paths: ["src/worker/"] };
    const a = await make(store, 60, "Holder");
    await enqueue(store, a, "implement", "h:a", { stage: "RUNNING", ...PATHS });
    clock.advance(1_000);
    const b = await make(store, 61, "Held");
    await enqueue(store, b, "implement", "h:b", { stage: "RUNNING", ...PATHS });
    const first = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
    expect(first.work_item_id).toBe(a.id);
    expect(await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE })).toBeNull();
    expect(await store.listLatestClaimDecisions([])).toEqual(new Map());
    const batched = vi.spyOn(store, "listLatestClaimDecisions");
    const rows = await rowsOf(d);
    expect(rows.get(b.id)!.claim).toEqual({ decision: "held", holder: "#60", holder_id: a.id, approved: false, cost: 3, threshold: 2.5 });
    expect([...rows.values()].filter((r) => r.claim === null).length).toBeGreaterThan(0);
    expect(batched).toHaveBeenCalledTimes(1);
  });

  it("claim reads one batch and no per-item decisions, and a stale hold from an earlier run is left out", async () => {
    const { d, store, clock } = await seeded();
    const PATHS = { files_to_change: ["src/worker/runner.ts"], allowed_paths: ["src/worker/"] };
    const a = await make(store, 70, "Holder");
    await enqueue(store, a, "implement", "h:a", { stage: "RUNNING", ...PATHS });
    clock.advance(1_000);
    const b = await make(store, 71, "Held");
    await enqueue(store, b, "implement", "h:b", { stage: "RUNNING", ...PATHS });
    const first = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
    expect(await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE })).toBeNull();
    // The held run ends after the holder finishes; a new implement run (a fix) is queued for b.
    await store.completeRun(first.id, first.lease!.token, { status: "succeeded", summary: "ok", data: {} });
    const held = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
    expect(held.work_item_id).toBe(b.id);
    await store.completeRun(held.id, held.lease!.token, { status: "failed", error_code: "agent_error", detail: "x", infra: false });
    await enqueue(store, b, "implement", "h:b2");
    expect((await store.listLatestClaimDecisions([b.id])).get(b.id)).toBeDefined();
    const perItem = vi.spyOn(store, "listClaimDecisions");
    const batched = vi.spyOn(store, "listLatestClaimDecisions");
    const rows = await rowsOf(d);
    expect(rows.get(b.id)!.run).toMatchObject({ kind: "implement", status: "queued" });
    expect(rows.get(b.id)!.claim).toBeNull();
    expect(perItem).not.toHaveBeenCalled();
    expect(batched).toHaveBeenCalledTimes(1);
  });
});

describe("ui api: open alarms in Needs you and the why sentence (design 09-status-page)", () => {
  const ALARM = "Alarm: checks_failed failed 4 runs on several items";
  type WhyBody = { text: string };
  type Action = { code: string; text: string; command: string; until: string | null; work_item_id: string | null };

  /** An item whose run failed with checks_failed (blocked on a person), one with no runs, and an open alarm. */
  async function alarmed() {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const hit = await make(store, 1, "Failing item");
    await enqueue(store, hit, "implement", "hit:i", { stage: "RUNNING" });
    const r = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
    await store.completeRun(r.id, r.lease!.token, { status: "failed", error_code: "checks_failed", detail: "npm test exited 1", infra: false });
    await patch(store, hit, { blocked_on: "human", blocked_reason: "run_failed:implement:checks_failed" });
    const other = await make(store, 2, "Other item");
    await store.recordAlert({ pattern: "repeated_error", pattern_key: "repeated_error:x", error_code: "checks_failed", count: 4, detail: "npm test exited #" }, ALERT_DEDUPE_MS);
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: LEASE, health: new HealthMonitor(async () => [], clock) };
    return { d, store, clock, hit, other };
  }
  const overview = (d: UiDeps) => json<{ needs_you: number; system_actions: Action[] }>(d, "/api/v1/overview");
  const whyRow = async (d: UiDeps, id: string) => (await json<{ items: { id: string; why: WhyBody }[] }>(d, "/api/v1/items")).items.find((i) => i.id === id)!.why.text;
  const whyItem = async (d: UiDeps, id: string) => (await json<{ item: { why: WhyBody } }>(d, `/api/v1/items/${encodeURIComponent(id)}`)).item.why.text;

  it("the overview lists an open alarm in Needs you with where to look and when it closes, and drops it once resolved", async () => {
    const { d, clock } = await alarmed();
    const created = clock.now().getTime();
    const o = await overview(d);
    expect(o.system_actions).toContainEqual({
      code: "alarm", text: `${ALARM}: npm test exited #`, command: "Failures page (/app/failures)", until: new Date(created + ALERT_DEDUPE_MS).toISOString(),
    });
    expect(o.needs_you).toBe(1 + o.system_actions.length);
    clock.advance(ALERT_DEDUPE_MS);
    const after = await overview(d);
    expect(after.system_actions.map((a) => a.code)).not.toContain("alarm");
    expect(after.needs_you).toBe(o.needs_you - 1);
  });

  it("an alarm whose detail the scanner flagged lists its sentence without a detail", async () => {
    const { d, store, clock } = await alarmed();
    clock.advance(1_000);
    await store.recordAlert({ pattern: "zero_tokens", pattern_key: "zero_tokens", error_code: "zero_tokens", count: 3, detail: null }, ALERT_DEDUPE_MS);
    expect((await overview(d)).system_actions.filter((a) => a.code === "alarm").map((a) => [a.text, a.command])).toEqual([
      ["Alarm: 3 agent runs in a row used no tokens", "factory llm-check"],
      [`${ALARM}: npm test exited #`, "Failures page (/app/failures)"],
    ]);
  });

  it("the affected item's why names the alarm on Items and the item page; other items' do not; resolved, it is gone", async () => {
    const { d, clock, hit, other } = await alarmed();
    expect(await whyRow(d, hit.id)).toBe(`The run failed (run_failed:implement:checks_failed): a person decides what happens next. ${ALARM}`);
    expect(await whyItem(d, hit.id)).toBe(await whyRow(d, hit.id));
    expect(await whyRow(d, other.id)).not.toContain("Alarm");
    expect(await whyItem(d, other.id)).not.toContain("Alarm");
    clock.advance(ALERT_DEDUPE_MS);
    expect(await whyRow(d, hit.id)).toBe("The run failed (run_failed:implement:checks_failed): a person decides what happens next");
    expect(await whyItem(d, hit.id)).not.toContain("Alarm");
  });

  it("a crash-loop alarm names itself in the why of each item with a queued run, the Queue's why too", async () => {
    const { d, store, clock, other } = await alarmed();
    await enqueue(store, other, "triage", "other:t");
    await store.recordAlert({ pattern: "child_restarts", pattern_key: "child_restarts", error_code: "child_restarts", count: 5, detail: "exit code 1" }, ALERT_DEDUPE_MS);
    const restart = "Alarm: the factory restarted 5 times in 30 minutes";
    expect(await whyRow(d, other.id)).toBe(`Queued at position 1. ${restart}`);
    expect(await whyItem(d, other.id)).toBe(`Queued at position 1. ${restart}`);
    const q = await json<{ queue: { work_item_id: string; why: WhyBody | null }[] }>(d, "/api/v1/queue");
    expect(q.queue.find((x) => x.work_item_id === other.id)!.why!.text).toBe(`Queued at position 1. ${restart}`);
    clock.advance(ALERT_DEDUPE_MS);
    expect(await whyRow(d, other.id)).toBe("Queued at position 1");
  });
});

describe("ui api: Needs you, Needs triage and Blocked by another task", () => {
  const ASK = { reason: "The issue names two different behaviours.", question: "Which of the two should the factory build?" };

  /** The seeded store, with `asks` (item id → run kind) answered by a stored run that asked for a human. */
  async function withAsks(asks: Map<string, "triage" | "implement">) {
    return seeded({
      store: (store) =>
        new Proxy(store, {
          get(target, prop, receiver) {
            if (prop === "listRuns") {
              return async (id: WorkItemId) => {
                const kind = asks.get(id);
                if (!kind) return target.listRuns(id);
                return [{ id: `run_${id}`, work_item_id: id, kind, status: "succeeded", outcome: { status: "succeeded", summary: "", data: { needs_human: ASK } } }];
              };
            }
            const v = Reflect.get(target, prop, receiver) as unknown;
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        }),
    });
  }

  it("a triage run's ask is in Needs triage with the question and an Answer link; an implement ask stays in Needs you", async () => {
    const asks = new Map<string, "triage" | "implement">();
    const { d, store } = await withAsks(asks);
    const triage = await make(store, 40, "Unclear issue");
    await patch(store, triage, { blocked_on: "human", blocked_reason: "agent_needs_human", failure_comment_url: "https://github.com/o/r/issues/40#c1" });
    const impl = await make(store, 41, "Implement asks");
    await patch(store, impl, { stage: "RUNNING", blocked_on: "human", blocked_reason: "agent_needs_human" });
    asks.set(triage.id, "triage");
    asks.set(impl.id, "implement");
    const rows = (await json<{ items: { id: string; level: string; badges: string[]; need?: { reason: string } }[] }>(d, "/api/v1/items?state=needs")).items;
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(row(triage.id)).toMatchObject({ level: "needs_triage", badges: ["triage asks"], need: { reason: ASK.question } });
    expect(row(impl.id)).toMatchObject({ level: "needs_you", need: { reason: ASK.question } });
    // The classic page shows the question and an Answer link to the ask.
    const page = (await get(d, "/classic")).body;
    expect(page).toContain(`${ASK.question} · <a href="https://github.com/o/r/issues/40#c1"`);
    expect(page).toContain(">Answer</a>");
  });

  it("the overview's needs_you counts Needs you and Needs triage items plus system actions, nothing from Blocked by another task", async () => {
    const { d, store } = await seeded();
    const count = async () => (await json<{ needs_you: number }>(d, "/api/v1/overview")).needs_you;
    const before = await count();
    const dep = await make(store, 50, "Waits on a dependency");
    await enqueue(store, dep, "implement", "dep50:i", { stage: "RUNNING", blocked_on: "dependency", blocked_reason: "waiting for #12 to merge" });
    const phase = await make(store, 51, "Waits on a phase");
    await patch(store, phase, { blocked_on: "upstream", blocked_reason: "phase_hold" });
    expect(await count()).toBe(before);
    const budget = await make(store, 52, "Budget check");
    await patch(store, budget, { blocked_on: "budget", blocked_reason: "budget_checkpoint" });
    const triage = await make(store, 53, "Triage asks");
    await patch(store, triage, { blocked_on: "human", blocked_reason: "agent_needs_human" });
    expect(await count()).toBe(before + 2);
    const needs = (await json<{ items: { id: string; level: string }[] }>(d, "/api/v1/items?state=needs")).items;
    expect(needs.map((i) => i.id)).toEqual(expect.arrayContaining([budget.id, triage.id]));
    expect(needs.map((i) => i.id)).not.toContain(dep.id);
    expect(needs.map((i) => i.id)).not.toContain(phase.id);
  });

  it("a request with an old level id gets 400", async () => {
    const { d } = await seeded();
    for (const old of ["needs_human", "waiting_on_issue"]) expect((await get(d, `/api/v1/items?state=${old}`)).status).toBe(400);
  });
});

describe("ui api: the Settings page's typed form of the file-only keys (design 08-settings)", () => {
  const entry = (configKey: string, iface: string, guard: boolean, names: string[]) => ({ interface: iface, configKey, guard, optional: false, plugins: Object.fromEntries(names.map((n) => [n, () => null])) });
  const loaded = {
    file: {
      env: "local", state_dir: ".factory", ui: { port: 4310 }, outbound: { batching: { slack: { max: 5 } } },
      plugins: { secrets: "env-file", runner: "claude-code" }, hotspot_paths: ["src/core/"], slack: { channels: [SECRET] },
    },
    registry: {
      store: entry("store.type", "FactoryStore", false, ["sqlite"]),
      secrets: entry("plugins.secrets", "SecretStore", true, ["env-file", "keychain"]),
      runner: entry("plugins.runner", "AgentRunner", false, ["claude-code", "fake"]),
    },
    plugins: { store: "sqlite", secrets: "env-file", runner: "claude-code" },
  } as unknown as Parameters<typeof fileKeysOf>[0];

  async function wired(editFile: UiSettings["editFile"]) {
    const { d } = await seeded();
    const settings: UiSettings = {
      base: { file: {}, layers: { defaults: {}, projects: {} } } as unknown as UiSettings["base"], repo: { owner: "o", name: "r" }, actor: "local:owner",
      resolveProject: async () => null, csrfToken: newCsrfToken(), ...(editFile ? { editFile } : {}),
    };
    return { ...d, settings };
  }
  const refuse = async (): Promise<ConfigEditResult> => ({ ok: false, refusal: "no" });

  it("GET lists each editable file-only key's file value, the read-only keys' values and the plugins interfaces with their registered names", async () => {
    const view = await json<{ file_keys: FileKeysView }>(await wired(Object.assign(refuse, { fileKeys: () => fileKeysOf(loaded) })), "/api/v1/settings");
    const editable = view.file_keys.editable.map((f) => f.key);
    for (const key of ["plugins", "models", "model_by", "slack", "repo.install_command", "repo.test_command", "repo.check_commands", "repo.path", "toolchain", "dials", "floors", "permissions", "hotspot_paths", "mechanical_paths", "path_companions"]) {
      expect(editable, key).toContain(key);
    }
    // The read-only keys and the guards' own members are not in the form; deny_paths is no file key at all.
    for (const key of ["state_dir", "worktrees_dir", "plugins.secrets", "plugins.egress", "plugins.broker", "deny_paths"]) expect(editable, key).not.toContain(key);
    expect(view.file_keys.editable.find((f) => f.key === "hotspot_paths")!.value).toBe('["src/core/"]');
    expect(view.file_keys.editable.find((f) => f.key === "models")!.value).toBeNull();
    // A value with a secret in it is withheld whole.
    expect(view.file_keys.editable.find((f) => f.key === "slack")!.value).not.toContain(SECRET);
    expect(view.file_keys.read_only).toEqual([
      { key: "store", value: null }, { key: "env", value: '"local"' }, { key: "state_dir", value: '".factory"' }, { key: "worktrees_dir", value: null },
      { key: "ui", value: '{"port":4310}' }, { key: "outbound.batching", value: '{"slack":{"max":5}}' }, { key: "cli_user", value: null },
    ]);
    // Only the interfaces under `plugins`, each with its registered names.
    expect(view.file_keys.plugins).toEqual([
      { kind: "secrets", interface: "SecretStore", guard: true, names: ["env-file", "keychain"], selected: "env-file" },
      { kind: "runner", interface: "AgentRunner", guard: false, names: ["claude-code", "fake"], selected: "claude-code" },
    ]);
  });

  it("GET has no form without a file writer", async () => {
    expect((await json<{ file_keys: unknown }>(await wired(undefined), "/api/v1/settings")).file_keys).toBeNull();
  });

  it("an edit-file POST answers with the filed item and its branch, for the Merge button", async () => {
    const editFile = async (r: ConfigEditRequest): Promise<ConfigEditResult> => ({ ok: true, item: "wi_1" as WorkItemId, branch: "factory/wi_1", sha: "a".repeat(40), old_value: null, new_value: r.value });
    const d = await wired(editFile);
    const r = await writeSettings(d, d.settings, { action: "edit-file", key: "hotspot_paths", value: '["src/"]' });
    expect(r).toEqual({ status: 200, value: { ok: true, lines: expect.any(Array), item: "wi_1", branch: "factory/wi_1" } });
    // A refusal names no item.
    const no = await wired(refuse);
    expect(await writeSettings(no, no.settings, { action: "edit-file", key: "hotspot_paths", value: '["src/"]' })).toEqual({ status: 422, value: { error: "refused: no" } });
  });
});
