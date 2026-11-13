import { describe, expect, it } from "vitest";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { AuthDecision, AuthProvider, Principal } from "../src/interfaces/auth-provider.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeAuth, FakeForge, FakeSandbox, FakeSource, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// A merged change closes the plain task `task build` linked to it (design 02-tasks, issue #607), on each merge path:
// the Merge button's PR merge and a PR merged on the forge here; the local merge, from `task build` on, in
// tests/local-merge-flow.test.ts. A task with no link is never changed.

const OWNER = "local:owner" as UserId;
const READY: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" };

class OwnerOnly implements AuthProvider {
  async resolve(): Promise<Principal | null> {
    return null;
  }
  async authorize(p: Principal): Promise<AuthDecision> {
    return p.user_id === OWNER ? { allow: true } : { allow: false, reason: "no_role" };
  }
}

async function harness() {
  const { store, clock } = await newStore();
  const forge = new FakeForge();
  const controller = new ControllerRole({
    store, sources: [new FakeSource()], forge, sandbox: new FakeSandbox(), auth: new OwnerOnly(),
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
  return { store, clock, forge, controller, itemIn, addTask, merge, doneAt };
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

  it("a PR merged on the forge closes its linked task as done, once; a closed-unmerged PR leaves it open", async () => {
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
