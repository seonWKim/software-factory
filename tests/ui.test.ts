import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { uiPort } from "../src/compose.js";
import { Controller } from "../src/core/controller.js";
import type { WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { type UiServer, startUi } from "../src/ui/server.js";
import { FakeAuth, FakeSource, alice, config, issueRef, silent } from "./helpers/fakes.js";
import { issue, newStore, system, w1, w2 } from "./helpers/store.js";

const LEASE = 60_000;
// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;

interface Page {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** node:http, not fetch: fetch will not send a custom Host header. */
function get(port: number, path: string, opts: { method?: string; host?: string | null } = {}): Promise<Page> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.host !== null) headers.host = opts.host ?? `127.0.0.1:${port}`;
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers, setHost: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The inner HTML of <section id="…">. */
function section(body: string, id: string): string {
  const start = body.indexOf(`<section id="${id}">`);
  if (start < 0) throw new Error(`no section ${id}`);
  return body.slice(start, body.indexOf("</section>", start));
}

async function setTitle(store: FactoryStore, n: number, title: string | null) {
  return (await store.createWorkItem({ ...issue(n), ...(title === null ? {} : { title }) }, system)).item;
}

async function patch(store: FactoryStore, item: WorkItem, p: Parameters<FactoryStore["transition"]>[0]["patch"]) {
  const cur = (await store.getWorkItem(item.id))!;
  const r = await store.transition({ id: item.id, expected_version: cur.version, patch: p, actor: system, reason: "seed" });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

/** Seeds one item per section, starts the page on port 0. */
async function seeded() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);

  const waiting = await setTitle(store, 1, "Spec for <script>alert(1)</script> the gate");
  await patch(store, waiting, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
  const merging = await setTitle(store, 2, "Merge me");
  await patch(store, merging, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42, tier: 2 });

  // Finished runs: one succeeded with tokens, one failed carrying a secret-shaped string.
  const done = await setTitle(store, 3, "Done item");
  await store.transition({ id: done.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "triage", idempotency_key: "done:t" } });
  let r = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
  clock.advance(90_000);
  await store.completeRun(r.id, r.lease!.token, { status: "succeeded", summary: "ok", data: { tokens: 1234 } });
  await store.transition({ id: done.id, expected_version: 2, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: "done:i" } });
  r = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
  await store.completeRun(r.id, r.lease!.token, { status: "failed", error_code: "agent_error", detail: `push failed: token ${SECRET} rejected`, infra: false });
  await patch(store, done, { stage: "CLOSED", close_reason: "completed", token_cost: 1234 });

  // Running: claimed, then its heartbeat goes stale.
  const running = await setTitle(store, 4, "Running item");
  await store.transition({ id: running.id, expected_version: 1, patch: { stage: "RUNNING" }, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: "run:i" } });
  const claimed = (await store.claimRun({ worker_id: w2, kinds: ["implement"], lease_ms: LEASE }))!;

  // Queued, with no title (an item from before titles existed shows its source id).
  const queued = await setTitle(store, 5, null);
  await store.transition({ id: queued.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "triage", idempotency_key: "q:t" } });

  clock.advance(LEASE + 5_000);

  const scanner = new PatternEgressScanner(async () => []);
  const ui = await startUi(
    { store, scanner, clock, lease_ms: LEASE, prUrl: (project, n) => `https://github.com/${project}/pull/${n}` },
    0,
  );
  servers.push(ui);
  return { clock, store, ui, port: ui.port, items: { waiting, merging, done, running, queued }, claimed };
}

const servers: UiServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("ui: read-only status page", () => {
  it("binds to 127.0.0.1 only", async () => {
    const { ui } = await seeded();
    expect(ui.address).toBe("127.0.0.1");
    expect(ui.port).toBeGreaterThan(0);
  });

  it("GET / shows every section in order with the seeded items and runs", async () => {
    const { port, items, claimed } = await seeded();
    const page = await get(port, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html; charset=utf-8/);
    expect(page.body).toContain('<meta http-equiv="refresh" content="5">');
    expect(page.body).not.toMatch(/<script/i);

    const order = ["waiting", "running", "queue", "items", "totals"].map((id) => page.body.indexOf(`<section id="${id}">`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const waiting = section(page.body, "waiting");
    expect(waiting).toContain("spec_pending");
    expect(waiting).toContain("merge_pending");
    expect(waiting).toContain(`href="https://github.com/o/r/issues/1"`);
    expect(waiting).toContain(`href="https://github.com/o/r/pull/42"`);
    expect(waiting).toContain("Merge me");
    expect(waiting).not.toContain("Running item");

    const running = section(page.body, "running");
    expect(running).toContain("Running item");
    expect(running).toContain("implement");
    expect(running).toContain("worker-2");
    expect(running).toContain(`href="/items/${items.running.id}"`);
    expect(running).toContain('class="stale"');
    expect(claimed.attempt).toBe(1);

    const queue = section(page.body, "queue");
    expect(queue).toContain("o/r#5"); // no title: source id
    expect(queue).toContain("triage");
    expect(queue).not.toContain("Running item");

    const all = section(page.body, "items");
    for (const t of ["Merge me", "Running item", "o/r#5"]) expect(all).toContain(t);
    expect(all).not.toContain("Done item"); // CLOSED hidden by default
    expect(all).toContain(`href="https://github.com/o/r/pull/42"`);

    const totals = section(page.body, "totals");
    expect(totals).toMatch(/CLOSED<\/th><td>1</);
    expect(totals).toMatch(/READY<\/th><td>1</);
    expect(totals).toMatch(/succeeded<\/th><td>1</);
    expect(totals).toMatch(/failed<\/th><td>1</);
    expect(totals).toMatch(/tokens<\/th><td>1234</);
  });

  it("filters by ?stage= and shows CLOSED only with ?closed=1 or ?stage=CLOSED", async () => {
    const { port } = await seeded();
    const review = section((await get(port, "/?stage=REVIEW")).body, "items");
    expect(review).toContain("Merge me");
    expect(review).not.toContain("Running item");
    expect(section((await get(port, "/?closed=1")).body, "items")).toContain("Done item");
    expect(section((await get(port, "/?stage=CLOSED")).body, "items")).toContain("Done item");
    expect((await get(port, "/?stage=BOGUS")).status).toBe(400);
  });

  it("GET /items/<id> shows the timeline and runs with status, attempt, duration, tokens and error", async () => {
    const { port, items } = await seeded();
    const page = await get(port, `/items/${items.done.id}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<meta http-equiv="refresh" content="5">');
    const timeline = section(page.body, "timeline");
    expect(timeline).toContain("intake");
    expect(timeline).toContain("CLOSED");
    const runs = section(page.body, "runs");
    expect(runs).toContain("succeeded");
    expect(runs).toContain("failed");
    expect(runs).toContain("1234");
    expect(runs).toContain("1m 30s"); // started → finished
    expect(runs).toContain("agent_error");
  });

  it("escapes HTML: a <script> title never appears raw on any page", async () => {
    const { port, items } = await seeded();
    for (const path of ["/", "/?closed=1", `/items/${items.waiting.id}`, `/items/${items.done.id}`]) {
      const { body } = await get(port, path);
      expect(body).not.toMatch(/<script/i);
    }
    expect((await get(port, "/")).body).toContain("Spec for &lt;script&gt;alert(1)&lt;/script&gt; the gate");
  });

  it("withholds a free-text field with an egress finding and names the rule", async () => {
    const { port, items } = await seeded();
    for (const path of ["/", "/?closed=1", `/items/${items.done.id}`]) {
      expect((await get(port, path)).body).not.toContain(SECRET);
    }
    expect(section((await get(port, `/items/${items.done.id}`)).body, "runs")).toContain("[withheld: github_token]");
  });

  it("accepts only GET and HEAD, 404s unknown paths, and refuses foreign Host headers", async () => {
    const { port, items } = await seeded();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await get(port, "/", { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.allow).toBe("GET, HEAD");
    }
    const head = await get(port, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");

    expect((await get(port, "/nope")).status).toBe(404);
    expect((await get(port, "/items/wi_missing")).status).toBe(404);
    expect((await get(port, `/items/${items.done.id}/x`)).status).toBe(404);

    for (const host of [`localhost:${port}`, "localhost", `127.0.0.1:${port}`]) {
      expect((await get(port, "/", { host })).status, host).toBe(200);
    }
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, "localhost.evil.example"]) {
      const res = await get(port, "/", { host });
      expect(res.status, String(host)).toBe(403);
      expect(res.body).not.toContain("Merge me");
    }
    // No Host header at all: node:http rejects it with 400 before the handler runs (requireHostHeader).
    const noHost = await get(port, "/", { host: null });
    expect(noHost.status).toBe(400);
    expect(noHost.body).not.toContain("Merge me");
  });

  it("rendering every page writes nothing to the store", async () => {
    const { port, store, items } = await seeded();
    const ids = Object.values(items).map((i) => i.id as WorkItemId);
    const snapshot = async () =>
      Promise.all(ids.map(async (id) => ({ item: await store.getWorkItem(id), runs: await store.listRuns(id), sc: await store.listStateChanges(id) })));
    const before = await snapshot();
    for (const path of ["/", "/?closed=1", "/?stage=READY", ...ids.map((id) => `/items/${id}`), "/nope"]) await get(port, path);
    await get(port, "/", { method: "POST" });
    expect(await snapshot()).toEqual(before);
  });
});

describe("ui: config and intake", () => {
  it("ui.port defaults to 4310 and must be a valid port", () => {
    expect(uiPort(undefined)).toBe(4310);
    expect(uiPort({})).toBe(4310);
    expect(uiPort({ port: 5000 })).toBe(5000);
    for (const port of [0, -1, 70000, 1.5, "4310"]) expect(() => uiPort({ port } as never)).toThrow(/ui\.port/);
  });

  it("intake records the issue title; problem is unchanged", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource();
    const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent });
    source.queue.push({ kind: "item_requested", source: issueRef(9), requester: alice, title: "Status page", body: "please" });
    await controller.tickIntake();
    const item = (await store.getWorkItemBySource("github_issue", issueRef(9).id))!;
    expect(item.title).toBe("Status page");
    expect(item.problem).toBe("Status page\n\nplease");
  });

  it("a page with no egress findings has no withheld markers", async () => {
    const { port } = await seeded();
    expect(section((await get(port, "/")).body, "items")).not.toContain("withheld");
  });

  it("time since heartbeat within the lease is not highlighted", async () => {
    const { port, clock, store, claimed } = await seeded();
    await store.heartbeat(claimed.id, claimed.lease!.token, LEASE);
    clock.advance(1_000);
    expect(section((await get(port, "/")).body, "running")).not.toContain('class="stale"');
  });
});
