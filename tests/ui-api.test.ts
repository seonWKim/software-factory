// The read-only JSON API under /api/v1 (design §9): its contract, its request guards, that it lists the same
// rows as the HTML page, that store text leaves only through the Withholder, and that it never writes.
// Everything goes through respond(), the server's whole request handling without a socket.

import { describe, expect, it } from "vitest";
import type { WorkItem, WorkItemId, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, type UiResponse, respond, wire } from "../src/ui/server.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

const LEASE = 60_000;
// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const ROUTES = ["/api/v1/overview", "/api/v1/items", "/api/v1/items/ITEM", "/api/v1/runs", "/api/v1/queue", "/api/v1/workers", "/api/v1/health"];

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
  await patch(store, merge, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42, tier: 2 });
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
    prUrl: (project, n) => `https://github.com/${project}/pull/${n}`,
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
      const page = await get(d, `/${q}`);
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
    expect(api.facets.stage.CLOSED).toBe(0);
    const page = (await get(d, "/")).body;
    expect(page).toContain(`<option value="needs">Needs you (3)</option>`);
    expect(page).toContain(`>All (${api.facets.allStates})</option>`);
  });

  it("an unknown filter value is a 400 JSON, for each filter", async () => {
    const { d } = await seeded();
    for (const q of ["state=nope", "stage=DONE", "tier=9", "kind=deploy", "unblocks=yes", "closed=2"]) {
      const r = await get(d, `/api/v1/items?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(r.body).error, q).toMatch(/^Unknown /);
      expect((await get(d, `/?${q}`)).status, q).toBe(400);
    }
  });

  it("item detail has the facts, the timeline and the runs, and never a fencing token", async () => {
    const { d, items } = await seeded();
    const body = await json<{
      item: { id: string; title: string; stage: string; close_reason: string; token_cost: number; pr_number: number | null; conflicts: unknown };
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
    const rows = sectionOf((await get(d, "/")).body, "queue").split("<tr").length - 2; // minus the leading text and the header row
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

  it("/overview gives the numbers the page shows for the same store", async () => {
    const { d } = await seeded();
    const o = await json<{
      stages: Record<string, number>; needs_you: number; running: number; queued: number; last_24h: { succeeded: number; failed: number; tokens: number };
    }>(d, "/api/v1/overview");
    expect(o).toMatchObject({ needs_you: 3, running: 3, queued: 2, last_24h: { succeeded: 1, failed: 1, tokens: 1234 } });
    expect(o.stages).toEqual({ NEW: 3, READY: 1, RUNNING: 2, REVIEW: 2, CLOSED: 1 });

    const page = (await get(d, "/")).body;
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
    expect(v1.body).toBe(old.body);
    expect(healthRuns()).toBe(1);
    expect(JSON.parse(old.body)).toEqual({
      checked_at: d.clock.now().toISOString(),
      checks: [{ status: "ok", msg: "secret file is outside the repository" }, { status: "fail", msg: "[withheld: github_token]" }],
    });
    expect(old.headers["content-type"]).toBe("application/json; charset=utf-8");
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
