// The JSON API under /api/v1: why an item waits, pauses, the GitHub budget, the tree and the Needs-you lists.

import { describe, expect, it, vi } from "vitest";
import { type PageAction } from "../src/ui/commands.js";
import type { AuthDecision } from "../src/interfaces/auth-provider.js";
import type { Timestamp, UserId, WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ALERT_DEDUPE_MS } from "../src/core/alarms.js";
import { UNKNOWN_FAILURE } from "../src/ui/why.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, type UiDeps } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { checkoutRevision } from "../src/ui/system-actions.js";
import viteConfig from "../web/vite.config.js";
import type { Why } from "../web/src/api.js";
import { whyText } from "../web/src/lib/format.js";
import { stateLabel } from "../src/shared/states.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";
import { LEASE, SECRET, json, make, patch, enqueue, seeded } from "./ui-api-fixtures.js";

const SAME_TIME = (other: string) => `Running at the same time as ${other}, which changes some of the same files. If they clash, you'll be asked when it merges.`;

describe("ui api: why an item waits (issue #310)", () => {
  type WhyBody = Why & { text: string };
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
    const decide = (item: WorkItem, run_id: string, decision: Decision["decision"], holder_kind: Decision["holder_kind"] = "pr", holder_work_item_id: WorkItemId | null = null) =>
      decisions.set(item.id, [{
        run_id, work_item_id: item.id, decision, holder_work_item_id, holder_ref: "#92", holder_kind,
        shared: [], cost: 4, threshold: 2.5, fallback: false, approved_by: null, at: s.clock.now().toISOString(),
      } as unknown as Decision]);
    return { ...s, decide };
  }
  // Each why with the text the web app shows for it (en.ts, one text per reason code).
  const said = (w: Why): WhyBody => ({ ...w, text: whyText(w) });
  const whyOn = async (d: UiDeps, id: string) => {
    const list = await json<{ items: { id: string; item_phase: string; reason_code: string; why: Why }[] }>(d, "/api/v1/items");
    const queue = await json<{ queue: { work_item_id: string; why: Why | null }[] }>(d, "/api/v1/queue");
    const item = await json<{ item: { why: Why } }>(d, `/api/v1/items/${encodeURIComponent(id)}`);
    const row = list.items.find((i) => i.id === id)!;
    const queued = queue.queue.find((q) => q.work_item_id === id) ?? null;
    return { row: { ...row, why: said(row.why) }, queued: queued && { ...queued, why: queued.why && said(queued.why) }, item: said(item.item.why) };
  };

  it("a held run reads 'Held behind #N' with its holder on Items, the item page and the Queue's why", async () => {
    const { d, store, decide } = await withDecisions();
    const held = await make(store, 20, "Held item");
    await enqueue(store, held, "implement", "held:i", { stage: "RUNNING" });
    const run = (await store.listRuns(held.id)).find((r) => r.kind === "implement")!;
    decide(held, run.id, "held", "pr");
    const w = await whyOn(d, held.id);
    const expected = { code: "held", text: "Held behind #92, which has an open PR", next_actor: "other_item", refs: [92], ref_url: "https://github.com/o/r/issues/" };
    expect(w.row.item_phase).toBe("held");
    expect(w.row.reason_code).toBe("held_pr");
    expect(w.row.why).toMatchObject(expected);
    expect(w.queued!.why).toMatchObject(expected);
    expect(w.item).toMatchObject(expected);
  });

  it("a dependency blocker waits (not queued) and reads the same sentence on Items, Queue and the item page", async () => {
    const { d, store } = await withDecisions();
    const dep = await make(store, 21, "Dependent item");
    await enqueue(store, dep, "implement", "dep:i", { stage: "RUNNING", blocked_on: "dependency", blocked_reason: "waiting for #12 and #13 to merge" });
    const w = await whyOn(d, dep.id);
    expect(w.row.item_phase).toBe("blocked_by_task");
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
    const other = await make(store, 92, "Other item");
    decide(items.running, claimed.id, "deadlock", "waiting", other.id);
    // The seeded run's heartbeat is stale (stuck); a fresh one is running.
    await store.heartbeat(claimed.id, claimed.lease!.token, LEASE);
    const o = await json<{ needs_you: number; system_actions: { code: string }[] }>(d, "/api/v1/overview");
    expect(o.needs_you).toBe(before);
    expect(o.system_actions.map((a) => a.code)).not.toContain("claim_deadlock");
    const w = await whyOn(d, items.running.id);
    expect(w.row.item_phase).toBe("blocked_by_task");
    expect(w.row.why.holder_id).toBe(other.id);
    const why = { code: "deadlock", text: SAME_TIME("\"Other item\""), next_actor: "factory", refs: [] };
    expect(w.row.why).toMatchObject(why);
    expect(w.item).toMatchObject(why);
    const needs = await json<{ items: { id: string }[] }>(d, "/api/v1/items?state=needs");
    expect(needs.items.map((i) => i.id)).not.toContain(items.running.id);
  });

  it("a deadlock whose holder has no work item or no title says another item", async () => {
    const { d, items, claimed, decide, store } = await withDecisions();
    decide(items.running, claimed.id, "deadlock", "pr");
    const fallback = SAME_TIME("another item");
    expect((await whyOn(d, items.running.id)).item).toMatchObject({ code: "deadlock", text: fallback });
    const untitled = await make(store, 93, null);
    decide(items.running, claimed.id, "deadlock", "waiting", untitled.id);
    expect((await whyOn(d, items.running.id)).row.why.text).toBe(fallback);
  });

  it("a merge conflict the resolve run gives up on still needs you", async () => {
    const { d, store, items } = await withDecisions();
    await patch(store, items.running, { blocked_on: "human", blocked_reason: "merge_conflict_pending" });
    expect((await whyOn(d, items.running.id)).row.item_phase).toBe("needs_you");
  });

  it("free text in why passes the Withholder", async () => {
    const { d, items } = await withDecisions();
    const w = await whyOn(d, items.secretive.id);
    for (const text of [w.row.why.text, w.item.text]) {
      expect(text).toBe("Waiting for a person: [withheld: github_token]");
      expect(text).not.toContain(SECRET);
    }
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

  type NeedRow = { id: string; item_phase: string; why: Why; need?: { reason: string | null }; commands?: { name: string; allowed: boolean; reason: string | null }[] };
  /** What the Needs-you row shows: the need's own words, else the why's en.ts text. */
  const shown = (r: NeedRow) => r.need!.reason ?? whyText(r.why);
  /** The rows that carry a need: the Needs-you group, and a failed run in the Problem group. */
  const needRows = async (d: UiDeps) => [
    ...(await json<{ items: NeedRow[] }>(d, "/api/v1/items?state=needs")).items,
    ...(await json<{ items: NeedRow[] }>(d, "/api/v1/items?state=failed")).items,
  ];

  it("each Needs-you reason is its own words, never the State label, and names what to do", async () => {
    const { d, store, items } = await seeded();
    const more: Record<string, WorkItem> = {};
    for (const [n, reason] of [[20, "run_failed:implement:diff_too_large"], [21, "max_loops"], [22, "merge_conflict_pending"], [23, "something_new"], [24, "rule_of_two"], [25, "dependency_closed:#92"], [26, null]] as const) {
      more[String(reason)] = await make(store, n, `Item ${n}`);
      await patch(store, more[String(reason)]!, { blocked_on: "human", blocked_reason: reason });
    }
    const rows = await needRows(d);
    const need = (id: string) => rows.find((r) => r.id === id)!.need!;
    // A failed item with no failed run: fixed words, never its code.
    expect(need(more["run_failed:implement:diff_too_large"]!.id).reason).toBe("The last run failed with no message.");
    const commands = (id: string) => rows.find((r) => r.id === id)!.commands!.map((c) => c.name);
    expect(commands(items.approve.id)).toEqual(["approve", "reject", "revise"]);
    expect(need(items.merge.id).reason).toBe("merge check running");
    // A reason the why says better is not sent: the row shows the why's text, as Work does.
    expect(need(more["null"]!.id).reason).toBeNull();
    expect(shown(rows.find((r) => r.id === more["null"]!.id)!)).toMatch(/^Waiting for a person: the item is new/);
    expect(shown(rows.find((r) => r.id === more["max_loops"]!.id)!)).toBe("Too many review loops: a person decides what happens next");
    for (const r of rows) {
      expect(r.need, r.id).toBeDefined();
      expect(shown(r).toLowerCase(), r.id).not.toBe(stateLabel(r.item_phase).toLowerCase());
      expect(shown(r).trim(), r.id).not.toBe("");
      expect(shown(r), r.id).not.toContain("no reason");
    }
    expect(rows.filter((r) => r.need!.reason === "The last run failed with no message.")).toHaveLength(1);
    expect(rows.map((r) => r.need!.reason ?? "").filter((t) => t.startsWith("failed: "))).toEqual([]);
  });

  it("a failed item's reason is the first line of its latest failed run's stored message, through the Withholder, cut at 80 characters", async () => {
    const { d, store, clock } = await seeded();
    const failed = async (n: number, details: string[]) => {
      const it = await make(store, n, `Failed ${n}`);
      for (const [i, detail] of details.entries()) {
        await enqueue(store, it, "implement", `f${n}:${i}`);
        const r = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
        clock.advance(1_000);
        await store.completeRun(r.id, r.lease!.token, { status: "failed", error_code: "exception", detail, infra: false });
      }
      await patch(store, it, { blocked_on: "human", blocked_reason: "run_failed:implement:exception" });
      return it;
    };
    const plain = await failed(30, ["an older failure", "no model credential in the secret file\n    at loadSecrets (secrets.ts:12)"]);
    const leaky = await failed(31, [`push failed: token ${SECRET} rejected`]);
    const long = await failed(32, ["x".repeat(200)]);
    // A failed run is in the Problem group, with its need and its commands.
    const rows = (await json<{ items: NeedRow[] }>(d, "/api/v1/items?state=problem")).items;
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(row(plain.id).need!.reason).toBe("no model credential in the secret file");
    expect(row(plain.id).commands!.map((c) => c.name)).toContain("retry");
    expect(row(leaky.id).need!.reason).not.toContain(SECRET);
    // The Withholder's cut: 80 characters and its ellipsis.
    expect(row(long.id).need!.reason).toBe(`${"x".repeat(80)}…`);
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
    // Every open row: the Needs-you group's, and the failed one in Problem.
    const rows = async () => (await json<{ items: NeedRow[] }>(d, "/api/v1/items")).items;
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
  const ALARM = `Alarm: 4 runs on several items failed the same way (${UNKNOWN_FAILURE.charAt(0).toLowerCase()}${UNKNOWN_FAILURE.slice(1, -1)})`;
  type WhyBody = Why;
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
  const whyRow = async (d: UiDeps, id: string) => whyText((await json<{ items: { id: string; why: WhyBody }[] }>(d, "/api/v1/items")).items.find((i) => i.id === id)!.why);
  const whyItem = async (d: UiDeps, id: string) => whyText((await json<{ item: { why: WhyBody } }>(d, `/api/v1/items/${encodeURIComponent(id)}`)).item.why);

  it("the overview lists an open alarm in Needs you with where to look and when it closes, and drops it once resolved", async () => {
    const { d, store, clock } = await alarmed();
    await store.setSettingOverride({ key: "review_time", project: "", value: '""', actor: "local:owner" }); // every waiting ask counts: none held until review_time
    const created = clock.now().getTime();
    const o = await overview(d);
    expect(o.system_actions).toContainEqual({
      code: "alarm", text: `${ALARM}: npm test exited #`, command: "Failures page (/app/failures)", pattern: "repeated_error", error_code: "checks_failed", until: new Date(created + ALERT_DEDUPE_MS).toISOString(),
    });
    // The failing item is Failed, in the Problem group: no Needs-you row of its own.
    expect(o.needs_you).toBe(o.system_actions.length);
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
    expect(await whyRow(d, hit.id)).toBe(`Building failed. ${UNKNOWN_FAILURE} Decide what happens next. ${ALARM}`);
    expect(await whyItem(d, hit.id)).toBe(await whyRow(d, hit.id));
    expect(await whyRow(d, other.id)).not.toContain("Alarm");
    expect(await whyItem(d, other.id)).not.toContain("Alarm");
    clock.advance(ALERT_DEDUPE_MS);
    expect(await whyRow(d, hit.id)).toBe(`Building failed. ${UNKNOWN_FAILURE} Decide what happens next`);
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
    expect(whyText(q.queue.find((x) => x.work_item_id === other.id)!.why!)).toBe(`Queued at position 1. ${restart}`);
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
    await store.setSettingOverride({ key: "review_time", project: "", value: '""', actor: "local:owner" }); // every waiting ask counts: none held until review_time
    const triage = await make(store, 40, "Unclear issue");
    await patch(store, triage, { blocked_on: "human", blocked_reason: "agent_needs_human", failure_comment_url: "https://github.com/o/r/issues/40#c1" });
    const impl = await make(store, 41, "Implement asks");
    await patch(store, impl, { stage: "RUNNING", blocked_on: "human", blocked_reason: "agent_needs_human" });
    asks.set(triage.id, "triage");
    asks.set(impl.id, "implement");
    const rows = (await json<{ items: { id: string; item_phase: string; need?: { reason: string } }[] }>(d, "/api/v1/items")).items;
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(row(triage.id)).toMatchObject({ item_phase: "needs_triage", need: { reason: ASK.question } });
    // Needs triage is in the Waiting group, not Needs you, and the overview does not count it.
    const needs = (await json<{ items: { id: string }[] }>(d, "/api/v1/items?state=needs")).items.map((r) => r.id);
    expect(needs).toContain(impl.id);
    expect(needs).not.toContain(triage.id);
    expect((await json<{ items: { id: string }[] }>(d, "/api/v1/items?state=waiting")).items.map((r) => r.id)).toContain(triage.id);
    const o = await json<{ needs_you: number; system_actions: unknown[] }>(d, "/api/v1/overview");
    expect(o.needs_you).toBe(needs.length + o.system_actions.length);
    expect(row(impl.id)).toMatchObject({ item_phase: "needs_you", need: { reason: ASK.question } });
  });

  it("the overview's needs_you counts Needs you and Needs triage items plus system actions, nothing from Blocked by another task", async () => {
    const { d, store } = await seeded();
    await store.setSettingOverride({ key: "review_time", project: "", value: '""', actor: "local:owner" }); // every waiting ask counts: none held until review_time
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
    const needs = (await json<{ items: { id: string }[] }>(d, "/api/v1/items?state=needs")).items;
    expect(needs.map((i) => i.id)).toEqual(expect.arrayContaining([budget.id, triage.id]));
    expect(needs.map((i) => i.id)).not.toContain(dep.id);
    expect(needs.map((i) => i.id)).not.toContain(phase.id);
  });
});
