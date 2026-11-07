import { describe, expect, it } from "vitest";
import { commandFooter, commandsFor, commandTableMarkdown, helpReply, parseComment } from "../src/core/commands.js";
import { Controller } from "../src/core/controller.js";
import type { UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import { GitHubForge } from "../src/impl/github/github-forge.js";
import { GitHubClient, GitHubError } from "../src/impl/github/github-client.js";
import type { AppCommandRequest } from "../src/interfaces/factory-store.js";
import type { Forge } from "../src/interfaces/forge.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import { FakeAuth, FakeForge, FakeSource, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The merge command (design §4, issue #246): an app `merge` request on an item waiting for a human merge goes
// through the `/approve` permission check and the controller's re-checks, then one merge through the forge at the
// reviewed head; the item closes as completed with the requester as actor. Off unless config names a forge.

/** FakeAuth lets github:1 approve, nobody else. */
const WRITER = "github:1" as UserId;
const READER = "github:666" as UserId;
const HEAD = "a".repeat(40);
const PR = 42;
const MERGE_PENDING: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: PR, tier: 2 };

async function harness(opts: { merge?: boolean; forge?: boolean } = {}) {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const forge = new FakeForge();
  const cfg = opts.merge === false ? config : { ...config, forge_merge: true };
  const controller = new Controller({
    store, source, ...(opts.forge === false ? {} : { forge }), auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner,
  });
  const actor = { kind: "system" as const, id: "system:test" };
  /** A factory item on issue `n` in the state `patch` gives, its PR head recorded as HEAD; the forge reports that head. */
  const itemIn = async (patch: WorkItemPatch, n: number): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: issueRef(n), requester_id: WRITER, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
    const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch });
    if (!r.ok) throw new Error("setup failed");
    await store.recordPrHead({ id: item.id, expected_head: null, head_sha: HEAD, manual: null });
    forge.mergeStates.set(PR, { head_sha: HEAD });
    return (await store.getWorkItem(item.id))!;
  };
  const merge = async (it: WorkItem, user: UserId = WRITER, key = "m1"): Promise<AppCommandRequest> => {
    const { request } = await store.recordAppCommandRequest({ key, actor: user, command: "merge", args: { work_item_id: it.id } });
    await controller.tickCommands();
    return (await store.getAppCommandRequest(request.seq))!;
  };
  return { store, clock, source, forge, controller, itemIn, merge };
}

/** Refused with `reason`: no merge call, the item exactly as it was, the refusal stored and posted once. */
async function expectRefused(h: Awaited<ReturnType<typeof harness>>, it: WorkItem, r: AppCommandRequest, reason: RegExp) {
  expect(h.forge.mergeCalls).toEqual([]);
  expect(await h.store.getWorkItem(it.id)).toEqual(it);
  expect(r.refusal).toMatch(/^`merge` was not applied: /);
  expect(r.refusal).toMatch(reason);
  // Posted once on the item's own surface: its issue, or for an adopted item its PR (through the forge).
  const posted = [...h.source.comments, ...h.forge.comments].filter((c) => c.marker === `<!-- factory:refused:app-${r.seq} -->`);
  expect(posted.map((c) => c.body)).toEqual([r.refusal]);
}

describe("merge command: the GitHub forge path (fake forge)", () => {
  it("merges a ready item's PR once at the reviewed head, and the item closes as completed", async () => {
    const h = await harness();
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    const r = await h.merge(it1);

    expect(h.forge.mergeCalls).toEqual([{ pr_number: PR, branch: `factory/${it1.id}`, base_ref: "main", head_sha: HEAD }]);
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: `merge-${PR}`, blocked_on: "none" });
    expect(r).toMatchObject({ refusal: null });
    expect(r.handled_at).not.toBeNull();
    expect(h.source.comments.filter((c) => c.marker.includes("refused"))).toEqual([]);
  });

  it("stores the merge decision with the actor's ID in the timeline, and no display name", async () => {
    const h = await harness();
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    const r = await h.merge(it1);
    const changes = await h.store.listStateChanges(it1.id);
    const merged = changes.filter((c) => c.reason === "merged_by_command");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.actor).toEqual({ kind: "user", id: WRITER });
    expect(merged[0]!.detail).toEqual({ app_request: r.seq, pr_number: PR, merge_sha: `merge-${PR}` });
    expect(JSON.stringify(changes)).not.toMatch(/alice|login/);
  });

  it("a second merge request on the merged item does nothing: no second merge, no refusal, no change", async () => {
    const h = await harness();
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    await h.merge(it1);
    const after = (await h.store.getWorkItem(it1.id))!;
    const again = await h.merge(it1, WRITER, "m2");
    expect(h.forge.mergeCalls).toHaveLength(1);
    expect(again.refusal).toBeNull();
    expect(await h.store.getWorkItem(it1.id)).toEqual(after);
  });

  it("the same request handled twice (a crash before the mark) merges once", async () => {
    const h = await harness();
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    const { request } = await h.store.recordAppCommandRequest({ key: "m1", actor: WRITER, command: "merge", args: { work_item_id: it1.id } });
    await h.controller.tickCommands();
    await h.store.advanceCursor("commands", String(request.seq), "0");
    await h.controller.tickCommands();
    expect(h.forge.mergeCalls).toHaveLength(1);
    expect((await h.store.listStateChanges(it1.id)).filter((c) => c.reason === "merged_by_command")).toHaveLength(1);
  });

  it("a PR the forge already reports merged (a crash after the merge) closes the item with no second merge", async () => {
    const h = await harness();
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    h.forge.mergeStates.set(PR, { head_sha: HEAD, state: "merged", merge_sha: "m".repeat(40) });
    const r = await h.merge(it1);
    expect(h.forge.mergeCalls).toEqual([]);
    expect(r.refusal).toBeNull();
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m".repeat(40) });
  });

  it("a refusal from the forge is stored and posted, and nothing changes", async () => {
    const h = await harness();
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    h.forge.mergeRefusal = "GitHub refused the merge: a branch rule, a required check or the repository's merge method does not allow it";
    const r = await h.merge(it1);
    expect(h.forge.mergeCalls).toHaveLength(1);
    expect(await h.store.getWorkItem(it1.id)).toEqual(it1);
    expect(r.refusal).toBe(`\`merge\` was not applied: ${h.forge.mergeRefusal}.`);
  });
});

describe("merge command: refusals before any merge", () => {
  it("is refused when the item is not ready to merge: no forge read, no merge, no stage or block change", async () => {
    const h = await harness();
    const it1 = await h.itemIn({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", pr_number: PR }, 1);
    const reviewing = await h.itemIn({ stage: "REVIEW", pr_number: PR }, 2);
    await expectRefused(h, it1, await h.merge(it1), /the item is spec waiting for approval; `merge` applies only when it is waiting for a human merge/);
    await expectRefused(h, reviewing, await h.merge(reviewing, WRITER, "m2"), /the item is in review/);
    expect(h.forge.checkCalls).toEqual([]);
  });

  it("is refused when a check failed or is still pending", async () => {
    const h = await harness();
    const failed = await h.itemIn(MERGE_PENDING, 1);
    h.forge.checkResults.push({ state: "failed", failed: ["ci", "lint"] });
    await expectRefused(h, failed, await h.merge(failed), /2 of the PR's checks failed/);
    const pending = await h.itemIn(MERGE_PENDING, 2);
    h.forge.checkResults.push({ state: "pending" });
    await expectRefused(h, pending, await h.merge(pending, WRITER, "m2"), /checks are still running/);
  });

  it("is refused when commits arrived after the reviewed head", async () => {
    const h = await harness();
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    h.forge.mergeStates.set(PR, { head_sha: "b".repeat(40) });
    await expectRefused(h, it1, await h.merge(it1), /commits arrived after the reviewed head/);
  });

  it("is refused when the branch does not merge cleanly into base, or the forge does not know yet", async () => {
    const h = await harness();
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    h.forge.mergeStates.set(PR, { head_sha: HEAD, mergeable: false });
    await expectRefused(h, it1, await h.merge(it1), /the branch does not merge cleanly into `main`/);
    h.forge.mergeStates.set(PR, { head_sha: HEAD, mergeable: null });
    await expectRefused(h, it1, await h.merge(it1, WRITER, "m2"), /still working out whether the branch merges cleanly/);
  });

  it("is refused for a user without permission, with the same check as /approve", async () => {
    const h = await harness();
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    await expectRefused(h, it1, await h.merge(it1, READER), /it needs write permission on this repository \(`not_a_collaborator`\)/);
    expect(h.forge.checkCalls).toEqual([]);
  });

  it("is refused for a PR the factory did not open", async () => {
    const h = await harness();
    const { item } = await h.store.createWorkItem({
      source: { type: "github_issue", id: "o/r#77", link: "https://github.com/o/r/pull/77" }, requester_id: WRITER, project: PROJECT_KEY,
      problem: "p", resources: [], adopted: { pr_number: 77, head_branch: "feature", head_sha: HEAD, allowed_paths: [], tier: null },
    }, { kind: "system", id: "system:test" });
    const r = await h.store.transition({
      id: item.id, expected_version: item.version, actor: { kind: "system", id: "t" }, reason: "setup", patch: { ...MERGE_PENDING, pr_number: 77 },
    });
    if (!r.ok) throw new Error("setup failed");
    await expectRefused(h, r.item, await h.merge(r.item), /the factory merges only the PRs it opened; merge PR #77 on the forge/);
  });
});

describe("merge command: off by default", () => {
  it("with no forge setting the request is refused with a pointer to GitHub, and nothing is read or merged", async () => {
    const h = await harness({ merge: false });
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    await expectRefused(h, it1, await h.merge(it1), /merging from the factory is off for this project .*`plugins\.forge`.*; merge PR #42 on the forge/);
    expect(h.forge.checkCalls).toEqual([]);
  });

  it("with no forge at all it is refused the same way", async () => {
    const h = await harness({ forge: false });
    const it1 = await h.itemIn(MERGE_PENDING, 1);
    await expectRefused(h, it1, await h.merge(it1), /merge PR #42 on the forge/);
  });

  it("is an app command: never read from a comment, never in a footer or the SET_UP.md table", () => {
    expect(parseComment("/merge")).toEqual({ kind: "unknown", word: "merge" });
    const ready = { phase: "merge_pending" as const, has_pr: true };
    expect(commandsFor(ready).map((c) => c.name)).not.toContain("merge");
    expect(commandFooter(ready)).not.toContain("/merge");
    expect(commandFooter(ready).split("\n").at(-1)).toBe("No command changes this item's state now.");
    expect(commandTableMarkdown()).not.toContain("/merge");
    expect(helpReply(ready)).toContain("- `/merge`: In the app only");
    expect(helpReply(ready)).not.toContain("`/merge` **(now)**");
  });

  it("the size of a ready PR is kept on its review_passed change only when merging is on", async () => {
    for (const merge of [true, false]) {
      const h = await harness({ merge });
      const it1 = await h.itemIn({ stage: "REVIEW", pr_number: PR, tier: 2 }, 1);
      const { run } = await h.store.enqueueRun({ work_item_id: it1.id, kind: "review", idempotency_key: "rv" });
      const claimed = await h.store.claimRun({ worker_id: "w" as never, kinds: ["review"], lease_ms: 60_000 });
      expect(claimed?.id).toBe(run.id);
      const done = await h.store.completeRun(run.id, claimed!.lease!.token, { status: "succeeded", data: { review: { verdict: "pass", tier: 2, findings: [], summary: "ok" } } } as never);
      expect(done.ok).toBe(true);
      await h.controller.tickRuns();
      const passed = (await h.store.listStateChanges(it1.id)).find((c) => c.reason === "review_passed");
      expect(passed).toBeDefined();
      expect(passed!.detail).toEqual(merge ? { lines_changed: 12, files_changed: 2 } : null);
    }
  });
});

describe("GitHub forge merge: through the bot, at the reviewed head", () => {
  class MergeClient extends GitHubClient {
    calls: { method: string; path: string; body: unknown }[] = [];
    answer: (() => unknown) | null = null;
    constructor() {
      super({} as GitHubCredentials, "http://unused");
    }
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      this.calls.push({ method, path, body });
      if (method === "PUT") return (this.answer ? this.answer() : { sha: "c".repeat(40), merged: true }) as T;
      return {
        state: "open", merged: false, merge_commit_sha: null, mergeable: true, head: { ref: "factory/x", sha: HEAD }, base: { ref: "main", sha: "d".repeat(40) },
        additions: 10, deletions: 5, changed_files: 3,
      } as T;
    }
  }
  const forgeWith = (client: MergeClient): Forge =>
    new GitHubForge(client, { owner: "o", name: "r" }, "factory/", "main", { postComment: async () => ({ url: null }), setStatus: async () => undefined });

  it("merges with one PUT naming the reviewed head as sha and no item text", async () => {
    const client = new MergeClient();
    const r = await forgeWith(client).mergePr({ pr_number: PR, branch: "factory/x", base_ref: "main", head_sha: HEAD });
    expect(r).toEqual({ merged: true, merge_sha: "c".repeat(40) });
    expect(client.calls).toEqual([{ method: "PUT", path: "/repos/o/r/pulls/42/merge", body: { sha: HEAD } }]);
  });

  it("reads the PR's state, head, mergeable and size in one GET", async () => {
    const client = new MergeClient();
    expect(await forgeWith(client).prMergeState(PR, "factory/x")).toEqual({ state: "open", head_sha: HEAD, mergeable: true, merge_sha: null, lines: 15, files: 3 });
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/o/r/pulls/42"]);
  });

  it("GitHub's 405 and 409 are refusals in fixed words", async () => {
    for (const [status, words] of [[405, /GitHub refused the merge/], [409, /head moved after the review/]] as const) {
      const client = new MergeClient();
      client.answer = () => {
        throw new GitHubError(status, "secret-looking GitHub text");
      };
      const r = await forgeWith(client).mergePr({ pr_number: PR, branch: "factory/x", base_ref: "main", head_sha: HEAD });
      expect(r.merged).toBe(false);
      expect(!r.merged && r.reason).toMatch(words);
      expect(JSON.stringify(r)).not.toContain("secret-looking");
    }
  });
});
