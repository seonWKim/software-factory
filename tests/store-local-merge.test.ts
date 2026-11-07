import { describe, expect, it } from "vitest";
import type { Actor, UserId, WorkItem } from "../src/core/types.js";
import type { FactoryStore, TransitionInput } from "../src/interfaces/factory-store.js";
import { BACKENDS, PROJECT_KEY, system } from "./helpers/store.js";

// The local merge's store contract (design 05-sources, Local items beside a forge; issue #333): closing a merged local
// change is one conditional update of its item, from merge_pending to CLOSED on the version it read, so two workers
// (or replicas) merging the same change at once leave one change row in state merged and one `local_merged` row.
// No new table or column: the item's version is the condition. MySQL joins when SF_TEST_MYSQL_URL is set, where the
// two updates run on separate connections.

const ME = "local:me@example.com" as UserId;
const approver: Actor = { kind: "user", id: ME };

/** A local item waiting for its merge: REVIEW, merge_pending, no PR. */
async function mergePending(store: FactoryStore): Promise<WorkItem> {
  const { item } = await store.createWorkItem(
    { source: { type: "local", id: "local:1", link: "" }, requester_id: ME, project: PROJECT_KEY, problem: "p", resources: [] },
    system,
  );
  const r = await store.transition({
    id: item.id, expected_version: item.version, actor: system, reason: "review_passed",
    patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" },
  });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

/** The local merge's close of `item` on the version it read, as Controller.mergeLocal writes it. */
function close(item: WorkItem, merge_sha: string): TransitionInput {
  return {
    id: item.id, expected_version: item.version, actor: approver, reason: "local_merged",
    patch: { stage: "CLOSED", close_reason: "completed", merge_sha, blocked_on: "none", blocked_reason: null },
    detail: { branch: `factory/${item.id}`, base_ref: "main" },
  };
}

async function expectOneMerge(store: FactoryStore, item: WorkItem, results: { ok: boolean }[], shas: string[]): Promise<void> {
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ ok: false, reason: "version_conflict" })]);
  const after = (await store.getWorkItem(item.id))!;
  expect(after).toMatchObject({ stage: "CLOSED", close_reason: "completed", blocked_on: "none", version: item.version + 1 });
  expect(shas).toContain(after.merge_sha);
  expect((await store.listStateChanges(item.id)).filter((c) => c.reason === "local_merged")).toHaveLength(1);
}

describe.each(BACKENDS)("local merge store contract: $name", ({ make }) => {
  it("two merges of one local change at once: one conditional update wins, one change row in state merged", async () => {
    const { store } = await make();
    const item = await mergePending(store);
    const results = await Promise.all([store.transition(close(item, "a".repeat(40))), store.transition(close(item, "b".repeat(40)))]);
    await expectOneMerge(store, item, results, ["a".repeat(40), "b".repeat(40)]);
  });

  it("a merge that read the item before another closed it changes nothing", async () => {
    const { store } = await make();
    const item = await mergePending(store);
    expect((await store.transition(close(item, "a".repeat(40)))).ok).toBe(true);
    const late = await store.transition(close(item, "b".repeat(40)));
    expect(late).toMatchObject({ ok: false, reason: "version_conflict" });
    expect((await store.getWorkItem(item.id))!.merge_sha).toBe("a".repeat(40));
    expect((await store.listStateChanges(item.id)).filter((c) => c.reason === "local_merged")).toHaveLength(1);
  });
});
