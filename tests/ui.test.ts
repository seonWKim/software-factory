import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { uiPort } from "../src/compose.js";
import { Controller } from "../src/core/controller.js";
import type { WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiServer, startUi } from "../src/ui/server.js";
import { FakeAuth, FakeSource, alice, config, issueRef, silent, cleanScanner } from "./helpers/fakes.js";
import { issue, newStore, system, w1, w2 } from "./helpers/store.js";

const LEASE = 60_000;
// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const HEALTHY = [{ ok: true, msg: "secret file is outside the repository" }];

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
    { store, scanner, clock, lease_ms: LEASE, prUrl: (project, n) => `https://github.com/${project}/pull/${n}`, health: new HealthMonitor(async () => HEALTHY, clock) },
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

    const order = ["needs", "running", "queue", "items", "totals"].map((id) => page.body.indexOf(`<section id="${id}">`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page.body).not.toContain('<section id="waiting">');
    expect(page.body.indexOf('<section id="health">')).toBeGreaterThan(order[0]!);

    const needs = section(page.body, "needs");
    expect(needs).toContain("<h2>Needs you (2)</h2>");
    expect(page.body).toMatch(/<title>[^<]*\(2\)[^<]*<\/title>/);
    expect(needs).toContain("spec ready");
    expect(needs).toContain("ready to merge");
    expect(needs).toContain(`href="https://github.com/o/r/issues/1"`);
    expect(needs).toContain(`href="https://github.com/o/r/pull/42"`);
    expect(needs).toContain("Merge me");
    expect(needs).not.toContain("Running item");

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
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await get(port, "/api/health", { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.allow).toBe("GET, HEAD");
    }
    const apiHead = await get(port, "/api/health", { method: "HEAD" });
    expect(apiHead.status).toBe(200);
    expect(apiHead.body).toBe("");
    for (const host of ["evil.example", `evil.example:${port}`]) {
      const res = await get(port, "/api/health", { host });
      expect(res.status, host).toBe(403);
      expect(res.body).not.toContain("secret file");
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
    for (const path of ["/", "/?closed=1", "/?stage=READY", "/?health=refresh", "/api/health", ...ids.map((id) => `/items/${id}`), "/nope"]) await get(port, path);
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
    const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
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

const HOUR = 60 * 60 * 1000;

/** The rows (<tr>…</tr>) of the Needs you table, header excluded. */
function needsRows(body: string): string[] {
  return section(body, "needs").split("<tr>").slice(2).map((r) => r.slice(0, r.indexOf("</tr>")));
}

async function startOn(store: FactoryStore, clock: FakeClock) {
  const ui = await startUi(
    { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: LEASE, prUrl: (project, n) => `https://github.com/${project}/pull/${n}`, health: new HealthMonitor(async () => HEALTHY, clock) },
    0,
  );
  servers.push(ui);
  return ui.port;
}

/** One waiting item per reason, blocked an hour apart; item 1 is updated last but waited longest. */
async function seededNeeds() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const mk = async (n: number, title: string, p: Parameters<FactoryStore["transition"]>[0]["patch"]) =>
    patch(store, await setTitle(store, n, title), p);
  const fail = async (item: WorkItem, key: string, error_code: string) => {
    const cur = (await store.getWorkItem(item.id))!;
    await store.transition({ id: item.id, expected_version: cur.version, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: key } });
    const r = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
    await store.completeRun(r.id, r.lease!.token, { status: "failed", error_code, detail: "", infra: false });
  };

  const spec = await mk(1, "Spec item", { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", spec_comment_url: "https://github.com/o/r/issues/1#issuecomment-11" });
  clock.advance(HOUR);
  await mk(2, "Merge item", { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42 });
  clock.advance(HOUR);
  await mk(3, "Failed item", { stage: "RUNNING", blocked_on: "human", blocked_reason: "run_failed:implement:diff_too_large", failure_comment_url: "https://github.com/o/r/issues/3#issuecomment-33" });
  clock.advance(HOUR);
  const maxed = await mk(4, "Maxed item", { stage: "RUNNING" });
  await fail(maxed, "m:1", "agent_timed_out");
  await fail(maxed, "m:2", "agent_failed");
  await patch(store, maxed, { blocked_on: "human", blocked_reason: "max_attempts" });
  clock.advance(HOUR);
  await mk(5, "Loops item", { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops", pr_number: 50 });
  clock.advance(HOUR);
  const conflict = await mk(6, "Conflict item", { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 60 });
  clock.advance(HOUR);
  await patch(store, conflict, { blocked_reason: "merge_conflict_pending" });
  clock.advance(HOUR / 2);
  await mk(7, "Unknown item", { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_revisions" });
  clock.advance(HOUR / 2);
  await mk(8, "Old spec", { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
  await mk(9, "Closed item", { stage: "CLOSED", close_reason: "rejected", blocked_on: "human", blocked_reason: "spec_pending" });
  clock.advance(HOUR / 4);
  const restarted = await mk(10, "Restarted item", { stage: "RUNNING", blocked_on: "human", blocked_reason: "max_restart" });
  await fail(restarted, "r:1", "lease_expired");
  clock.advance(HOUR * 3 / 4);
  await patch(store, spec, { token_cost: 5 }); // newest update, but not a change to what it waits on
  clock.advance(2 * HOUR);
  return { store, port: await startOn(store, clock) };
}

describe("ui: Needs you", () => {
  it("one row per waiting item, oldest wait first, with number, title, wait, reason, link and command", async () => {
    const { port } = await seededNeeds();
    const page = await get(port, "/");
    const needs = section(page.body, "needs");
    expect(needs).toContain("<h2>Needs you (9)</h2>");
    expect(page.body).toMatch(/<title>[^<]*\(9\)[^<]*<\/title>/);
    expect(needs).not.toContain("Closed item");

    const rows = needsRows(page.body);
    const titles = ["Spec item", "Merge item", "Failed item", "Maxed item", "Loops item", "Conflict item", "Unknown item", "Old spec", "Restarted item"];
    expect(rows).toHaveLength(titles.length);
    rows.forEach((r, i) => expect(r, titles[i]).toContain(titles[i]));

    const [spec, merge, failed, maxed, loops, conflict, unknown, oldSpec, restarted] = rows as [string, string, string, string, string, string, string, string, string];
    // Issue number and how long it has waited (from the change that set its current block, not updated_at).
    expect(spec).toContain("<td>#1</td>");
    expect(spec).toContain("<td>10h 00m</td>");
    expect(merge).toContain("<td>9h 00m</td>");
    expect(failed).toContain("<td>8h 00m</td>");
    expect(maxed).toContain("<td>7h 00m</td>");
    expect(conflict).toContain("<td>#6</td>");
    expect(conflict).toContain("<td>4h 00m</td>");
    expect(unknown).toContain("<td>3h 30m</td>");

    expect(spec).toContain("spec ready");
    expect(spec).toContain(`href="https://github.com/o/r/issues/1#issuecomment-11"`);
    expect(spec).toContain("/approve or /reject &lt;reason&gt;");

    expect(merge).toContain("ready to merge");
    expect(merge).toContain(`href="https://github.com/o/r/pull/42"`);
    expect(merge).toContain("merge the PR");

    expect(failed).toContain("failed: diff_too_large");
    expect(failed).toContain(`href="https://github.com/o/r/issues/3#issuecomment-33"`);
    expect(failed).toContain("/retry");

    // max_attempts / max_restart: the code of the latest failed run; no stored link falls back to the issue.
    expect(maxed).toContain("failed: agent_failed");
    expect(maxed).not.toContain("agent_timed_out");
    expect(maxed).toContain(`href="https://github.com/o/r/issues/4"`);
    expect(maxed).toContain("/retry");
    expect(restarted).toContain("<td>2h 45m</td>");
    expect(restarted).toContain("failed: lease_expired");
    expect(restarted).toContain("/retry");

    expect(loops).toContain("review found bugs too many times");
    expect(conflict).toContain("merge conflict");
    expect(unknown).toContain("max revisions");
    for (const [r, n] of [[loops, 5], [conflict, 6], [unknown, 7]] as const) {
      expect(r).toContain(`href="https://github.com/o/r/issues/${n}"`);
      expect(r).not.toContain("/pull/");
      for (const cmd of ["/retry", "/approve", "merge the PR"]) expect(r).not.toContain(cmd);
    }

    expect(oldSpec).toContain("spec ready");
    expect(oldSpec).toContain(`href="https://github.com/o/r/issues/8"`);
    expect(oldSpec).not.toContain("issuecomment");
  });

  it("the page has no form, button or input", async () => {
    const { port } = await seededNeeds();
    for (const path of ["/", "/?closed=1", "/?health=refresh"]) expect((await get(port, path)).body).not.toMatch(/<(form|button|input|select|textarea)\b/i);
  });

  it("says so when nothing waits, and the title shows 0", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const page = await get(await startOn(store, clock), "/");
    expect(section(page.body, "needs")).toContain("<h2>Needs you (0)</h2>");
    expect(page.body).toMatch(/<title>[^<]*\(0\)[^<]*<\/title>/);
  });

  it("N counts every waiting item past the 200-row list limit", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    for (let n = 1; n <= 205; n++) {
      const { item } = await store.createWorkItem(issue(n), system);
      await store.transition({ id: item.id, expected_version: 1, patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: n }, actor: system, reason: "x" });
    }
    const page = await get(await startOn(store, clock), "/");
    expect(section(page.body, "needs")).toContain("<h2>Needs you (205)</h2>");
    expect(page.body).toMatch(/<title>[^<]*\(205\)[^<]*<\/title>/);
    expect(needsRows(page.body)).toHaveLength(200);
  });
});
