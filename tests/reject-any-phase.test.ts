import { describe, expect, it } from "vitest";
import { lastRefusedLines } from "../src/cli/handlers/local/refused.js";
import { MergeQueueStore } from "../src/controller/actors/merge-queue/merge-queue.store.js";
import { runLocalCli } from "../src/core/local-cli.js";
import type { RunKind, SourceRef, UserId, WorkItem, WorkItemId, WorkItemPatch, WorkerId } from "../src/core/types.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { SqlDriver } from "../src/state/index.js";
import { FakeForge, FakeSource, alice, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// `/reject <reason>` closes an open item at any phase (design 04-gate-commands, 2026-11-13): implementing, held by
// coordination cost, held for the previous phase of a split, in review and at the merge wait. Each closes as `rejected`
// with no run left queued or running. An item whose change is in the merge queue or merged is refused with the reason,
// and the refusal reaches the sender: a reply in the item's thread, and for the CLI `factory task show`.

/** The owner: a `cli_user` that is a GitHub user ID, so the CLI and GitHub comments act as the same factory user. */
const ME = "github:1" as UserId;
/** Under a default hotspot folder (weight 3.0): two items changing it are over max_coordination_cost. */
const HOTSPOT = "src/worker/runner.ts";
const localRef = (n: number): SourceRef => ({ type: "local", id: `local-${n}`, link: `local:local-${n}` });

async function harness() {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const forge = new FakeForge(source);
  const local = new OwnerAuth(store);
  await store.claimOwner(ME);
  const controller = new ControllerRole({
    store, sources: [source], forge, auth: local, clock, config, log: silent, scanner: cleanScanner,
  });
  const actor = { kind: "system" as const, id: "system:test" };
  /** An item at `ref` moved to `patch`, with one queued run per kind in `runs`. */
  const itemIn = async (ref: SourceRef, patch: WorkItemPatch, runs: RunKind[] = []): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: ref, requester_id: ME, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
    let r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch: { tier: 2, ...patch } });
    for (const kind of runs) {
      if (!r.ok) break;
      r = await store.transition({ id: item.id, expected_version: r.item.version, actor, reason: "setup", patch: {}, enqueue: { kind, idempotency_key: `${item.id}:${kind}` } });
    }
    if (!r.ok) throw new Error("setup failed");
    clock.advance(1_000);
    return r.item;
  };
  const claim = (worker = "w1") => store.claimRun({ worker_id: worker as WorkerId, kinds: ["triage", "implement", "review"], lease_ms: 60_000 });
  const reject = async (it: WorkItem, reason: string, comment_id = `c-${it.id}`) => {
    await controller.handleEvent({ kind: "spec_rejected", source: it.source, comment_id, approver: alice, reason });
    await controller.tickOutbox();
  };
  /** The item's runs still queued or running. */
  const live = async (it: WorkItem) => (await store.listRuns(it.id)).filter((r) => r.status === "queued" || r.status === "running");
  const get = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  const db = (store as unknown as { db: SqlDriver }).db;
  return { store, clock, source, forge, controller, itemIn, claim, reject, live, get, db };
}

/** Closed as rejected, with the reason kept and the reject recorded by the person. */
async function expectRejected(h: Awaited<ReturnType<typeof harness>>, it: WorkItem, reason: string) {
  expect(await h.get(it)).toMatchObject({ stage: "CLOSED", close_reason: "rejected", spec_feedback: reason });
  expect((await h.store.listStateChanges(it.id)).filter((c) => c.reason === "spec_rejected")).toEqual([
    expect.objectContaining({ actor: { kind: "user", id: "github:1" } }),
  ]);
  expect(await h.live(it)).toEqual([]);
}

describe("/reject at any open phase", () => {
  it("while implementing: the running implement run is stopped and the item closes as rejected", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), { stage: "RUNNING" }, ["implement"]);
    expect(await h.claim()).toMatchObject({ work_item_id: it1.id, kind: "implement" });
    await h.reject(it1, "not needed any more");
    await expectRejected(h, it1, "not needed any more");
    expect((await h.store.listRuns(it1.id)).map((r) => r.status)).toEqual(["cancelled"]);
    expect(h.source.closed).toEqual([it1.source]);
  });

  it("held by coordination cost: the held implement run is cancelled, not left queued", async () => {
    const h = await harness();
    const holder = await h.itemIn(issueRef(1), { stage: "RUNNING", files_to_change: [HOTSPOT], allowed_paths: ["src/worker/"] }, ["implement"]);
    const held = await h.itemIn(issueRef(2), { stage: "RUNNING", files_to_change: [HOTSPOT], allowed_paths: ["src/worker/"] }, ["implement"]);
    expect(await h.claim()).toMatchObject({ work_item_id: holder.id });
    expect(await h.claim("w2")).toBeNull();
    expect(await h.store.listClaimDecisions(held.id)).toEqual([expect.objectContaining({ decision: "held", approved_by: null })]);
    await h.reject(held, "duplicate of #1");
    await expectRejected(h, held, "duplicate of #1");
    // The holder is untouched.
    expect(await h.get(holder)).toMatchObject({ stage: "RUNNING" });
    expect(await h.live(holder)).toHaveLength(1);
  });

  it("at phase_hold: the held phase closes and its queued triage run is cancelled", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), { stage: "NEW", blocked_on: "upstream", blocked_reason: "phase_hold" }, ["triage"]);
    await h.reject(it1, "the split is wrong");
    await expectRejected(h, it1, "the split is wrong");
  });

  it("in review: the running review run is stopped, and the open PR is closed with the reason", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), { stage: "REVIEW", change_ref: "42" }, ["review"]);
    expect(await h.claim()).toMatchObject({ work_item_id: it1.id, kind: "review" });
    await h.reject(it1, "wrong approach");
    await expectRejected(h, it1, "wrong approach");
    expect(h.forge.prStates.get(42)).toBe("closed");
    expect(h.forge.mergeCalls).toEqual([]);
    expect(h.forge.prComments).toEqual([expect.objectContaining({ pr_number: 42, body: expect.stringContaining("> wrong approach") })]);
  });

  it("at the merge wait with an open PR: closes the item and the PR, as at the spec gate", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" });
    await h.reject(it1, "not now");
    await expectRejected(h, it1, "not now");
    expect(await h.get(it1)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    expect(h.forge.prStates.get(42)).toBe("closed");
  });
});

describe("/reject refused when the change is merged or in the merge queue", () => {
  /** A local item at the merge wait whose change is in the merge queue (entry `queued`). */
  async function queued(h: Awaited<ReturnType<typeof harness>>, n: number) {
    const it1 = await h.itemIn(localRef(n), { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    const mq = new MergeQueueStore(h.db, () => new Date(h.clock.now()).toISOString());
    const q = await mq.queue(PROJECT_KEY, "main");
    await mq.enter({ entry_id: `mqe_${n}`, queue_id: q.queue_id, work_item_id: it1.id, entered_by: ME, merge_key: `merge-${n}`, detail: {} });
    return it1;
  }

  it("in the merge queue: one reply in the item's thread says it cannot be rejected now and why; nothing changes", async () => {
    const h = await harness();
    const it1 = await queued(h, 1);
    await h.reject(it1, "no", "c1");
    await h.reject(it1, "no", "c1");
    expect(await h.get(it1)).toEqual(it1);
    const replies = (await h.store.listItemMessages(it1.id)).filter((m) => m.marker === "<!-- factory:refused:c1 -->").map((m) => m.body);
    expect(replies).toEqual([
      "`/reject` was not applied: the change is in the merge queue (queued), so the item cannot be rejected now: the queue lands it once its " +
        "merged result passes the checks, and a change that fails them leaves the queue, where `/reject` applies again.",
    ]);
  });

  it("merged: the reply says the change is already merged; nothing changes", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), { stage: "CLOSED", close_reason: "completed", change_ref: "42", merge_sha: "m1" });
    await h.reject(it1, "too late", "c2");
    expect(await h.get(it1)).toEqual(it1);
    expect(h.source.comments.map((c) => c.body)).toEqual([
      "`/reject` was not applied: the change is already merged, so the item cannot be rejected now; undo a merged change with a new change that reverts it.",
    ]);
    expect(h.forge.prCloseCalls).toEqual([]);
  });

  it("a refused CLI reject: the command is stored, and `factory task show` lists it with its reason under Last refused command", async () => {
    const h = await harness();
    const it1 = await queued(h, 2);
    const cli = { store: h.store, identity: { user: ME, from: "cli_user" as const }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "r1" };
    expect((await runLocalCli(cli, { action: "command", command: "reject", id: it1.id as WorkItemId, text: "no" })).code).toBe(0);
    expect(lastRefusedLines(await h.store.listItemMessages(it1.id))).toEqual(["", "Last refused command", "  (none)"]);
    await h.controller.tickCommands();
    expect(await h.get(it1)).toEqual(it1);
    const shown = lastRefusedLines(await h.store.listItemMessages(it1.id));
    expect(shown.slice(0, 2)).toEqual(["", "Last refused command"]);
    expect(shown.slice(3).join("\n")).toMatch(/^ {4}`\/reject` was not applied: the change is in the merge queue \(queued\), so the item cannot be rejected now/);
  });
});
