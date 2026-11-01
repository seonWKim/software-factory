import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import { parseFixReferences, parseRevert } from "../src/core/links.js";
import type { WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { newStore, issue, system } from "./helpers/store.js";
import { FakeAuth, FakeSource, alice, config, issueRef, silent } from "./helpers/fakes.js";

describe("links: revert matching", () => {
  it("finds reverted shas in `This reverts commit <sha>`", () => {
    expect(parseRevert('Revert "Add gate"\n\nThis reverts commit 0123abcd0123abcd0123abcd0123abcd0123abcd.')).toEqual({
      shas: ["0123abcd0123abcd0123abcd0123abcd0123abcd"],
      pr_numbers: [],
      reverting_pr: null,
    });
  });

  it("reads a squash-merged revert subject: the trailing (#M) is the reverting PR, other #N are candidates", () => {
    expect(parseRevert('Revert "Title (#34)" (#50)\n\nbody #99')).toEqual({ shas: [], pr_numbers: [34], reverting_pr: 50 });
    expect(parseRevert('Revert "Title (#34)"')).toEqual({ shas: [], pr_numbers: [34], reverting_pr: null });
  });

  it("ignores PR numbers in subjects that do not start with Revert", () => {
    expect(parseRevert("Fix (#34) again (#50)")).toEqual({ shas: [], pr_numbers: [], reverting_pr: null });
    expect(parseRevert('Revert "Title" (#50)')).toEqual({ shas: [], pr_numbers: [], reverting_pr: 50 });
  });
});

describe("links: fix-forward references", () => {
  it("finds `Fixes #N` and `Follow-up to #N`, case-insensitive, in order, without duplicates", () => {
    expect(parseFixReferences("fixes #34 and Follow-up to #40, also Fixes #34")).toEqual([34, 40]);
    expect(parseFixReferences("Follow up to #7")).toEqual([7]);
    expect(parseFixReferences("see #34, prefixes #12")).toEqual([]);
  });
});

async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent });
  /** A factory item whose PR `pr` merged as `sha`. */
  const merged = async (n: number, pr: number, sha: string): Promise<WorkItem> => {
    const { item } = await store.createWorkItem(issue(n), system);
    const r = await store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "pr_merged",
      patch: { stage: "CLOSED", close_reason: "completed", pr_number: pr, merge_sha: sha },
    });
    if (!r.ok) throw new Error(r.reason);
    return r.item;
  };
  const rows = async (it: WorkItem, reason: string) => (await store.listStateChanges(it.id)).filter((c) => c.reason === reason);
  return { store, source, controller, merged, rows };
}

const SHA = "0123abcd0123abcd0123abcd0123abcd0123abcd";

describe("revert tracking", () => {
  it("records a revert by commit sha on the original item without changing its state", async () => {
    const f = await setup();
    const orig = await f.merged(1, 34, SHA);
    f.source.queue.push({ kind: "base_commit", sha: "r1", message: `Revert "Add gate"\n\nThis reverts commit ${SHA}.` });
    await f.controller.tickIntake();

    const rows = await f.rows(orig, "reverted");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ reverting_commit: "r1" });
    expect(rows[0]!.changes).toEqual({});
    const after = (await f.store.getWorkItem(orig.id))!;
    expect(after).toMatchObject({
      stage: orig.stage, close_reason: orig.close_reason, blocked_on: orig.blocked_on, blocked_reason: orig.blocked_reason,
    });
  });

  it("records a revert by PR number from a squash-merged revert subject", async () => {
    const f = await setup();
    const orig = await f.merged(1, 34, "m34");
    f.source.queue.push({ kind: "base_commit", sha: "r2", message: 'Revert "Title (#34)" (#50)' });
    await f.controller.tickIntake();
    const rows = await f.rows(orig, "reverted");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ reverting_commit: "r2", reverting_pr: 50 });
  });

  it("a revert subject naming no factory PR writes nothing and does not fail", async () => {
    const f = await setup();
    const orig = await f.merged(1, 34, "m34");
    f.source.queue.push({ kind: "base_commit", sha: "r3", message: 'Revert "Other (#77)" (#78)' });
    f.source.queue.push({ kind: "base_commit", sha: "r4", message: "Revert \"No number\"" });
    await f.controller.tickIntake();
    expect(await f.store.listStateChanges(orig.id)).toHaveLength(2);
  });

  it("a commit matching both by sha and by PR number is recorded once", async () => {
    const f = await setup();
    const orig = await f.merged(1, 34, SHA);
    f.source.queue.push({ kind: "base_commit", sha: "r5", message: `Revert "Title (#34)" (#50)\n\nThis reverts commit ${SHA}.` });
    await f.controller.tickIntake();
    expect(await f.rows(orig, "reverted")).toHaveLength(1);
  });

  it("is idempotent: the same revert twice in one poll and again in a later poll yields one row", async () => {
    const f = await setup();
    const orig = await f.merged(1, 34, SHA);
    const e = { kind: "base_commit" as const, sha: "r1", message: `This reverts commit ${SHA}.` };
    f.source.queue.push(e, e);
    await f.controller.tickIntake();
    f.source.queue.push(e);
    await f.controller.tickIntake();
    expect(await f.rows(orig, "reverted")).toHaveLength(1);

    // A different commit reverting the same merge is a second row (dedupe key includes the reverting commit).
    f.source.queue.push({ ...e, sha: "r9" });
    await f.controller.tickIntake();
    expect(await f.rows(orig, "reverted")).toHaveLength(2);
  });

  it("concurrent controllers handling the same revert record it once", async () => {
    const f = await setup();
    const orig = await f.merged(1, 34, SHA);
    const other = new Controller({ store: f.store, source: f.source, auth: new FakeAuth(), clock: new FakeClock(), config, log: silent });
    const e = { kind: "base_commit" as const, sha: "r1", message: `This reverts commit ${SHA}.` };
    await Promise.all([f.controller.handleEvent(e), other.handleEvent(e), f.controller.handleEvent(e)]);
    expect(await f.rows(orig, "reverted")).toHaveLength(1);
  });
});

describe("fix-forward tracking", () => {
  it("links a new item that says `Fixes #N` to the factory item with PR N", async () => {
    const f = await setup();
    const orig = await f.merged(1, 34, "m34");
    const e = { kind: "item_requested" as const, source: issueRef(60), requester: alice, title: "Gate breaks", body: "Fixes #34" };
    f.source.queue.push(e);
    await f.controller.tickIntake();

    const fix = (await f.store.getWorkItemBySource("github_issue", issueRef(60).id))!;
    expect(fix.fixes_pr).toBe(34);
    const rows = await f.rows(orig, "fixed_forward");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ fix_work_item_id: fix.id });

    // Re-polling the same issue changes nothing.
    f.source.queue.push(e);
    await f.controller.tickIntake();
    f.source.queue.push(e);
    await f.controller.tickIntake();
    expect(await f.rows(orig, "fixed_forward")).toHaveLength(1);
    expect((await f.store.getWorkItem(fix.id))!.fixes_pr).toBe(34);
    expect((await f.store.listStateChanges(fix.id)).filter((c) => "fixes_pr" in c.changes)).toHaveLength(1);
  });

  it("accepts `Follow-up to #N` in the title", async () => {
    const f = await setup();
    const orig = await f.merged(1, 34, "m34");
    f.source.queue.push({ kind: "item_requested", source: issueRef(61), requester: alice, title: "Follow-up to #34", body: "" });
    await f.controller.tickIntake();
    const fix = (await f.store.getWorkItemBySource("github_issue", issueRef(61).id))!;
    expect(fix.fixes_pr).toBe(34);
    expect(await f.rows(orig, "fixed_forward")).toHaveLength(1);
  });

  it("a reference to a number that is not a factory PR sets nothing and writes nothing", async () => {
    const f = await setup();
    const orig = await f.merged(1, 34, "m34");
    f.source.queue.push({ kind: "item_requested", source: issueRef(62), requester: alice, title: "t", body: "Fixes #99" });
    await f.controller.tickIntake();
    const item = (await f.store.getWorkItemBySource("github_issue", issueRef(62).id))!;
    expect(item.fixes_pr).toBeNull();
    expect((await f.store.listStateChanges(item.id)).map((c) => c.reason)).toEqual(["intake"]);
    expect(await f.store.listStateChanges(orig.id)).toHaveLength(2);
  });
});
