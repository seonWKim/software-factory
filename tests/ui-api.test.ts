// The read-only JSON API under /api/v1 (design §9): its contract, its request guards, that it lists the same
// rows as the HTML page, that store text leaves only through the Withholder, and that it never writes.
// Everything goes through respond(), the server's whole request handling without a socket.

import { describe, expect, it, vi } from "vitest";
import { QUEUED_RUN } from "../src/core/commands.js";
import type { AuthDecision } from "../src/interfaces/auth-provider.js";
import type { Timestamp, UserId, WorkItem, WorkItemId } from "../src/core/types.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { stateLabel } from "../src/shared/states.js";
import { type UiDeps, respond, wire } from "../src/ui/server.js";
import { type FileKeysView, type UiSettings, fileKeysOf, newCsrfToken, storeProjectResolver, writeSettings } from "../src/ui/settings-api.js";
import { saveProjectLabel } from "../src/core/project-labels.js";
import { localProjectKey } from "../src/core/project.js";
import { PROJECT } from "./helpers/fakes/config.js";
import type { ConfigEditRequest, ConfigEditResult } from "../src/core/config-writer.js";
import { type PauseDeps, resumePause } from "../src/ui/pause-api.js";
import { OTHER_PROJECT_KEY, issue, newStore, system, w1 } from "./helpers/store.js";
import { LEASE, SECRET, ROUTES, get, json, make, patch, enqueue, seeded } from "./ui-api-fixtures.js";

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
  it("Work and Activity give one running count (runs with status running) and one open count (stage not CLOSED)", async () => {
    const { d, store } = await seeded();
    const o = await json<{ open: number; running: number; stages: Record<string, number> }>(d, "/api/v1/overview");
    const list = await json<{ counts: { open: number; running: number }; items: { item_phase: string }[] }>(d, "/api/v1/items?closed=1");
    const runs = await json<{ runs: { status: string }[] }>(d, "/api/v1/runs");
    // Running: every run whose status is running, on both pages, even when a stale heartbeat ranks its item stuck.
    expect(list.counts.running).toBe(3);
    expect(o.running).toBe(list.counts.running);
    expect(runs.runs.filter((r) => r.status === "running")).toHaveLength(list.counts.running);
    // Open: every item whose stage is not CLOSED (owner answer 2), the overview's and the list's alike.
    const open = (await store.listWorkItemsWhere({ exclude_closed: true, limit: 1000 })).length;
    expect(list.counts.open).toBe(open);
    expect(o.open).toBe(list.counts.open);
    expect(list.items.filter((i) => !["merged", "closed", "rejected"].includes(i.item_phase))).toHaveLength(open);
  });

  it("system items are left out of the list, its facet counts and Open items", async () => {
    const { d, store } = await seeded();
    const before = await json<{ counts: { open: number }; total: number; facets: { allStates: number } }>(d, "/api/v1/items");
    const sys = await store.createWorkItem({ ...issue(9001), hold: { blocked_on: "upstream", blocked_reason: "system_item" } }, system);
    const after = await json<{ counts: { open: number }; total: number; facets: { allStates: number }; items: { id: string }[] }>(d, "/api/v1/items");
    expect(after.items.map((i) => i.id)).not.toContain(sys.item.id);
    expect(after.total).toBe(before.total);
    expect(after.facets.allStates).toBe(before.facets.allStates);
    expect(after.counts.open).toBe(before.counts.open);
    expect((await json<{ open: number }>(d, "/api/v1/overview")).open).toBe(before.counts.open);
  });

  it("the default list has every open item ranked, and the filters narrow it", async () => {
    const { d, items } = await seeded();
    const all = await json<{ items: { id: string; item_phase: string; reason_code: string; stage: string; run_status: string | null }[] }>(d, "/api/v1/items");
    expect(all.items.length).toBe(8); // nine items, one closed
    expect(all.items[0]).toMatchObject({ id: items.merge.id, item_phase: "ready_to_merge", reason_code: "merge_pending", stage: "REVIEW" });
    expect(all.items[1]).toMatchObject({ id: items.approve.id, item_phase: "needs_approval", reason_code: "spec_pending" });
    const needs = await json<{ items: { id: string }[] }>(d, "/api/v1/items?state=needs");
    expect(needs.items.map((i) => i.id)).toEqual([items.merge.id, items.approve.id, items.secretive.id]);
    const closed = await json<{ items: { id: string }[] }>(d, "/api/v1/items?stage=CLOSED");
    expect(closed.items.map((i) => i.id)).toEqual([items.done.id]);
    const kind = await json<{ items: { id: string; run_status: string | null }[] }>(d, "/api/v1/items?kind=review");
    expect(kind.items).toMatchObject([{ id: items.running2.id, run_status: "running" }]);
  });

  it("each row carries state_label, the state table's label for its item_phase, in every group", async () => {
    const { d, store, items } = await seeded();
    const waiting = await make(store, 60, "Waits on a phase");
    await patch(store, waiting, { blocked_on: "upstream", blocked_reason: "phase_hold" });
    const failed = await make(store, 61, "Failed run");
    await patch(store, failed, { stage: "RUNNING", blocked_on: "human", blocked_reason: "run_failed:implement:agent_error" });
    const list = await json<{ items: { id: string; item_phase: string; state_label: string }[] }>(d, "/api/v1/items?closed=1");
    const label = (id: string) => list.items.find((i) => i.id === id)!.state_label;
    expect(label(items.merge.id)).toBe("Ready to merge"); // Needs you
    expect(label(items.queued.id)).toBe("Queued"); // Active
    expect(label(waiting.id)).toBe("Blocked by another task"); // Waiting
    expect(label(failed.id)).toBe("Failed"); // Problem
    expect(label(items.done.id)).toBe("Merged"); // Finished
    for (const i of list.items) expect(i.state_label, i.id).toBe(stateLabel(i.item_phase));
  });

  it("returns the filter counts the page's options show", async () => {
    const { d } = await seeded();
    const api = await json<{ facets: { allStates: number; state: Record<string, number>; stage: Record<string, number> } }>(d, "/api/v1/items");
    expect(api.facets.state.needs).toBe(3);
    // The closed item counts under Closed though the default list leaves it out (same rule as every facet).
    expect(api.facets.stage.CLOSED).toBe(1);
    expect(api.facets.state.closed).toBe(1);
    expect(api.facets.state.finished).toBe(1);
    expect(api.facets.state.merged).toBe(1);
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
    // The run fields as before, plus attempts and the test-slot wait flag.
    for (const r of body.runs) {
      expect(Object.keys(r)).toEqual(["id", "kind", "status", "attempt", "started_at", "finished_at", "created_at", "tokens", "error", "attempts", "waiting_for_slot"]);
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

describe("ui api: the item's request and spec (About on the item page)", () => {
  /** A fake scanner: flags any text with FLAGME under the rule fake_rule, nothing else. */
  const scanner: EgressScanner = {
    scan: async (channel, text) => (text.includes("FLAGME") ? { clean: false, findings: [{ rule: "fake_rule", channel }] } : { clean: true }),
  };
  type About = { item: { request: string | null; spec: { problem: string; desired_output: string | null; done_criteria: string[] } | null } };
  /** A fake store's item: the stored fields given here over a seeded item's, read as an existing item is (no migration). */
  async function about(fields: Partial<WorkItem>) {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const it0 = await make(store, 60, "About me");
    const faked = new Proxy(store, {
      get(target, key) {
        if (key === "getWorkItem") return async (id: WorkItemId) => { const it = await target.getWorkItem(id); return it && { ...it, ...fields }; };
        const v = Reflect.get(target, key) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const d: UiDeps = { store: faked, scanner, clock, lease_ms: LEASE, health: new HealthMonitor(async () => [], clock) };
    return { body: await json<About>(d, `/api/v1/items/${encodeURIComponent(it0.id)}`), list: await json<{ items: Record<string, unknown>[] }>(d, "/api/v1/items") };
  }

  it("a request with an approved spec: the body's first paragraph and the problem, output and each criterion", async () => {
    const { body } = await about({
      title: "Item page shows what the work is about",
      issue_text: "Item page shows what the work is about\n\nThe item page says\nwhat the work is about.\n\nDone when: it shows.",
      problem: "The page shows no text.", desired_output: "An About card.", done_criteria: ["About shows", "Spec collapses"],
    });
    expect(body.item.request).toBe("The item page says\nwhat the work is about.");
    expect(body.item.spec).toEqual({ problem: "The page shows no text.", desired_output: "An About card.", done_criteria: ["About shows", "Spec collapses"] });
  });

  it("a request with no approved spec (done_criteria null): the request only, spec null", async () => {
    const { body } = await about({ issue_text: "Just a request", problem: "Draft spec", done_criteria: null });
    expect(body.item).toMatchObject({ request: "Just a request", spec: null });
  });

  it("a spec without a request (issue_text null or empty): request null, the spec as stored", async () => {
    for (const issue_text of [null, ""]) {
      const { body } = await about({ issue_text, problem: "P", desired_output: null, done_criteria: ["C"] });
      expect(body.item).toMatchObject({ request: null, spec: { problem: "P", desired_output: null, done_criteria: ["C"] } });
    }
  });

  it("a flagged text is withheld whole, each criterion on its own; the list rows get no request or spec", async () => {
    const { body, list } = await about({
      issue_text: "Request FLAGME text\n\nmore", problem: "Problem FLAGME", desired_output: "Output", done_criteria: ["Clean one", "Leaky FLAGME", "Clean two"],
    });
    expect(body.item.request).toBe("[withheld: fake_rule]");
    expect(body.item.spec).toEqual({ problem: "[withheld: fake_rule]", desired_output: "Output", done_criteria: ["Clean one", "[withheld: fake_rule]", "Clean two"] });
    expect(JSON.stringify(body)).not.toContain("FLAGME");
    for (const row of list.items) {
      expect(row).not.toHaveProperty("request");
      expect(row).not.toHaveProperty("spec");
    }
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

describe("POST /api/v1/pauses/resume: the refusal (design 05-restarts)", () => {
  it("a 403 names the dashboard's Resume now in Needs you on Tasks first, `factory resume <name>` after, and ends nothing", async () => {
    const { store, clock } = await newStore();
    const until = new Date(clock.now().getTime() + 60_000).toISOString() as Timestamp;
    await store.pauseClaims(until, "rate_limit");
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const pauses = { principal: async () => "local:other" as UserId, authorize: async () => ({ allow: false, reason: "not_owner" }) as AuthDecision, csrfToken: "t", log };
    const r = await resumePause({ store } as unknown as PauseDeps, pauses, { name: "rate_limit" });
    expect(r.status).toBe(403);
    const error = (r.value as { error: string }).error;
    expect(error).toContain("Resume now in Needs you on Tasks");
    expect(error).not.toContain("the Status page (/app/)");
    expect(error.indexOf("Needs you")).toBeLessThan(error.indexOf("factory resume rate_limit"));
    expect(await store.getClaimPause("rate_limit")).toBe(until);
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("ui api: an Approve whose run the controller has not queued yet (design 09-dashboard-item-commands)", () => {
  it("is queued, never Stuck, in the list and on the item page at 0.3 s, 1.5 s and 5 s; an idle item with no pending Approve stays Stuck", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const approved = await make(store, 1, "Approved");
    // The request path's approval: the new state, with the run it leaves to the controller (QUEUED_RUN), and no run yet.
    await store.transition({
      id: approved.id, expected_version: approved.version, patch: { stage: "RUNNING" }, actor: system, reason: "spec_approved",
      detail: { [QUEUED_RUN]: JSON.stringify({ kind: "implement", idempotency_key: "k1" }) },
    });
    const idle = await make(store, 2, "Idle");
    await patch(store, idle, { stage: "RUNNING" });
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: LEASE, health: new HealthMonitor(async () => [], clock) };
    const phase = async (id: WorkItemId) => ({
      list: (await json<{ items: { id: string; item_phase: string }[] }>(d, "/api/v1/items")).items.find((i) => i.id === id)!.item_phase,
      page: (await json<{ item: { item_phase: string } }>(d, `/api/v1/items/${encodeURIComponent(id)}`)).item.item_phase,
    });
    let at = 0;
    for (const t of [300, 1500, 5000]) {
      clock.advance(t - at);
      at = t;
      expect(await phase(approved.id)).toEqual({ list: "queued", page: "queued" });
    }
    expect(await phase(idle.id)).toEqual({ list: "stuck", page: "stuck" });
  });
});

describe("GET /api/v1/tasks/preview: the quick-add preview (design 09-dashboard-tasks)", () => {
  /** A store whose every write throws, so the preview provably writes nothing. */
  async function readOnly() {
    const clock = new FakeClock(new Date("2026-11-12T09:00:00"));
    const { store } = await newStore(clock);
    const guarded = new Proxy(store, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver) as unknown;
        if (typeof key === "string" && /^(add|update|set|complete|delete|reopen|create|transition|save|pause)/.test(key)) {
          return () => { throw new Error(`the preview wrote: ${key}`); };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const d: UiDeps = { store: guarded, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: LEASE, health: new HealthMonitor(async () => [], clock) };
    return { d, store };
  }
  const preview = (words: string) => `/api/v1/tasks/preview?words=${encodeURIComponent(words)}`;

  it("answers what quick add would store, with the date resolved, and the words it did not read", async () => {
    const { d, store } = await readOnly();
    const v = await json(d, preview("review PRs every week +backend tomorrow 09:00 !2"));
    expect(v).toEqual({
      ok: true, title: "review PRs every week", due_date: "2026-11-13", due_time: "09:00", recurrence: null, projects: ["backend"], priority: 2,
      list: null, duration_minutes: null, unread: ["every week"],
    });
    expect(await store.listTasks(10)).toEqual([]);
  });

  it("words the parser refuses answer 200 with the reason; no words or too many answer 400", async () => {
    const { d } = await readOnly();
    expect(await json(d, preview("standup 13pm"))).toEqual({ ok: false, reason: expect.stringContaining("not a time: 13pm") });
    expect((await get(d, "/api/v1/tasks/preview")).status).toBe(400);
    expect((await get(d, preview("x".repeat(1001)))).status).toBe(400);
  });

  it("the title leaves through the Withholder", async () => {
    const { d } = await readOnly();
    const r = await get(d, preview(`call ${SECRET} tomorrow`));
    expect(r.status).toBe(200);
    expect(r.body).not.toContain(SECRET);
  });
});

describe("ui api: Changes tab, Re-check and the overlap note (design 09-dashboard-item, 09-dashboard-tasks)", () => {
  const HOST = "127.0.0.1:4310";
  const TOKEN = newCsrfToken();
  const HEAD = "a".repeat(40), BASE = "b".repeat(40);
  const MERGE_PENDING = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" } as const;
  const DIFF = "diff --git a/src/a.ts b/src/a.ts\n+one\n";

  /** The seeded API with a fake readChanges (no git): it records each call and answers from `files` and `base_at`. */
  async function setup() {
    const s = await seeded();
    const calls: Record<string, unknown>[] = [];
    const state = { base_at: "2026-01-01T00:00:00.000Z", patch: DIFF, truncated: false, fail: false };
    s.d.commands = { actor: "github:7" as UserId, source: "config", token: TOKEN };
    s.d.changes = async (spec) => {
      calls.push({ ...spec });
      if (state.fail) throw new Error("git diff failed: bad object");
      const base = { sha: BASE, committed_at: state.base_at };
      if (spec.head_sha === undefined) return { base, files: [], patch: null };
      const files = [{ path: "src/a.ts", added: 1, removed: 0 }, { path: `leak-${SECRET}.txt`, added: 2, removed: 3 }, { path: "bin.dat", added: null, removed: null }];
      return { base, files, patch: spec.path === undefined ? null : { text: state.patch, truncated: state.truncated } };
    };
    return { ...s, calls, state };
  }

  const post = (d: UiDeps, path: string, o: { token?: string; origin?: string } = {}) =>
    respond(d, { method: "POST", url: path, host: HOST, origin: o.origin ?? `http://${HOST}`, contentType: "application/json", csrfToken: o.token ?? TOKEN, body: "{}" });

  it("lists a ready item's changed files with their counts for the head its merge check stored, each path through the scanner", async () => {
    const { d, store, items, calls } = await setup();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: HEAD, base_sha: BASE });
    expect((await json<{ item: { has_changes: boolean } }>(d, `/api/v1/items/${items.merge.id}`)).item.has_changes).toBe(true);
    const body = await json<{ head_sha: string; files: { path: string; added: number | null; removed: number | null }[] }>(d, `/api/v1/items/${items.merge.id}/changes`);
    expect(body.head_sha).toBe(HEAD);
    expect(body.files).toEqual([
      { path: "src/a.ts", added: 1, removed: 0 },
      { path: expect.stringMatching(/^\[withheld: /), added: 2, removed: 3 },
      { path: "bin.dat", added: null, removed: null },
    ]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(calls).toContainEqual({ head_sha: HEAD });
  });

  it("reads one file's diff with the 256 KiB limit; a truncated diff says so; a diff with a finding is withheld and its row stays", async () => {
    const { d, store, items, calls, state } = await setup();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: HEAD, base_sha: BASE });
    const url = `/api/v1/items/${items.merge.id}/changes?path=${encodeURIComponent("src/a.ts")}`;
    const file = (await json<{ file: Record<string, unknown> }>(d, url)).file;
    expect(file).toEqual({ path: "src/a.ts", diff: DIFF, withheld: false, truncated: false });
    expect(calls.at(-1)).toEqual({ head_sha: HEAD, path: "src/a.ts", max_bytes: 256 * 1024 });
    state.truncated = true;
    expect((await json<{ file: { truncated: boolean } }>(d, url)).file.truncated).toBe(true);
    state.patch = `+token = ${SECRET}\n`;
    const leaked = await json<{ files: { path: string }[]; file: { diff: string; withheld: boolean } }>(d, url);
    expect(leaked.file.withheld).toBe(true);
    expect(leaked.file.diff).toMatch(/^\[withheld: /);
    expect(leaked.files.map((f) => f.path)).toContain("src/a.ts");
    expect(JSON.stringify(leaked)).not.toContain(SECRET);
    expect((await get(d, `/api/v1/items/${items.merge.id}/changes?path=nope.ts`)).status).toBe(404);
  });

  it("an item with a branch that is not ready shows Changes from its last head; an item with no branch, or no sandbox read, has none", async () => {
    const { d, store, items } = await setup();
    await store.recordPrHead({ id: items.approve.id, expected_head: null, head_sha: "c".repeat(40), manual: null });
    expect((await json<{ item: { has_changes: boolean } }>(d, `/api/v1/items/${items.approve.id}`)).item.has_changes).toBe(true);
    expect((await json<{ head_sha: string }>(d, `/api/v1/items/${items.approve.id}/changes`)).head_sha).toBe("c".repeat(40));
    expect((await json<{ item: { has_changes: boolean } }>(d, `/api/v1/items/${items.done.id}`)).item.has_changes).toBe(false);
    expect((await get(d, `/api/v1/items/${items.done.id}/changes`)).status).toBe(404);
    delete d.changes;
    expect((await json<{ item: { has_changes: boolean } }>(d, `/api/v1/items/${items.approve.id}`)).item.has_changes).toBe(false);
    expect((await get(d, `/api/v1/items/${items.approve.id}/changes`)).status).toBe(404);
  });

  it("a git error answers 404, never the error text", async () => {
    const { d, store, items, state } = await setup();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: HEAD, base_sha: BASE });
    state.fail = true;
    const r = await get(d, `/api/v1/items/${items.merge.id}/changes`);
    expect(r.status).toBe(404);
    expect(r.body).not.toContain("bad object");
  });

  it("offers Re-check when the stored check is older than the base's last commit, and not when it is newer", async () => {
    const { d, store, items, clock, state } = await setup();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: HEAD, base_sha: BASE });
    const recheck = async () => (await json<{ item: { merge_check: { recheck?: boolean } } }>(d, `/api/v1/items/${items.merge.id}`)).item.merge_check.recheck ?? false;
    state.base_at = new Date(clock.now().getTime() - 60_000).toISOString();
    expect(await recheck()).toBe(false);
    state.base_at = new Date(clock.now().getTime() + 60_000).toISOString();
    expect(await recheck()).toBe(true);
  });

  it("Re-check removes the stored check behind the CSRF check; the card then reads checking; no item field or version changes", async () => {
    const { d, store, items } = await setup();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: HEAD, base_sha: BASE });
    const before = (await store.getWorkItem(items.merge.id))!;
    const changes = (await store.listStateChanges(items.merge.id)).length;
    const path = `/api/v1/items/${items.merge.id}/merge-check/recheck`;
    expect((await post(d, path, { token: "stale" })).status).toBe(403);
    expect((await post(d, path, { origin: "http://evil.example" })).status).toBe(403);
    expect(await store.getMergeCheck(items.merge.id)).not.toBeNull();
    const r = await post(d, path);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ work_item_id: items.merge.id, cleared: true });
    expect(await store.getMergeCheck(items.merge.id)).toBeNull();
    const card = (await json<{ item: { merge_check: { state: string; recheck?: boolean } } }>(d, `/api/v1/items/${items.merge.id}`)).item.merge_check;
    expect(card.state).toBe("checking");
    expect(card.recheck).toBeUndefined(); // offered only when true
    const after = (await store.getWorkItem(items.merge.id))!;
    expect([after.stage, after.blocked_on, after.blocked_reason, after.version]).toEqual([before.stage, before.blocked_on, before.blocked_reason, before.version]);
    expect(await store.listStateChanges(items.merge.id)).toHaveLength(changes);
    expect((await post(d, "/api/v1/items/wi_nope/merge-check/recheck")).status).toBe(404);
  });

  it("Re-check runs no git read in the request", async () => {
    const { d, store, items, calls } = await setup();
    await store.recordMergeCheck({ work_item_id: items.merge.id, mergeable: true, conflicts: [], head_sha: HEAD, base_sha: BASE });
    expect((await post(d, `/api/v1/items/${items.merge.id}/merge-check/recheck`)).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("notes each ready item's overlap with another ready item by exact shared path, from pr_files only", async () => {
    const { d, store, items } = await setup();
    await patch(store, items.merge, { pr_files: ["src/a.ts", "src/b.ts"] });
    const other = await patch(store, await make(store, 50, "Other ready"), { ...MERGE_PENDING, pr_files: ["src/a.ts", "src/dir/c.ts"] });
    const sameDir = await patch(store, await make(store, 51, "Same dir only"), { ...MERGE_PENDING, pr_files: ["src/dir/d.ts"] });
    await patch(store, items.approve, { pr_files: ["src/b.ts"] }); // not ready: no note
    const rows = (await json<{ items: { id: string; overlaps?: unknown[] }[] }>(d, "/api/v1/items")).items;
    const of = (id: string) => rows.find((r) => r.id === id)!.overlaps;
    expect(of(items.merge.id)).toEqual([{ id: other.id, title: "Other ready", source_id: other.source.id, paths: ["src/a.ts"] }]);
    expect(of(other.id)).toEqual([{ id: items.merge.id, title: "Merge me", source_id: items.merge.source.id, paths: ["src/a.ts"] }]);
    expect(of(sameDir.id)).toEqual([]);
    expect(of(items.approve.id)).toEqual([]);
  });
});

describe("ui api: rank reason, held asks and review_time (design 09-status-page)", () => {
  const ORIGIN = "http://127.0.0.1:4310";
  const WORDS = /^(Merge|Blocks another item|Held until \d\d:\d\d|Waiting for you)$/;
  type Row = { id: string; item_phase: string; rank_reason?: string; held?: boolean };
  type Overview = { needs_you: number; system_actions: unknown[] };

  /** The seeded store (a spec to approve, a merge, a custom ask) with settings, its clock at 08:00 local time. */
  async function setup() {
    const s = await seeded();
    await saveProjectLabel(s.store, PROJECT);
    const now = s.clock.now();
    const eight = new Date(now);
    eight.setHours(8, 0, 0, 0);
    if (eight.getTime() <= now.getTime()) eight.setDate(eight.getDate() + 1);
    s.clock.advance(eight.getTime() - now.getTime());
    const settings: UiSettings = {
      base: { file: {}, layers: { defaults: {}, projects: {} } }, repo: { owner: "o", name: "r" }, actor: "local:owner",
      resolveProject: storeProjectResolver(s.store, { owner: "o", name: "r" }), csrfToken: newCsrfToken(),
    };
    return { ...s, d: { ...s.d, settings } as UiDeps };
  }
  const post = (d: UiDeps, body: unknown) =>
    respond(d, { method: "POST", url: "/api/v1/settings", host: "127.0.0.1:4310", origin: ORIGIN, contentType: "application/json", csrfToken: d.settings!.csrfToken, body: JSON.stringify(body) });
  const setReviewTime = async (d: UiDeps, value: string) => expect((await post(d, { action: "set", key: "review_time", value: JSON.stringify(value) })).status).toBe(200);
  const rows = async (d: UiDeps) => (await json<{ items: Row[] }>(d, "/api/v1/items")).items;

  it("before review_time the overview counts the waiting merges and system actions only; with review_time empty every ask counts", async () => {
    const { d } = await setup();
    // Default 09:00, the clock at 08:00: the spec approval and the custom ask are held, the merge is not.
    let o = await json<Overview>(d, "/api/v1/overview");
    expect(o.needs_you).toBe(1 + o.system_actions.length);
    await setReviewTime(d, "");
    o = await json<Overview>(d, "/api/v1/overview");
    expect(o.needs_you).toBe(3 + o.system_actions.length);
    await setReviewTime(d, "07:30"); // past it: nothing is held
    o = await json<Overview>(d, "/api/v1/overview");
    expect(o.needs_you).toBe(3 + o.system_actions.length);
  });

  it("each ask row carries rank_reason in fixed words and held; a merge is never held; a row that asks nothing has neither", async () => {
    const { d, items } = await setup();
    let list = await rows(d);
    const of = (id: string) => list.find((r) => r.id === id)!;
    expect(of(items.merge.id)).toMatchObject({ rank_reason: "Merge", held: false });
    expect(of(items.approve.id)).toMatchObject({ rank_reason: "Held until 09:00", held: true });
    expect(of(items.secretive.id)).toMatchObject({ rank_reason: "Held until 09:00", held: true });
    expect(of(items.running.id)).not.toHaveProperty("rank_reason");
    expect(of(items.running.id)).not.toHaveProperty("held");
    await setReviewTime(d, "");
    list = await rows(d);
    expect(of(items.approve.id)).toMatchObject({ rank_reason: "Waiting for you", held: false });
    expect(of(items.merge.id)).toMatchObject({ rank_reason: "Merge", held: false });
  });

  it("10 open asks: each row has one of the fixed words", async () => {
    const { d, store } = await setup();
    for (let n = 20; n < 27; n++) await patch(store, await make(store, n, `Ask ${n}`), { blocked_on: "human", blocked_reason: n % 2 ? "max_loops" : "merge_conflict" });
    const asks = (await rows(d)).filter((r) => ["ready_to_merge", "needs_approval", "needs_you", "needs_triage"].includes(r.item_phase));
    expect(asks.length).toBeGreaterThanOrEqual(10);
    for (const r of asks) expect(r.rank_reason, r.id).toMatch(WORDS);
  });

  it("POST /api/v1/settings takes review_time as HH:MM from 00:00 to 23:59 or empty, and refuses anything else naming the key", async () => {
    const { d, store } = await setup();
    for (const ok of ["00:00", "23:59", "09:30", ""]) await setReviewTime(d, ok);
    for (const bad of ["9am", "24:00", "9:00", "09:60", "09:00-10:00"]) {
      const r = await post(d, { action: "set", key: "review_time", value: JSON.stringify(bad) });
      expect(r.status, bad).not.toBe(200);
      expect(JSON.parse(r.body).error, bad).toContain("review_time");
    }
    expect((await store.listSettingOverrides()).find((o) => o.key === "review_time")?.value).toBe('""');
  });
});

describe("ui api: unreviewed merge links (design 09-status-page)", () => {
  type Merge = { change_ref: string; change_url: string | null; checks_url: string | null; review_url: string | null; check_verdict: unknown };
  /** Every forge method fails: the read must make no forge call. */
  const forge = new Proxy({}, { get: (_t, name) => () => { throw new Error(`forge call: ${String(name)}`); } });

  it("each row carries the PR's checks and review links from the stored label and ref, no verdict, and no forge call", async () => {
    const { d, store, clock } = await seeded();
    await saveProjectLabel(store, PROJECT);
    await store.recordUnreviewedMerge({ project: PROJECT.key, change_ref: "7", merge_sha: "a".repeat(40), merger_id: null });
    clock.advance(1000);
    await store.recordUnreviewedMerge({ project: OTHER_PROJECT_KEY, change_ref: "8", merge_sha: "b".repeat(40), merger_id: null }); // no stored label
    clock.advance(1000);
    await store.recordUnreviewedMerge({ project: localProjectKey("ab".repeat(8)), change_ref: "9", merge_sha: "c".repeat(40), merger_id: null });
    const merges = (await json<{ merges: Merge[] }>({ ...d, forge } as unknown as UiDeps, "/api/v1/unreviewed-merges")).merges;
    const of = (ref: string) => merges.find((m) => m.change_ref === ref)!;
    expect(of("7")).toMatchObject({ review_url: "https://github.com/o/r/pull/7", checks_url: "https://github.com/o/r/pull/7/checks", check_verdict: null });
    for (const ref of ["8", "9"]) expect(of(ref), ref).toMatchObject({ review_url: null, checks_url: null, check_verdict: null });
  });

  it("each row carries the PR's stored title through the Withholder; a row recorded without one has null", async () => {
    const { d, store, clock } = await seeded();
    await store.recordUnreviewedMerge({ project: PROJECT.key, change_ref: "7", merge_sha: "a".repeat(40), merger_id: null, title: "Seed golden cases" });
    clock.advance(1000);
    await store.recordUnreviewedMerge({ project: PROJECT.key, change_ref: "8", merge_sha: "b".repeat(40), merger_id: null, title: `Leak ${"ghp_" + "a".repeat(36)}` });
    clock.advance(1000);
    await store.recordUnreviewedMerge({ project: PROJECT.key, change_ref: "9", merge_sha: "c".repeat(40), merger_id: null });
    const merges = (await json<{ merges: { change_ref: string; title: string | null }[] }>({ ...d, forge } as unknown as UiDeps, "/api/v1/unreviewed-merges")).merges;
    const title = (ref: string) => merges.find((m) => m.change_ref === ref)!.title;
    expect(title("7")).toBe("Seed golden cases");
    expect(title("8")).toMatch(/^\[withheld: /);
    expect(title("9")).toBeNull();
  });
});

describe("ui api: queue positions in claim order (design 05-coordination, 2026-11-22)", () => {
  type Row = { id: string; why: { params: Record<string, unknown> } | null };
  /** The queued items' positions as the Queue page, the Items list and the item page show them. */
  async function positions(d: UiDeps, ids: readonly WorkItemId[]) {
    const queue = await json<{ queue: { position: number; work_item_id: string }[] }>(d, "/api/v1/queue");
    const list = await json<{ items: Row[] }>(d, "/api/v1/items");
    const page = async (id: WorkItemId) => (await json<{ item: Row }>(d, `/api/v1/items/${encodeURIComponent(id)}`)).item.why?.params.position;
    const out = [];
    for (const id of ids) {
      out.push([queue.queue.find((q) => q.work_item_id === id)?.position, list.items.find((r) => r.id === id)?.why?.params.position, await page(id)]);
    }
    return out;
  }

  it("a merge check queued after two triage runs is position 1; Run next moves an item to 1, a later Run next ahead of it, the rest keep their order", async () => {
    const { d, store, items } = await seeded();
    const check = await make(store, 20, "Merge check");
    const cur = (await store.getWorkItem(check.id))!;
    await store.transition({ id: check.id, expected_version: cur.version, patch: {}, actor: system, reason: "x", enqueue: { kind: "merge-check", idempotency_key: "mc:20" } });
    const ids = [items.queued.id, items.queued2.id, check.id];
    // By creation time the merge check would be 3; the claim order puts it first.
    expect(await positions(d, ids)).toEqual([[2, 2, 2], [3, 3, 3], [1, 1, 1]]);
    await store.runNext(items.queued2.id);
    expect(await positions(d, ids)).toEqual([[3, 3, 3], [1, 1, 1], [2, 2, 2]]);
    await store.runNext(items.queued.id);
    expect(await positions(d, ids)).toEqual([[1, 1, 1], [2, 2, 2], [3, 3, 3]]);
  });
});
