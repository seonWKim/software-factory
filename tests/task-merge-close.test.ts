import { describe, expect, it } from "vitest";
import { BUDGET_CHECKPOINT } from "../src/core/budget.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { HealthMonitor } from "../src/ui/health.js";
import { readTasks } from "../src/ui/tasks-api.js";
import { FakeForge, FakeSandbox, FakeSource, alice, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// Any close of a work item completes the plain tasks linked to it (design 02-tasks): a merge (issue #607), on each merge
// path (the Merge button's PR merge and a PR merged on the forge here; the local merge, from `task build` on, in
// tests/local-merge-flow.test.ts), and every close without a merge: /reject, a budget-checkpoint reject, a source close
// and a PR closed unmerged. The completion is part of the store's close transition. A task with no link is never changed.

const OWNER = "local:owner" as UserId;
const READY: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" };

/** The owner, and alice (`github:1`), the source's commenter and closer. */
class OwnerOnly implements AuthProvider {
  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    return { user_id: `github:${identity.subject}` as UserId };
  }
  async authorize(p: Principal): Promise<AuthDecision> {
    return p.user_id === OWNER || p.user_id === "github:1" ? { allow: true } : { allow: false, reason: "no_role" };
  }
}

async function harness() {
  const { store, clock } = await newStore();
  const forge = new FakeForge();
  const source = new FakeSource();
  const controller = new ControllerRole({
    store, sources: [source], forge, sandbox: new FakeSandbox(), auth: new OwnerOnly(),
    clock, config, log: silent, scanner: cleanScanner,
  });
  const actor = { kind: "system" as const, id: "system:test" };
  const itemIn = async (ref: SourceRef, patch: WorkItemPatch): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: ref, requester_id: OWNER, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
    const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch: { ...patch, tier: 2 } });
    if (!r.ok) throw new Error("setup failed");
    if (patch.change_ref) await store.recordPrHead({ id: item.id, expected_head: null, head_sha: "h1", manual: null });
    return (await store.getWorkItem(item.id))!;
  };
  let n = 0;
  const addTask = (id: string) =>
    store.addTask({ id, title: id, list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: OWNER });
  /** The Merge button: an app merge request, applied, and its outbound merge_pr action delivered. */
  const merge = async (it: WorkItem) => {
    await store.recordAppCommandRequest({ key: `k${++n}`, actor: OWNER, command: "merge", args: { work_item_id: it.id } });
    await controller.tickCommands();
    await controller.tickOutbox();
  };
  const doneAt = async (id: string) => (await store.getTask(id))!.done_at;
  return { store, clock, forge, controller, itemIn, addTask, merge, doneAt, source };
}

describe("a merge closes the task linked to the merged item", () => {
  it("the Merge button's PR merge closes its linked task as done; an unlinked task is not changed", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), { ...READY, change_ref: "42" });
    await h.addTask("tk_a");
    await h.addTask("tk_free");
    await h.store.linkTask("tk_a", it1.id);
    await h.merge(it1);
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "merge-42" });
    expect(await h.doneAt("tk_a")).not.toBeNull();
    expect(await h.store.getTask("tk_free")).toMatchObject({ done_at: null });
  });

  it("a PR merged on the forge closes its linked task as done, once; a closed-unmerged PR closes its task as done too", async () => {
    const h = await harness();
    const merged = await h.itemIn(issueRef(1), { ...READY, change_ref: "51" });
    const closed = await h.itemIn(issueRef(2), { ...READY, change_ref: "52" });
    await h.addTask("tk_merged");
    await h.addTask("tk_closed");
    await h.addTask("tk_free");
    await h.store.linkTask("tk_merged", merged.id);
    await h.store.linkTask("tk_closed", closed.id);
    h.forge.queue.push(
      { kind: "change_merged", change_ref: "51", head_branch: `factory/${merged.id}`, merge_sha: "m51", merger: null },
      { kind: "change_closed", change_ref: "52", head_branch: `factory/${closed.id}` },
    );
    await h.controller.tickIntake();
    expect(await h.store.getWorkItem(merged.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m51" });
    expect(await h.store.getWorkItem(closed.id)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    const done = await h.doneAt("tk_merged");
    expect(done).not.toBeNull();
    expect(await h.doneAt("tk_closed")).not.toBeNull();
    expect(await h.store.getTask("tk_free")).toMatchObject({ done_at: null });
    // The same event again closes nothing more.
    h.clock.advance(60_000);
    h.forge.queue.push({ kind: "change_merged", change_ref: "51", head_branch: `factory/${merged.id}`, merge_sha: "m51", merger: null });
    await h.controller.tickIntake();
    expect(await h.doneAt("tk_merged")).toBe(done);
  });
});

describe("a close without a merge completes the task linked to the closed item", () => {
  /** A task linked to an item in `patch`, and one with no link. */
  async function linked(n: number, patch: WorkItemPatch) {
    const h = await harness();
    const it = await h.itemIn(issueRef(n), patch);
    await h.addTask("tk_linked");
    await h.addTask("tk_free");
    await h.store.linkTask("tk_linked", it.id);
    return { h, it, src: issueRef(n) };
  }
  let comment = 100;
  const say = async (h: Awaited<ReturnType<typeof harness>>, e: Parameters<FakeSource["queue"]["push"]>[0]) => {
    h.source.queue.push(e);
    await h.controller.tickIntake();
  };

  it("/reject closes the item as rejected and its task as done; Tasks shows it done with the item's reason; again moves nothing", async () => {
    const { h, it, src } = await linked(1, { stage: "REVIEW", blocked_on: "human", blocked_reason: "spec_pending" });
    await say(h, { kind: "spec_rejected", source: src, comment_id: String(++comment), approver: alice, reason: "not needed" });
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    const done = await h.doneAt("tk_linked");
    expect(done).not.toBeNull();
    expect(await h.store.getTask("tk_free")).toMatchObject({ done_at: null });
    // The Tasks list: the task is done (not open), with its item's close reason; the unlinked task is open with none.
    const deps = { store: h.store, scanner: cleanScanner, clock: h.clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], h.clock) };
    const r = await readTasks(deps);
    const rows = (r.value as { projects: { tasks: { id: string; done_at: string | null; close_reason?: string | null }[] }[] }).projects.flatMap((p) => p.tasks);
    expect(rows.find((t) => t.id === "tk_linked")).toMatchObject({ done_at: done, close_reason: "rejected" });
    expect(rows.find((t) => t.id === "tk_free")).toMatchObject({ done_at: null, close_reason: null });
    expect((await h.store.listTasks(100)).map((t) => t.id)).not.toContain("tk_linked");
    // The same comment again, and a later one, change nothing more.
    h.clock.advance(60_000);
    await say(h, { kind: "spec_rejected", source: src, comment_id: String(comment), approver: alice, reason: "not needed" });
    await say(h, { kind: "spec_rejected", source: src, comment_id: String(++comment), approver: alice, reason: "still not" });
    expect(await h.doneAt("tk_linked")).toBe(done);
  });

  it("/reject at a budget checkpoint closes the item as rejected and its task as done", async () => {
    const { h, it, src } = await linked(2, { stage: "REVIEW", blocked_on: "none", blocked_reason: null, change_ref: "42" });
    const at = (await h.store.getWorkItem(it.id))!;
    const opened = await h.store.openBudgetCheckpoint({
      id: it.id, expected_version: at.version, patch: { blocked_on: "budget", blocked_reason: BUDGET_CHECKPOINT },
      actor: { kind: "system", id: "system:test" }, reason: "budget_checkpoint",
      checkpoint: { tier: 2, tokens_spent: 1000, budget: 1000, suggested_budget: 2000, held_run_kind: "review", held_run_key: "k", held_run_not_before: null },
    });
    expect(opened.ok).toBe(true);
    await say(h, { kind: "spec_rejected", source: src, comment_id: String(++comment), approver: alice, reason: "too costly" });
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    expect((await h.store.listStateChanges(it.id)).map((c) => c.reason)).toContain("budget_rejected");
    expect(await h.doneAt("tk_linked")).not.toBeNull();
    expect(await h.store.getTask("tk_free")).toMatchObject({ done_at: null });
  });

  it.each([["not_planned", "wont_do"], ["completed", "completed"]] as const)("a source close (%s) closes the item as %s and its task as done, once", async (state_reason, close_reason) => {
    const { h, it, src } = await linked(3, { stage: "READY", blocked_on: "none", blocked_reason: null });
    await say(h, { kind: "source_closed", source: src, closer: alice, state_reason });
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "CLOSED", close_reason });
    const done = await h.doneAt("tk_linked");
    expect(done).not.toBeNull();
    expect(await h.store.getTask("tk_free")).toMatchObject({ done_at: null });
    h.clock.advance(60_000);
    await say(h, { kind: "source_closed", source: src, closer: alice, state_reason });
    expect(await h.doneAt("tk_linked")).toBe(done);
  });

  it("a PR closed unmerged closes the item as rejected and its task as done, once", async () => {
    const { h, it } = await linked(4, { ...READY, change_ref: "61" });
    const closed = { kind: "change_closed" as const, change_ref: "61", head_branch: `factory/${it.id}` };
    h.forge.queue.push(closed);
    await h.controller.tickIntake();
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    const done = await h.doneAt("tk_linked");
    expect(done).not.toBeNull();
    h.clock.advance(60_000);
    h.forge.queue.push(closed);
    await h.controller.tickIntake();
    expect(await h.doneAt("tk_linked")).toBe(done);
    expect(await h.store.getTask("tk_free")).toMatchObject({ done_at: null });
  });

  it("the close transition itself completes the linked task, in its store transaction", async () => {
    const { h, it } = await linked(5, { stage: "READY", blocked_on: "none", blocked_reason: null });
    const r = await h.store.transition({
      id: it.id, expected_version: it.version, actor: { kind: "system", id: "system:test" }, reason: "test_close",
      patch: { stage: "CLOSED", close_reason: "wont_do" },
    });
    expect(r.ok).toBe(true);
    expect(await h.doneAt("tk_linked")).toBe(h.clock.now().toISOString());
    expect(await h.store.getTask("tk_free")).toMatchObject({ done_at: null });
  });
});
