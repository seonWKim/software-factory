// The read-only JSON API under /api/v1 (design §9): its contract, its request guards, that it lists the same
// rows as the HTML page, that store text leaves only through the Withholder, and that it never writes.
// Everything goes through respond(), the server's whole request handling without a socket.

import { describe, expect, it, vi } from "vitest";
import { QUEUED_RUN } from "../src/core/commands.js";
import type { AuthDecision } from "../src/interfaces/auth-provider.js";
import type { Timestamp, UserId, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, wire } from "../src/ui/server.js";
import { type FileKeysView, type UiSettings, fileKeysOf, newCsrfToken, writeSettings } from "../src/ui/settings-api.js";
import type { ConfigEditRequest, ConfigEditResult } from "../src/core/config-writer.js";
import { type PauseDeps, resumePause } from "../src/ui/pause-api.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";
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
    expect(list.items.filter((i) => i.item_phase !== "closed")).toHaveLength(open);
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

  it("returns the filter counts the page's options show", async () => {
    const { d } = await seeded();
    const api = await json<{ facets: { allStates: number; state: Record<string, number>; stage: Record<string, number> } }>(d, "/api/v1/items");
    expect(api.facets.state.needs).toBe(3);
    // The closed item counts under Closed though the default list leaves it out (same rule as every facet).
    expect(api.facets.stage.CLOSED).toBe(1);
    expect(api.facets.state.closed).toBe(1);
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
