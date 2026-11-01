import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { uiPort } from "../src/compose.js";
import { Controller } from "../src/core/controller.js";
import type { WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStatus } from "../src/ui/factory-status.js";
import { readFactoryStatus } from "../src/ui/factory-status.js";
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

  it("GET / shows every section in order: one ranked list, with what to do for items that wait on a person", async () => {
    const { port, items, claimed } = await seeded();
    const page = await get(port, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html; charset=utf-8/);
    expect(page.body).not.toContain('http-equiv="refresh"');
    expect(page.body.match(/<script/gi)).toHaveLength(1);

    const order = ["totals", "filters", "items", "running", "queue"].map((id) => page.body.indexOf(`<section id="${id}">`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page.body).not.toContain('<section id="needs">');
    // Health sits after the list, before the running runs.
    expect(page.body.indexOf('<section id="health">')).toBeGreaterThan(order[2]!);
    expect(page.body.indexOf('<section id="health">')).toBeLessThan(order[3]!);

    expect(page.body).toMatch(/<title>[^<]*\(2\)[^<]*<\/title>/);
    expect(section(page.body, "filters")).toContain("Needs you (2)");

    // Ranked: ready to merge, needs approval, stuck (stale heartbeat), queued. CLOSED hidden.
    const list = rows(page.body);
    expect(list.map((r) => r[2])).toEqual([
      expect.stringContaining("Merge me"),
      expect.stringContaining("Spec for"),
      expect.stringContaining("Running item"),
      expect.stringContaining("o/r#5"),
    ]);
    expect(list[0]![0]).toContain("ready to merge");
    expect(list[0]![5]).toContain("ready to merge");
    expect(list[0]![5]).toContain(`href="https://github.com/o/r/pull/42"`);
    expect(list[0]![6]).toContain(`href="https://github.com/o/r/pull/42"`);
    expect(list[0]![4]).toBe("2");
    expect(list[1]![0]).toContain("needs approval");
    expect(list[1]![5]).toContain("spec ready");
    expect(list[1]![1]).toContain(`href="https://github.com/o/r/issues/1"`);
    expect(list[2]![0]).toMatch(/stuck \d+ min/);
    expect(list[2]![5]).toBe("");
    expect(list[3]![0]).toContain("queued triage");
    expect(section(page.body, "items")).not.toContain("Done item");

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
    expect(page.body).not.toContain('http-equiv="refresh"');
    expect(page.body).toContain('id="ago"');
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

  it("escapes HTML: a <script> title never appears raw on any page; the only script is the page's own", async () => {
    const { port, items } = await seeded();
    for (const path of ["/", "/?closed=1", "/?q=script", `/items/${items.waiting.id}`, `/items/${items.done.id}`]) {
      const { body } = await get(port, path);
      expect(body).not.toMatch(/<script>alert/i);
      expect(body.match(/<script/gi), path).toHaveLength(1);
      expect(body).toContain("<script>(function(){");
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

/** The cells of each row of the work item list: state, number, title, stage, tier, next step, PR, waiting. */
function rows(body: string): string[][] {
  const list = section(body, "items");
  const tbody = list.indexOf("<tbody>");
  if (tbody < 0) return [];
  return list
    .slice(tbody + "<tbody>".length, list.indexOf("</tbody>"))
    .split("</tr>")
    .filter((r) => r.includes("<td>"))
    .map((r) => r.split("<td>").slice(1).map((c) => c.slice(0, c.lastIndexOf("</td>"))));
}

async function startOn(store: FactoryStore, clock: FakeClock, factoryStatus?: () => Promise<FactoryStatus | null>) {
  const ui = await startUi(
    { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: LEASE, prUrl: (project, n) => `https://github.com/${project}/pull/${n}`, health: new HealthMonitor(async () => HEALTHY, clock), ...(factoryStatus ? { factoryStatus } : {}) },
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

describe("ui: Needs you (?state=needs)", () => {
  it("one row per waiting item: ready to merge, then needs approval, then the rest, oldest wait first", async () => {
    const { port } = await seededNeeds();
    const page = await get(port, "/?state=needs");
    expect(page.body).toMatch(/<title>[^<]*\(9\)[^<]*<\/title>/);
    expect(section(page.body, "filters")).toContain("Needs you (9)");
    expect(section(page.body, "items")).not.toContain("Closed item");

    const list = rows(page.body);
    const titles = ["Merge item", "Spec item", "Old spec", "Failed item", "Maxed item", "Loops item", "Conflict item", "Unknown item", "Restarted item"];
    expect(list.map((r) => r[2])).toEqual(titles.map((t) => expect.stringContaining(t)));
    const by = Object.fromEntries(titles.map((t, i) => [t, list[i]!])) as Record<string, string[]>;
    const [, number, , , , next, , waiting] = [0, 1, 2, 3, 4, 5, 6, 7];

    // Issue number and how long it has waited (from the change that set its current block, not updated_at).
    expect(by["Spec item"]![number]).toContain(">#1</a>");
    expect(by["Spec item"]![waiting]).toBe("10h 00m");
    expect(by["Merge item"]![waiting]).toBe("9h 00m");
    expect(by["Failed item"]![waiting]).toBe("8h 00m");
    expect(by["Maxed item"]![waiting]).toBe("7h 00m");
    expect(by["Conflict item"]![number]).toContain(">#6</a>");
    expect(by["Conflict item"]![waiting]).toBe("4h 00m");
    expect(by["Unknown item"]![waiting]).toBe("3h 30m");
    expect(by["Old spec"]![waiting]).toBe("3h 00m");

    const spec = by["Spec item"]![next]!;
    expect(spec).toContain("spec ready");
    expect(spec).toContain(`href="https://github.com/o/r/issues/1#issuecomment-11"`);
    expect(spec).toContain("/approve or /reject &lt;reason&gt;");
    expect(by["Spec item"]![0]).toContain("needs approval");

    const merge = by["Merge item"]![next]!;
    expect(merge).toContain("ready to merge");
    expect(merge).toContain(`href="https://github.com/o/r/pull/42"`);
    expect(merge).toContain("merge the PR");

    const failed = by["Failed item"]![next]!;
    expect(failed).toContain("failed: diff_too_large");
    expect(failed).toContain(`href="https://github.com/o/r/issues/3#issuecomment-33"`);
    expect(failed).toContain("/retry");
    expect(by["Failed item"]![0]).toContain(">failed<");

    // max_attempts / max_restart: the code of the latest failed run; no stored link falls back to the issue.
    const maxed = by["Maxed item"]![next]!;
    expect(maxed).toContain("failed: agent_failed");
    expect(maxed).not.toContain("agent_timed_out");
    expect(maxed).toContain(`href="https://github.com/o/r/issues/4"`);
    expect(maxed).toContain("/retry");
    expect(by["Restarted item"]![waiting]).toBe("2h 45m");
    expect(by["Restarted item"]![next]).toContain("failed: lease_expired");
    expect(by["Restarted item"]![next]).toContain("/retry");

    expect(by["Loops item"]![next]).toContain("review found bugs too many times");
    expect(by["Loops item"]![0]).toContain("too many loops");
    expect(by["Conflict item"]![next]).toContain("merge conflict");
    expect(by["Unknown item"]![next]).toContain("max revisions");
    for (const [t, n] of [["Loops item", 5], ["Conflict item", 6], ["Unknown item", 7]] as const) {
      const r = by[t]![next]!;
      expect(r).toContain(`href="https://github.com/o/r/issues/${n}"`);
      expect(r).not.toContain("/pull/");
      for (const cmd of ["/retry", "/approve", "merge the PR"]) expect(r).not.toContain(cmd);
    }

    const oldSpec = by["Old spec"]![next]!;
    expect(oldSpec).toContain("spec ready");
    expect(oldSpec).toContain(`href="https://github.com/o/r/issues/8"`);
    expect(oldSpec).not.toContain("issuecomment");
  });

  it("?health=refresh is accepted alongside the filters", async () => {
    const { port } = await seededNeeds();
    for (const path of ["/?health=refresh", "/?state=needs&health=refresh"]) {
      const page = await get(port, path);
      expect(page.status, path).toBe(200);
      expect(page.body).toContain('<section id="health">');
    }
  });

  it("says so when nothing is listed, offers one next action, and the title shows 0", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const port = await startOn(store, clock);
    const page = await get(port, "/");
    expect(section(page.body, "items")).toContain("No open work items.");
    expect(section(page.body, "items")).toContain(`<a href="/?closed=1">Show closed items</a>`);
    expect(section(page.body, "filters")).toContain("Needs you (0)");
    expect(page.body).toMatch(/<title>[^<]*\(0\)[^<]*<\/title>/);
    const filtered = section((await get(port, "/?state=needs")).body, "items");
    expect(filtered).toContain("No items match these filters.");
    expect(filtered).toContain(`<a href="/">Clear filters</a>`);
  });

  it("N counts every waiting item past the 200-row list limit", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    for (let n = 1; n <= 205; n++) {
      const { item } = await store.createWorkItem(issue(n), system);
      await store.transition({ id: item.id, expected_version: 1, patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: n }, actor: system, reason: "x" });
    }
    const page = await get(await startOn(store, clock), "/");
    expect(page.body).toMatch(/<title>[^<]*\(205\)[^<]*<\/title>/);
    expect(rows(page.body)).toHaveLength(200);
  });
});

describe("ui: filters and search", () => {
  it("each filter narrows the list from the query string, and each option shows its count", async () => {
    const { port } = await seeded();
    const titles = async (q: string) => rows((await get(port, q)).body).map((r) => r[2]!.replace(/<[^>]+>/g, ""));
    expect(await titles("/?state=needs")).toEqual(["Merge me", expect.stringContaining("Spec for")]);
    expect(await titles("/?state=ready_to_merge")).toEqual(["Merge me"]);
    expect(await titles("/?state=stuck")).toEqual(["Running item"]);
    expect(await titles("/?state=closed")).toEqual(["Done item"]);
    expect(await titles("/?stage=REVIEW")).toEqual(["Merge me"]);
    expect(await titles("/?stage=CLOSED")).toEqual(["Done item"]);
    expect(await titles("/?closed=1")).toContain("Done item");
    expect(await titles("/?tier=2")).toEqual(["Merge me"]);
    expect(await titles("/?kind=implement")).toEqual(["Running item"]);
    expect(await titles("/?kind=triage")).toEqual(["o/r#5"]);
    expect(await titles("/?unblocks=1")).toEqual([]);
    expect(await titles("/?state=needs&stage=READY")).toEqual([expect.stringContaining("Spec for")]);

    const f = section((await get(port, "/?stage=REVIEW")).body, "filters");
    expect(f).toContain("Needs you (1)");
    expect(f).toContain("Ready to merge (1)");
    expect(f).toContain("Unblocks others (0)");
    expect(f).toMatch(/<option value="REVIEW" selected>REVIEW \(1\)<\/option>/);
    expect(f).toContain("READY (1)");
    expect(section((await get(port, "/?unblocks=1")).body, "items")).toContain("No items match these filters.");
  });

  it("search matches the issue number and the shown title", async () => {
    const { port } = await seeded();
    const titles = async (q: string) => rows((await get(port, q)).body).map((r) => r[2]!.replace(/<[^>]+>/g, ""));
    expect(await titles("/?q=merge")).toEqual(["Merge me"]);
    expect(await titles("/?q=MERGE%20ME")).toEqual(["Merge me"]);
    expect(await titles("/?q=%235")).toEqual(["o/r#5"]);
    expect(await titles("/?q=4")).toEqual(["Running item"]);
    expect(await titles("/?q=nothing-like-this")).toEqual([]);
    expect(section((await get(port, "/?q=merge")).body, "filters")).toContain(`value="merge"`);
  });

  it("a withheld title can be neither found nor shown in a title attribute", async () => {
    const { port, store } = await seeded();
    await setTitle(store, 7, `leak ${SECRET} here`);
    const all = (await get(port, "/")).body;
    expect(all).not.toContain(SECRET);
    expect(section(all, "items")).toContain("[withheld: github_token]");
    expect(rows((await get(port, "/?q=leak")).body)).toEqual([]);
    expect(rows((await get(port, "/?q=%237")).body)).toHaveLength(1); // still found by its number
  });

  it("long titles are cut with an ellipsis and keep their full text in a title attribute", async () => {
    const { port, store } = await seeded();
    const long = `A ${"very ".repeat(40)}long title`;
    await setTitle(store, 8, long);
    const row = rows((await get(port, "/?q=%238")).body)[0]!;
    expect(row[2]).toContain('class="title"');
    expect(row[2]).toContain(`title="${long}"`);
    expect(row[2]).toContain("…");
  });

  it("an unknown filter value is a 400", async () => {
    const { port } = await seeded();
    for (const q of ["stage=BOGUS", "state=bogus", "tier=9", "kind=deploy", "unblocks=2", "closed=yes"]) {
      const res = await get(port, `/?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body).not.toContain("Merge me");
    }
  });
});

describe("ui: page shell, script and CSP", () => {
  const inline = (body: string, tag: string) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
    return `sha256-${createHash("sha256").update(m![1]!, "utf8").digest("base64")}`;
  };

  it("the CSP allows only the page's own inline script and style by hash, same-origin fetch and GET forms", async () => {
    const { port, items } = await seeded();
    for (const path of ["/", `/items/${items.done.id}`]) {
      const page = await get(port, path);
      const csp = String(page.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain(`script-src '${inline(page.body, "script")}'`);
      expect(csp).toContain(`style-src '${inline(page.body, "style")}'`);
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(page.headers["cache-control"]).toBe("no-store");
    }
  });

  it("no script, style, image or frame loads from anywhere, and no element has a style attribute", async () => {
    const { port } = await seeded();
    const { body } = await get(port, "/");
    expect(body).not.toMatch(/\bsrc=/i);
    expect(body).not.toMatch(/<link\b/i);
    expect(body).not.toMatch(/\bstyle="/i);
    expect(body).not.toMatch(/<(iframe|img|object|embed)\b/i);
  });

  it("has a GET filter form with labelled controls, a refresh button with an aria-label, and a noscript Refresh link", async () => {
    const { port } = await seeded();
    const { body } = await get(port, "/?stage=READY&q=spec");
    expect(body).toContain(`<form class="filters" method="get" action="/">`);
    for (const id of ["f-q", "f-state", "f-stage", "f-tier", "f-kind", "f-unblocks", "f-closed"]) {
      expect(body, id).toContain(`for="${id}"`);
      expect(body, id).toContain(`id="${id}"`);
    }
    expect(body).toMatch(/<button type="button" id="refresh" aria-label="Refresh now"[^>]* hidden>/);
    expect(body).toContain(`<noscript><a href="/?stage=READY&amp;q=spec">Refresh</a></noscript>`);
    expect(body).toContain(`updated <span id="ago">0s</span> ago`);
    expect(body).toMatch(/<header class="top">/);
    expect(body).toMatch(/<main>/);
    expect(body).toMatch(/<th scope="col">/);
    expect(body).toMatch(/<th scope="row">/);
  });

  it("the script polls every 5 s, pauses while the tab is hidden, and swaps only changed sections", async () => {
    const { port } = await seeded();
    const script = /<script>([\s\S]*?)<\/script>/.exec((await get(port, "/")).body)![1]!;
    expect(() => new Function(script)).not.toThrow(); // parses as JavaScript
    expect(script).toContain("PERIOD=5000");
    expect(script).toContain("visibilitychange");
    expect(script).toContain("document.hidden");
    expect(script).toContain('querySelectorAll("main > section[id]")');
    expect(script).toContain("cur.innerHTML!==s.innerHTML");
    expect(script).toContain("scrollTo");
    expect(script).toContain('classList.add("changed")');
  });

  it("the CSS has theme tokens, a dark theme, tabular numbers, a short opacity flash and none for reduced motion", async () => {
    const { port } = await seeded();
    const css = /<style>([\s\S]*?)<\/style>/.exec((await get(port, "/")).body)![1]!;
    expect(css).toMatch(/:root\{--bg:/);
    expect(css).toContain("--radius:");
    expect(css).toContain("--sp1:");
    expect(css).toContain("@media (prefers-color-scheme:dark)");
    expect(css).toContain("font-variant-numeric:tabular-nums");
    expect(css).toMatch(/tr\.changed\{animation:flash (\d+)ms/);
    expect(Number(/tr\.changed\{animation:flash (\d+)ms/.exec(css)![1])).toBeLessThanOrEqual(200);
    expect(css).toMatch(/@keyframes flash\{from\{opacity:[^}]*\}to\{opacity:1\}\}/);
    expect(css).toContain("@media (prefers-reduced-motion:reduce){tr.changed{animation:none}}");
    expect(css).toContain(".scroll{overflow-x:auto");
    expect(css).toContain("text-overflow:ellipsis");
  });

  it("rows carry a key and a signature, so the script can highlight the ones that changed", async () => {
    const { port, items } = await seeded();
    const list = section((await get(port, "/")).body, "items");
    expect(list).toMatch(new RegExp(`data-key="${items.merging.id}" data-sig="\\d+:ready_to_merge:none"`));
    expect(list).toMatch(new RegExp(`data-key="${items.running.id}" data-sig="\\d+:stuck:running"`));
  });
});

describe("ui: factory status banner", () => {
  const status = (over: Partial<FactoryStatus>): FactoryStatus => ({
    state: "running", rev: "aaaaaaa1111", target_rev: null, child_pid: 4242, since: "2026-01-01T00:00:00.000Z", workers: 10, ...over,
  });

  it("while draining, says new runs are paused, counts the old process's in-flight runs, and when settings apply", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system);
    await store.transition({ id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: "i" } });
    await store.claimRun({ worker_id: "host:4242:3" as never, kinds: ["implement"], lease_ms: LEASE });
    const port = await startOn(store, clock, async () => status({ state: "draining", target_rev: "bbbbbbb2222", since: clock.now().toISOString() }));
    const banner = section((await get(port, "/")).body, "factory");
    expect(banner).toContain("Updating to bbbbbbb: new runs are paused.");
    expect(banner).toContain("its 1 in-flight run finish");
    expect(banner).toContain("starts with 10 workers");
    expect(banner).toContain("Code and settings changes apply when the new revision starts.");
  });

  it("running, build failure and a stopped factory each say so; no status function shows no banner", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const running = section((await get(await startOn(store, clock, async () => status({})), "/")).body, "factory");
    expect(running).toContain("Factory running.");
    expect(running).toContain("10 workers");
    const failed = section((await get(await startOn(store, clock, async () => status({ state: "build_failed", target_rev: "ccccccc" })), "/")).body, "factory");
    expect(failed).toContain("failed to build");
    expect(section((await get(await startOn(store, clock, async () => null), "/")).body, "factory")).toContain("Factory stopped.");
    expect((await get(await startOn(store, clock), "/")).body).not.toContain('<section id="factory">');
  });

  it("reads the status file; a dead child pid reads as stopped; a missing file as null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-ui-status-"));
    const file = join(dir, "supervisor.json");
    expect(await readFactoryStatus(file, 3)).toBeNull();
    writeFileSync(file, JSON.stringify({ state: "draining", rev: "a", target_rev: "b", child_pid: 99, since: "x" }));
    expect(await readFactoryStatus(file, 3, () => true)).toMatchObject({ state: "draining", workers: 3 });
    expect(await readFactoryStatus(file, 3, () => false)).toMatchObject({ state: "stopped", child_pid: null });
  });
});
