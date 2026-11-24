import { describe, expect, it } from "vitest";
import { BUDGET_CHECKPOINT } from "../src/core/budget.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { HealthMonitor } from "../src/ui/health.js";
import { readTasks } from "../src/ui/tasks-api.js";
import { FakeForge } from "./helpers/fakes/forge.js";
import { FakeSandbox } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// A close of a work item as completed completes the plain tasks linked to it (design 02-tasks): a merge (issue #607), on
// each merge path (the Merge button's PR merge and a PR merged on the forge here; the local merge, from `task build` on, in
// tests/local-merge-flow.test.ts), and a completed close without a merge (a plan item or the owner's close; a source close
// as completed). A rejected or wont_do close (/reject, a budget-checkpoint reject, a source close as not planned, a PR
// closed unmerged) leaves the task open, and the Tasks read gives its row the item's close reason. The completion is part
// of the store's close transition. A task with no link is never changed.

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

  it("a PR merged on the forge closes its linked task as done, once; a closed-unmerged PR leaves its task open", async () => {
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
    expect(await h.doneAt("tk_closed")).toBeNull();
    expect(await h.store.getTask("tk_free")).toMatchObject({ done_at: null });
    // The same event again closes nothing more.
    h.clock.advance(60_000);
    h.forge.queue.push({ kind: "change_merged", change_ref: "51", head_branch: `factory/${merged.id}`, merge_sha: "m51", merger: null });
    await h.controller.tickIntake();
    expect(await h.doneAt("tk_merged")).toBe(done);
  });
});

/** The Tasks read's rows, open and done, with their close reasons. */
async function taskRows(h: Awaited<ReturnType<typeof harness>>) {
  const deps = { store: h.store, scanner: cleanScanner, clock: h.clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], h.clock) };
  const r = await readTasks(deps);
  type Row = { id: string; done_at: string | null; close_reason?: string | null; reject_reason?: string | null; link_note?: string | null; work_item_id: string | null };
  return (r.value as { projects: { tasks: Row[] }[] }).projects.flatMap((p) => p.tasks);
}

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
const system = { kind: "system" as const, id: "system:test" };

describe("a close as completed without a merge completes the task linked to the closed item", () => {
  it("the store's close transition as completed with no merge (a plan item, the owner's close) completes the linked task in its transaction; a repeat close moves nothing", async () => {
    const { h, it } = await linked(5, { stage: "READY", blocked_on: "none", blocked_reason: null });
    const r = await h.store.transition({ id: it.id, expected_version: it.version, actor: system, reason: "test_close", patch: { stage: "CLOSED", close_reason: "completed" } });
    expect(r.ok).toBe(true);
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: null });
    const done = await h.doneAt("tk_linked");
    expect(done).toBe(h.clock.now().toISOString());
    expect(await h.store.getTask("tk_free")).toMatchObject({ done_at: null });
    // A repeat close of the closed item changes nothing: done_at stays.
    h.clock.advance(60_000);
    const at = (await h.store.getWorkItem(it.id))!;
    const again = await h.store.transition({ id: it.id, expected_version: at.version, actor: system, reason: "test_close", patch: { stage: "CLOSED", close_reason: "completed" } });
    expect(again.ok).toBe(true);
    expect(await h.doneAt("tk_linked")).toBe(done);
  });

  it("a source close as completed closes the item as completed and its task as done, once", async () => {
    const { h, it, src } = await linked(3, { stage: "READY", blocked_on: "none", blocked_reason: null });
    await say(h, { kind: "source_closed", source: src, closer: alice, state_reason: "completed" });
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    const done = await h.doneAt("tk_linked");
    expect(done).not.toBeNull();
    expect(await h.store.getTask("tk_free")).toMatchObject({ done_at: null });
    h.clock.advance(60_000);
    await say(h, { kind: "source_closed", source: src, closer: alice, state_reason: "completed" });
    expect(await h.doneAt("tk_linked")).toBe(done);
  });
});

describe("a rejected or wont_do close leaves the linked task open, with its item's close reason", () => {
  it("/reject closes the item as rejected and leaves its task open; Tasks gives the row close_reason rejected; again changes nothing", async () => {
    const { h, it, src } = await linked(1, { stage: "REVIEW", blocked_on: "human", blocked_reason: "spec_pending" });
    await say(h, { kind: "spec_rejected", source: src, comment_id: String(++comment), approver: alice, reason: "not needed" });
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    expect(await h.doneAt("tk_linked")).toBeNull();
    const rows = await taskRows(h);
    expect(rows.find((t) => t.id === "tk_linked")).toMatchObject({ done_at: null, close_reason: "rejected" });
    expect(rows.find((t) => t.id === "tk_free")).toMatchObject({ done_at: null, close_reason: null });
    expect((await h.store.listTasks(100)).map((t) => t.id)).toContain("tk_linked");
    // The same comment again, and a later one, change nothing.
    h.clock.advance(60_000);
    await say(h, { kind: "spec_rejected", source: src, comment_id: String(comment), approver: alice, reason: "not needed" });
    await say(h, { kind: "spec_rejected", source: src, comment_id: String(++comment), approver: alice, reason: "still not" });
    expect(await h.doneAt("tk_linked")).toBeNull();
  });

  it("/reject at a budget checkpoint closes the item as rejected and leaves its task open", async () => {
    const { h, it, src } = await linked(2, { stage: "REVIEW", blocked_on: "none", blocked_reason: null, change_ref: "42" });
    const at = (await h.store.getWorkItem(it.id))!;
    const opened = await h.store.openBudgetCheckpoint({
      id: it.id, expected_version: at.version, patch: { blocked_on: "budget", blocked_reason: BUDGET_CHECKPOINT },
      actor: system, reason: "budget_checkpoint",
      checkpoint: { tier: 2, tokens_spent: 1000, budget: 1000, suggested_budget: 2000, held_run_kind: "review", held_run_key: "k", held_run_not_before: null },
    });
    expect(opened.ok).toBe(true);
    await say(h, { kind: "spec_rejected", source: src, comment_id: String(++comment), approver: alice, reason: "too costly" });
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    expect((await h.store.listStateChanges(it.id)).map((c) => c.reason)).toContain("budget_rejected");
    expect(await h.doneAt("tk_linked")).toBeNull();
  });

  it("a source close as not planned closes the item as wont_do and leaves its task open; Tasks gives the row close_reason wont_do", async () => {
    const { h, it, src } = await linked(3, { stage: "READY", blocked_on: "none", blocked_reason: null });
    await say(h, { kind: "source_closed", source: src, closer: alice, state_reason: "not_planned" });
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "CLOSED", close_reason: "wont_do" });
    expect(await h.doneAt("tk_linked")).toBeNull();
    expect((await taskRows(h)).find((t) => t.id === "tk_linked")).toMatchObject({ done_at: null, close_reason: "wont_do" });
  });

  it("a PR closed unmerged closes the item as rejected and leaves its task open", async () => {
    const { h, it } = await linked(4, { ...READY, change_ref: "61" });
    h.forge.queue.push({ kind: "change_closed", change_ref: "61", head_branch: `factory/${it.id}` });
    await h.controller.tickIntake();
    expect(await h.store.getWorkItem(it.id)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    expect(await h.doneAt("tk_linked")).toBeNull();
  });

  it("the close transition as wont_do leaves the linked task open", async () => {
    const { h, it } = await linked(5, { stage: "READY", blocked_on: "none", blocked_reason: null });
    const r = await h.store.transition({ id: it.id, expected_version: it.version, actor: system, reason: "test_close", patch: { stage: "CLOSED", close_reason: "wont_do" } });
    expect(r.ok).toBe(true);
    expect(await h.doneAt("tk_linked")).toBeNull();
  });
});

describe("a rejected close moves the linked task to its replacement (design 02-tasks-build)", () => {
  const close = async (h: Awaited<ReturnType<typeof harness>>, id: WorkItem["id"], patch: WorkItemPatch) => {
    const at = (await h.store.getWorkItem(id))!;
    const r = await h.store.transition({ id, expected_version: at.version, actor: system, reason: "test_close", patch });
    expect(r.ok).toBe(true);
  };
  const OPEN: WorkItemPatch = { stage: "READY", blocked_on: "none", blocked_reason: null };
  /** Phases 1..n of `parent`, each an item of its own, linked as the split's phases. */
  const phasesOf = async (h: Awaited<ReturnType<typeof harness>>, parent: WorkItem, n: number, from: number) => {
    const out: WorkItem[] = [];
    for (let i = 1; i <= n; i++) {
      const p = await h.itemIn(issueRef(from + i), OPEN);
      await h.store.db.run("UPDATE controller_work_items SET parent_id = ?, phase = ? WHERE id = ?", [parent.id, i, p.id]);
      out.push(p);
    }
    return out;
  };

  it("/reject of A naming B moves A's open task to B with a note; completing B completes the task", async () => {
    const { h, it: a, src } = await linked(10, { stage: "REVIEW", blocked_on: "human", blocked_reason: "spec_pending" });
    const b = await h.itemIn(issueRef(11), OPEN);
    await say(h, { kind: "spec_rejected", source: src, comment_id: String(++comment), approver: alice, reason: `refiled as ${b.id}` });
    expect(await h.store.getWorkItem(a.id)).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
    expect(await h.store.getTask("tk_linked")).toMatchObject({ work_item_id: b.id, done_at: null });
    expect(await h.store.getTask("tk_free")).toMatchObject({ work_item_id: null, done_at: null });
    const row = (await taskRows(h)).find((t) => t.id === "tk_linked");
    expect(row).toMatchObject({ work_item_id: b.id, link_note: `Moved from ${a.id}`, reject_reason: null, close_reason: null });
    await close(h, b.id, { stage: "CLOSED", close_reason: "completed" });
    expect(await h.doneAt("tk_linked")).not.toBeNull();
    expect(await h.doneAt("tk_free")).toBeNull();
  });

  it("a reason naming B by its short id moves the task; naming the item itself or an unknown id does not", async () => {
    const { h, it: a } = await linked(12, OPEN);
    const b = await h.itemIn(issueRef(13), OPEN);
    await close(h, a.id, { stage: "CLOSED", close_reason: "rejected", spec_feedback: `not ${a.id}, not wi_00000000, covered by ${b.id.slice(0, 11)}` });
    expect(await h.store.getTask("tk_linked")).toMatchObject({ work_item_id: b.id, done_at: null });
  });

  it("a task moved to a replacement already closed as completed is completed at once", async () => {
    const { h, it: a } = await linked(14, OPEN);
    const b = await h.itemIn(issueRef(15), OPEN);
    await close(h, b.id, { stage: "CLOSED", close_reason: "completed" });
    await close(h, a.id, { stage: "CLOSED", close_reason: "rejected", spec_feedback: `done by ${b.id}` });
    expect(await h.store.getTask("tk_linked")).toMatchObject({ work_item_id: b.id });
    expect(await h.doneAt("tk_linked")).not.toBeNull();
  });

  it("a reject with no replacement leaves the task open; Tasks gives the reject reason, or `no reason given`", async () => {
    const { h, it: a, src } = await linked(16, { stage: "REVIEW", blocked_on: "human", blocked_reason: "spec_pending" });
    await say(h, { kind: "spec_rejected", source: src, comment_id: String(++comment), approver: alice, reason: "the API already does this" });
    expect(await h.store.getTask("tk_linked")).toMatchObject({ work_item_id: a.id, done_at: null });
    expect((await taskRows(h)).find((t) => t.id === "tk_linked")).toMatchObject({
      done_at: null, close_reason: "rejected", reject_reason: "the API already does this", link_note: null,
    });
    expect((await taskRows(h)).find((t) => t.id === "tk_free")).toMatchObject({ reject_reason: null, link_note: null });

    const { h: h2, it: c } = await linked(17, OPEN);
    await close(h2, c.id, { stage: "CLOSED", close_reason: "rejected", spec_feedback: null });
    expect((await taskRows(h2)).find((t) => t.id === "tk_linked")).toMatchObject({ done_at: null, reject_reason: "no reason given" });
  });

  it("a wont_do close naming another item moves nothing", async () => {
    const { h, it: a } = await linked(18, OPEN);
    const b = await h.itemIn(issueRef(19), OPEN);
    await close(h, a.id, { stage: "CLOSED", close_reason: "wont_do", spec_feedback: `see ${b.id}` });
    expect(await h.store.getTask("tk_linked")).toMatchObject({ work_item_id: a.id, done_at: null });
  });

  it("a split parent rejected after all its phases closed completes its open task", async () => {
    const { h, it: parent } = await linked(20, OPEN);
    const phases = await phasesOf(h, parent, 2, 20);
    await close(h, phases[0]!.id, { stage: "CLOSED", close_reason: "completed" });
    await close(h, phases[1]!.id, { stage: "CLOSED", close_reason: "rejected" });
    expect(await h.doneAt("tk_linked")).toBeNull();
    await close(h, parent.id, { stage: "CLOSED", close_reason: "rejected" });
    expect(await h.store.getTask("tk_linked")).toMatchObject({ work_item_id: parent.id });
    expect(await h.doneAt("tk_linked")).not.toBeNull();
    expect(await h.doneAt("tk_free")).toBeNull();
  });

  it("a split parent rejected with a phase still open moves its task to the highest-numbered open phase", async () => {
    const { h, it: parent } = await linked(30, OPEN);
    const phases = await phasesOf(h, parent, 3, 30);
    await close(h, phases[2]!.id, { stage: "CLOSED", close_reason: "rejected" });
    await close(h, parent.id, { stage: "CLOSED", close_reason: "rejected" });
    expect(await h.store.getTask("tk_linked")).toMatchObject({ work_item_id: phases[1]!.id, done_at: null });
    expect((await taskRows(h)).find((t) => t.id === "tk_linked")).toMatchObject({ link_note: `Moved from ${parent.id}` });
  });
});
