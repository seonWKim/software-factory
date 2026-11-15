import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refusalText, specNotWaiting } from "../src/core/commands.js";
import { refusalReply } from "../src/core/authorize.js";
import type { LocalMergeResult, LocalMergeSpec } from "../src/core/local-merge.js";
import { APPROVED_RUN_QUEUED, MERGE_QUEUED, MERGE_REQUESTED, MERGE_RETURNED } from "../src/core/request-transition.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { AuthDecision, AuthProvider, Principal } from "../src/interfaces/auth-provider.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { FakeForge, FakeSandbox, FakeSource, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// Approve and Merge from the dashboard apply while the request is handled (design 09-dashboard-app, 2026-11-15): the
// owner check, then the controller's own store-only checks (core request-transition) and one conditional write, with
// no controller pass and no poll in between. The response carries the item's new state, or the refusal in the
// controller's words. The controller's next pass finds the transition made and does the rest once: the approval's run,
// the merge queue's checks or the forge's merge. A refused or failed merge puts the item back at merge_pending.

const OWNER = "local:owner" as UserId;
const OTHER = "local:other" as UserId;
const HOST = "127.0.0.1:4310";
const TOKEN = newCsrfToken();
const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" };
const READY: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" };

/** OWNER holds every action, nobody else does; records each action asked and the item's version at that moment. */
class Roles implements AuthProvider {
  asked: string[] = [];
  async resolve(): Promise<Principal | null> {
    return null;
  }
  async authorize(p: Principal, action: string): Promise<AuthDecision> {
    this.asked.push(action);
    return p.user_id === OWNER ? { allow: true } : { allow: false, reason: "no_role" };
  }
}

/** A sandbox that merges locally: `clashes` is what the local conflict probe finds; each merge answers merged. */
class MergingSandbox extends FakeSandbox {
  clashes: string[] = [];
  async localConflicts(): Promise<string[] | null> {
    return this.clashes;
  }
  async mergeLocal(_spec: LocalMergeSpec): Promise<LocalMergeResult> {
    return { merged: true, sha: "localmerge1", already: false, not_updated: [] };
  }
}

interface Reply {
  seq: number;
  outcome?: string;
  state?: { stage: string; blocked_on: string; blocked_reason: string | null; phase: string; label: string | null };
  refusal?: string | null;
  error?: string;
}

async function harness() {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const forge = new FakeForge();
  const sandbox = new MergingSandbox();
  const roles = new Roles();
  const controller = new ControllerRole({
    store, sources: [source, new LocalSource(store)], forge, sandbox, auth: roles, clock, config, log: silent, scanner: cleanScanner,
  });
  const system = { kind: "system" as const, id: "system:test" };
  const itemIn = async (ref: SourceRef, patch: WorkItemPatch, head: string | null = null): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: ref, requester_id: OWNER, project: PROJECT_KEY, problem: "p", resources: [] }, system);
    const r = await store.transition({ id: item.id, expected_version: item.version, actor: system, reason: "setup", patch: { tier: 2, ...patch } });
    if (!r.ok) throw new Error("setup failed");
    if (head !== null) await store.recordPrHead({ id: item.id, expected_head: null, head_sha: head, manual: null });
    return (await store.getWorkItem(item.id))!;
  };
  /** The page's deps for `actor`: the owner check asks the same auth plugin the controller asks. */
  const page = (actor: UserId): UiDeps => ({
    store, scanner: cleanScanner, clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock),
    commands: { actor, source: "config", token: TOKEN, forge: true, localMerge: true, allowed: (action) => roles.authorize({ user_id: actor, attributes: {} }, action) },
  });
  const post = async (it: WorkItem, body: unknown, actor = OWNER): Promise<Reply> => {
    const r = await respond(page(actor), {
      method: "POST", url: `/api/v1/items/${encodeURIComponent(it.id)}/commands`, host: HOST, origin: `http://${HOST}`,
      contentType: "application/json", csrfToken: TOKEN, body: JSON.stringify(body),
    });
    expect(r.status).toBe(202);
    return JSON.parse(r.body) as Reply;
  };
  const state = async (it: WorkItem) => {
    const x = (await store.getWorkItem(it.id))!;
    return { stage: x.stage, blocked_on: x.blocked_on, blocked_reason: x.blocked_reason };
  };
  const reasons = async (it: WorkItem) => (await store.listStateChanges(it.id)).map((c) => c.reason).filter((r) => r !== "intake" && r !== "setup" && r !== "pr_head");
  const runs = async (it: WorkItem) => (await store.listRuns(it.id)).map((r) => ({ kind: r.kind, status: r.status }));
  const posted = async (it: WorkItem) => (await store.listItemMessages(it.id)).filter((m) => m.marker.includes("factory:refused:")).map((m) => m.body);
  const request = (seq: number) => store.getAppCommandRequest(seq);
  return { store, clock, source, forge, sandbox, roles, controller, itemIn, post, state, reasons, runs, posted, request };
}

const localRef = (n: number): SourceRef => ({ type: "local", id: `local-${n}`, link: `local:local-${n}` });

describe("Approve applies while the request is handled", () => {
  it("a spec at the gate is RUNNING with one spec_approved change before any controller pass; the response carries that state", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const r = await h.post(it1, { command: "approve", note: "keep it small" });

    expect(await h.state(it1)).toEqual({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    expect(await h.reasons(it1)).toEqual(["spec_approved"]);
    expect(r).toMatchObject({ outcome: "applied", refusal: null, state: { stage: "RUNNING", blocked_on: "none", blocked_reason: null, phase: "implementing", label: "Approved" } });
    const [approval] = (await h.store.listStateChanges(it1.id)).filter((c) => c.reason === "spec_approved");
    // The comment path's detail: the note, the request's seq, the spec decision's standing detail; the actor is the page's user.
    expect(approval!.actor).toEqual({ kind: "user", id: OWNER });
    expect(approval!.detail).toMatchObject({ note: "keep it small", app_request: r.seq, outcome: "approved" });
    // The run waits for the controller, whose transition queues it through the Rule of Two and budget holds.
    expect(await h.runs(it1)).toEqual([]);
    expect((await h.request(r.seq))!.handled_at).toBeNull();
  });

  it("the controller's next pass queues the run once, marks the request handled and posts nothing; a later pass changes nothing", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const r = await h.post(it1, { command: "approve" });
    await h.controller.tickCommands();
    await h.controller.tickCommands();

    expect(await h.reasons(it1)).toEqual(["spec_approved", APPROVED_RUN_QUEUED]);
    expect(await h.runs(it1)).toEqual([{ kind: "implement", status: "queued" }]);
    const [run] = await h.store.listRuns(it1.id);
    expect(run!.idempotency_key).toContain(it1.id);
    expect(await h.request(r.seq)).toMatchObject({ refusal: null });
    expect((await h.request(r.seq))!.handled_at).not.toBeNull();
    expect(await h.posted(it1)).toEqual([]);
  });

  it("a double click leaves one spec_approved change: the second request is already done, not refused, and nothing is posted", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const first = await h.post(it1, { command: "approve" });
    const second = await h.post(it1, { command: "approve" });
    await h.controller.tickCommands();

    expect(first.outcome).toBe("applied");
    expect(second).toMatchObject({ outcome: "already_done", refusal: null, state: { stage: "RUNNING" } });
    expect((await h.reasons(it1)).filter((x) => x === "spec_approved")).toHaveLength(1);
    expect(await h.runs(it1)).toEqual([{ kind: "implement", status: "queued" }]);
    expect(await h.request(second.seq)).toMatchObject({ refusal: null });
    expect(await h.posted(it1)).toEqual([]);
  });

  it("two requests handled at once (two workers) leave one spec_approved change", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const both = await Promise.all([h.post(it1, { command: "approve" }), h.post(it1, { command: "approve" })]);

    expect(both.map((b) => b.outcome).sort()).toEqual(["already_done", "applied"]);
    expect((await h.reasons(it1)).filter((x) => x === "spec_approved")).toHaveLength(1);
  });

  it("a refused Approve stores no state change, answers with the controller's words, and the controller posts nothing", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), READY);
    const r = await h.post(it1, { command: "approve" });

    const words = refusalText("/approve", specNotWaiting("merge_pending"));
    expect(r).toMatchObject({ outcome: "refused", refusal: words, state: { stage: "REVIEW", blocked_reason: "merge_pending", label: null } });
    expect(await h.reasons(it1)).toEqual([]);
    expect(await h.request(r.seq)).toMatchObject({ refusal: words });
    await h.controller.tickCommands();
    expect(await h.reasons(it1)).toEqual([]);
    expect(await h.posted(it1)).toEqual([]);

    // The same request through the controller's path is refused with the same words.
    const viaController = await h.store.recordAppCommandRequest({ key: "k-controller", actor: OWNER, command: "approve", args: { work_item_id: it1.id } });
    await h.controller.tickCommands();
    expect((await h.request(viaController.request.seq))!.refusal).toBe(words);
  });

  it("the owner check runs before any write: a denied viewer gets the refusal wording and no state change", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const r = await h.post(it1, { command: "approve" }, OTHER);

    expect(h.roles.asked).toEqual(["approve_spec"]);
    expect(r).toMatchObject({ outcome: "refused", refusal: refusalText("/approve", refusalReply("no_role")), state: { blocked_reason: "spec_pending" } });
    expect(await h.reasons(it1)).toEqual([]);
    await h.controller.tickCommands();
    expect(await h.reasons(it1)).toEqual([]);
    expect(await h.posted(it1)).toEqual([]);
  });

  it("on a floor block, Approve raises the tier and clears the block at once; the controller queues the implement run", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), { stage: "RUNNING" });
    const blocked = await h.store.transition({
      id: it1.id, expected_version: it1.version, actor: { kind: "system", id: "system:test" }, reason: "floor_blocked",
      patch: { blocked_on: "human", blocked_reason: "floor_tier" }, detail: { required_tier: 4 },
    });
    if (!blocked.ok) throw new Error("setup failed");
    const r = await h.post(blocked.item, { command: "approve" });

    expect(r).toMatchObject({ outcome: "applied", state: { stage: "RUNNING", blocked_on: "none", label: "Approved" } });
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ tier: 4, blocked_on: "none", blocked_reason: null });
    await h.controller.tickCommands();
    expect(await h.runs(it1)).toEqual([{ kind: "implement", status: "queued" }]);
    expect(await h.posted(it1)).toEqual([]);
  });

  it("a note the leak scanner flags is refused before any write", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const leaky: UiDeps["scanner"] = { scan: async (channel) => ({ clean: false, findings: [{ rule: "aws_key", channel }] }) };
    const r = await respond(pageWith(h, leaky), {
      method: "POST", url: `/api/v1/items/${encodeURIComponent(it1.id)}/commands`, host: HOST, origin: `http://${HOST}`,
      contentType: "application/json", csrfToken: TOKEN, body: JSON.stringify({ command: "approve", note: "a secret" }),
    });
    expect(JSON.parse(r.body)).toMatchObject({ outcome: "refused" });
    expect((await h.request((JSON.parse(r.body) as Reply).seq))!.refusal).toContain("the note was blocked by the leak scanner (`aws_key`)");
    expect(await h.reasons(it1)).toEqual([]);
  });
});

/** The owner's page deps with `scanner` in place of the clean one. */
function pageWith(h: Awaited<ReturnType<typeof harness>>, scanner: UiDeps["scanner"]): UiDeps {
  return {
    store: h.store, scanner, clock: h.clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], h.clock),
    commands: { actor: OWNER, source: "config", token: TOKEN, allowed: (action) => h.roles.authorize({ user_id: OWNER, attributes: {} }, action) },
  };
}

describe("Merge applies while the request is handled", () => {
  it("a mergeable local item is merge_queued before any tick; the controller's pass enters the merge queue, which checks it", async () => {
    const h = await harness();
    const it1 = await h.itemIn(localRef(1), READY);
    const r = await h.post(it1, { command: "merge" });

    expect(r).toMatchObject({ outcome: "applied", refusal: null, state: { stage: "REVIEW", blocked_reason: MERGE_QUEUED, label: "Merging…" } });
    expect(await h.state(it1)).toEqual({ stage: "REVIEW", blocked_on: "ci", blocked_reason: MERGE_QUEUED });
    expect(await h.reasons(it1)).toEqual([MERGE_REQUESTED]);
    expect(h.roles.asked).toEqual(["approve_merge"]);

    await h.controller.tickCommands();
    // In the queue: its merged result is checked by a merge-check run; the item stays merge_queued meanwhile.
    expect(await h.runs(it1)).toEqual([{ kind: "merge-check", status: "queued" }]);
    expect(await h.state(it1)).toMatchObject({ blocked_reason: MERGE_QUEUED });
    expect(await h.request(r.seq)).toMatchObject({ refusal: null });
  });

  it("an item with a PR is merge_queued before any tick; the controller asks the forge, and the merge closes it", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), { ...READY, change_ref: "42" }, "h1");
    const r = await h.post(it1, { command: "merge" });

    expect(r).toMatchObject({ outcome: "applied", state: { blocked_reason: MERGE_QUEUED, label: "Merging…" } });
    expect(await h.state(it1)).toEqual({ stage: "REVIEW", blocked_on: "ci", blocked_reason: MERGE_QUEUED });
    expect(h.forge.mergeCalls).toEqual([]);

    await h.controller.tickCommands();
    await h.controller.tickOutbox();
    expect(h.forge.mergeCalls).toEqual([{ pr: 42, head_sha: "h1", method: "merge" }]);
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "merge-42" });
  });

  it("a second Merge is already done: nothing more is written or posted", async () => {
    const h = await harness();
    const it1 = await h.itemIn(localRef(1), READY);
    await h.post(it1, { command: "merge" });
    const second = await h.post(it1, { command: "merge" });

    expect(second).toMatchObject({ outcome: "already_done", refusal: null });
    expect(await h.reasons(it1)).toEqual([MERGE_REQUESTED]);
    expect(await h.request(second.seq)).toMatchObject({ refusal: null });
  });

  it("a conflict found by the controller returns the item to merge_pending with its reason", async () => {
    const h = await harness();
    const it1 = await h.itemIn(localRef(1), READY);
    h.sandbox.clashes = ["src/a.ts"];
    const r = await h.post(it1, { command: "merge" });
    await h.controller.tickCommands();

    expect(await h.state(it1)).toEqual({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    const back = (await h.store.listStateChanges(it1.id)).find((c) => c.reason === MERGE_RETURNED);
    expect(back!.detail!.refusal).toContain("`src/a.ts`");
    expect((await h.request(r.seq))!.refusal).toContain("does not merge cleanly");
  });

  it("the forge's refusal returns a PR item to merge_pending with its reason", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), { ...READY, change_ref: "42" }, "h1");
    h.forge.prHeads[42] = "h2";
    await h.post(it1, { command: "merge" });
    await h.controller.tickCommands();
    await h.controller.tickOutbox();

    expect(await h.state(it1)).toEqual({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    const back = (await h.store.listStateChanges(it1.id)).find((c) => c.reason === MERGE_RETURNED);
    expect(back!.detail!.refusal).toContain("head moved");
  });

  it("a refused Merge (no PR to merge, not waiting) stores nothing and answers with the controller's words", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const r = await h.post(it1, { command: "merge" });

    expect(r.outcome).toBe("refused");
    expect(r.refusal).toMatch(/^`merge` was not applied: .* is not waiting for a merge/);
    expect(await h.reasons(it1)).toEqual([]);
    expect(await h.request(r.seq)).toMatchObject({ refusal: r.refusal });
  });
});

describe("one shared module for the store-only checks", () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
  const PATHS = [
    "src/controller/units/commands/commands.unit.ts",
    "src/controller/units/local-merge/local-merge.unit.ts",
    "src/controller/units/pr-events/pr-events.unit.ts",
    "src/controller/units/transitions/transitions.unit.ts",
    "src/ui/commands.ts",
  ];
  // Each check's own words: the split's +paths, the split being filed, the decision answers' parser, the note scan, the
  // floor and Rule of Two approvals, the merge gates. They live in src/core/request-transition.ts only.
  const WORDS = [
    "does not apply to a split spec", "queued this split's phases for filing", "the note was blocked by the leak scanner", "the floor block has no recorded tier",
    "the Rule of Two block has no held run", "is not waiting for a merge (${at})", "no reviewed head is recorded", "merge the PR instead", "dependencyHoldRefusal(",
  ];

  it("the request path and the controller path import the checks from core; no copy is left in the units or the UI", () => {
    const core = read("src/core/request-transition.ts");
    for (const w of WORDS) {
      expect({ w, in_core: core.includes(w) }).toEqual({ w, in_core: true });
      for (const p of PATHS) expect({ p, w, copy: read(p).includes(w) }).toEqual({ p, w, copy: false });
    }
    // The decision answers are parsed inside the approve gate only: the callers hand it the parser, never call it.
    for (const p of PATHS) expect({ p, calls: read(p).includes("splitAnswers(") }).toEqual({ p, calls: false });
  });
});
