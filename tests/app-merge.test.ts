import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { LocalMergeResult, LocalMergeSpec } from "../src/core/local-merge.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { AuthDecision, AuthProvider, Principal } from "../src/interfaces/auth-provider.js";
import type { AppCommandRequest } from "../src/interfaces/factory-store.js";
import { FakeAuth, FakeForge, FakeSandbox, FakeSource, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The Merge button (design §9, issue #451): an app `merge` request merges a GitHub item's PR at the head the review
// passed, as a keyed `merge_pr` action outbound delivers through the forge (RFC 0015 M7). It is authorized as
// approve_merge by the local auth plugin, and a refusal moves nothing. The local item's Merge, the one local merge
// `factory merge` uses, is in tests/local-merge-flow.test.ts.

const OWNER = "local:owner" as UserId;
const REQUESTER = "local:requester" as UserId;
const READY: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" };

/** The local auth plugin: OWNER holds approve_merge, nobody else does. Records each action it is asked about. */
class LocalRoles implements AuthProvider {
  asked: string[] = [];
  async resolve(): Promise<Principal | null> {
    return null;
  }
  async authorize(p: Principal, action: string): Promise<AuthDecision> {
    this.asked.push(action);
    return p.user_id === OWNER ? { allow: true } : { allow: false, reason: "no_role" };
  }
}

/** A sandbox that can merge locally: each mergeLocal is recorded and answers `result`. */
class MergingSandbox extends FakeSandbox {
  merges: LocalMergeSpec[] = [];
  result: LocalMergeResult = { merged: true, sha: "localmerge1", already: false, not_updated: [] };
  async mergeLocal(spec: LocalMergeSpec): Promise<LocalMergeResult> {
    this.merges.push(spec);
    return this.result;
  }
}

const localRef = (n: number): SourceRef => ({ type: "local", id: `local-${n}`, link: `local:local-${n}` });

async function harness(opts: { forge?: boolean } = {}) {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const forge = new FakeForge();
  const sandbox = new MergingSandbox();
  const roles = new LocalRoles();
  const controller = new ControllerRole({
    store, sources: [source], forge: opts.forge === false ? null : forge, sandbox, auth: new FakeAuth(), local_auth: roles,
    clock, config, log: silent, scanner: cleanScanner,
  });
  const actor = { kind: "system" as const, id: "system:test" };
  const itemIn = async (ref: SourceRef, patch: WorkItemPatch, head: string | null = null): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: ref, requester_id: REQUESTER, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
    const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch: { ...patch, tier: 2 } });
    if (!r.ok) throw new Error("setup failed");
    if (head !== null) await store.recordPrHead({ id: item.id, expected_head: null, head_sha: head, manual: null });
    return (await store.getWorkItem(item.id))!;
  };
  /** A GitHub item waiting for its merge: PR #42 (or `pr`), reviewed at head `h1`. */
  const githubReady = (n = 1, pr = "42") => itemIn(issueRef(n), { ...READY, change_ref: pr }, "h1");
  let keys = 0;
  const merge = async (it: WorkItem, who: UserId = OWNER): Promise<AppCommandRequest> => {
    const { request } = await store.recordAppCommandRequest({ key: `k${++keys}`, actor: who, command: "merge", args: { work_item_id: it.id } });
    await controller.tickCommands();
    // Outbound merges the PR; its DeliveryCompleted closes the item and posts the reply.
    await controller.tickOutbox();
    return (await store.getAppCommandRequest(request.seq))!;
  };
  /** The item's thread entries for request `r`: its refusal and its merge reply. */
  const replies = async (it: WorkItem, r: AppCommandRequest) =>
    (await store.listItemMessages(it.id)).filter((m) => m.marker.includes(`:app-${r.seq} -->`)).map((m) => m.body);
  const closes = async (it: WorkItem) => (await store.listStateChanges(it.id)).filter((c) => c.changes.stage?.to === "CLOSED");
  /** Every sandbox call: a local merge, a created folder or a git command. */
  const sandboxCalls = () => sandbox.merges.length + sandbox.created.length + sandbox.gitCalls.length;
  return { store, clock, source, forge, sandbox, roles, controller, itemIn, githubReady, merge, replies, closes, sandboxCalls };
}

describe("Merge on a GitHub item (the forge's mergePr)", () => {
  it("merges the PR at the reviewed head with a merge commit, closes the item with GitHub's merge sha, and posts one reply", async () => {
    const h = await harness();
    const it1 = await h.githubReady();
    const r = await h.merge(it1);

    expect(h.forge.mergeCalls).toEqual([{ pr: 42, head_sha: "h1", method: "merge" }]);
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "merge-42", blocked_on: "none" });
    const [close] = await h.closes(it1);
    // The person who pressed Merge is the approver of record; the request's seq is on the change.
    expect(close).toMatchObject({ reason: "pr_merged", actor: { kind: "user", id: OWNER } });
    expect(close!.detail).toMatchObject({ app_request: r.seq, head_sha: "h1" });
    expect(await h.replies(it1, r)).toEqual([expect.stringContaining("Merged PR #42")]);
    expect(r).toMatchObject({ refusal: null });
    expect(h.roles.asked).toEqual(["approve_merge"]);
    expect(h.sandboxCalls()).toBe(0);
  });

  it("a PR whose head moved is refused with one reply, and the item stays merge_pending", async () => {
    const h = await harness();
    const it1 = await h.githubReady();
    h.forge.prHeads[42] = "h2";
    const r = await h.merge(it1);

    expect(h.forge.mergeCalls).toHaveLength(1);
    expect(await h.store.getWorkItem(it1.id)).toEqual(it1);
    // The request was applied (the merge was asked for); the forge's refusal comes back as one reply.
    expect(r.refusal).toBeNull();
    expect(await h.replies(it1, r)).toEqual([expect.stringContaining("head moved")]);
  });

  it("a principal without approve_merge is refused, with no forge call", async () => {
    const h = await harness();
    const it1 = await h.githubReady();
    const r = await h.merge(it1, REQUESTER);

    expect(h.forge.mergeCalls).toEqual([]);
    expect(await h.store.getWorkItem(it1.id)).toEqual(it1);
    expect(await h.replies(it1, r)).toEqual([expect.stringContaining("has no role that allows it")]);
    expect(h.roles.asked).toEqual(["approve_merge"]);
  });

  it("with no forge selected the merge is refused with that reason", async () => {
    const h = await harness({ forge: false });
    const it1 = await h.githubReady();
    const r = await h.merge(it1);

    expect(await h.store.getWorkItem(it1.id)).toEqual(it1);
    expect(r.refusal).toContain("no forge is selected");
  });

  it("a forge failure moves nothing and outbound retries the merge after its backoff, once", async () => {
    const h = await harness();
    const it1 = await h.githubReady();
    h.forge.mergeError = new Error("network down");
    const r = await h.merge(it1);

    expect(await h.store.getWorkItem(it1.id)).toEqual(it1);
    expect(r.refusal).toBeNull();
    h.forge.mergeError = null;
    h.clock.advance(config.retry_max_ms);
    await h.controller.tickOutbox();
    expect(h.forge.mergeCalls).toHaveLength(2);
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "CLOSED", merge_sha: "merge-42" });
    expect(await h.replies(it1, r)).toEqual([expect.stringContaining("Merged PR #42")]);
  });

  it("twice is safe: a second request after the merge is refused as not waiting, with no second merge", async () => {
    const h = await harness();
    const it1 = await h.githubReady();
    await h.merge(it1);
    const again = await h.merge(it1);

    expect(h.forge.mergeCalls).toHaveLength(1);
    expect(again.refusal).toContain("is not waiting for a merge");
    expect(await h.closes(it1)).toHaveLength(1);
  });

  it("a retry after GitHub merged but before the store closed the item closes it with the PR's merge sha, once", async () => {
    const h = await harness();
    const it1 = await h.githubReady();
    h.forge.mergeShas[42] = "m-earlier";
    const r = await h.merge(it1);

    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m-earlier" });
    const closes = await h.closes(it1);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.detail).toMatchObject({ already_merged: true });
    expect(r.refusal).toBeNull();
    // The forge's own merged event later changes nothing more.
    h.forge.queue.push({ kind: "change_merged", change_ref: "42", head_branch: `factory/${it1.id}`, merge_sha: "m-earlier", merger: null });
    await h.controller.tickIntake();
    expect(await h.closes(it1)).toHaveLength(1);
  });
});

describe("Merge on a local item that already has a PR", () => {
  it("merges its PR through the forge, with no local merge", async () => {
    const h = await harness();
    const it1 = await h.itemIn(localRef(1), { ...READY, change_ref: "42" }, "h1");
    const r = await h.merge(it1);

    expect(h.forge.mergeCalls).toEqual([{ pr: 42, head_sha: "h1", method: "merge" }]);
    expect(h.sandboxCalls()).toBe(0);
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "merge-42" });
    expect(r.refusal).toBeNull();
  });
});

describe("Merge releases the items waiting on the merged one", () => {
  it("an item held on the merged item's dependency is released", async () => {
    const h = await harness();
    const it1 = await h.githubReady(1);
    const waiting = await h.itemIn(issueRef(2), { stage: "RUNNING", blocked_on: "dependency", blocked_reason: `waiting for ${it1.source.id}` });
    await h.store.replaceDependencyEdges(waiting.id, [{ depends_on: it1.source.id, kind: "depends_on" }]);
    await h.merge(it1);

    expect(await h.store.getWorkItem(waiting.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
  });
});

describe("Merge on an item not waiting for a merge", () => {
  it("is refused with one reply, and makes no GitHub call and no sandbox call", async () => {
    const h = await harness();
    for (const [n, it] of [
      [1, await h.itemIn(issueRef(1), { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" })],
      [2, await h.itemIn(localRef(2), { stage: "RUNNING" })],
    ] as const) {
      const r = await h.merge(it);
      expect(await h.store.getWorkItem(it.id), String(n)).toEqual(it);
      const said = await h.replies(it, r);
      expect(said, String(n)).toHaveLength(1);
      expect(said[0]).toContain("is not waiting for a merge");
    }
    expect(h.forge.mergeCalls).toEqual([]);
    expect(h.sandboxCalls()).toBe(0);
  });
});
