import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestMerges, noVerdicts } from "../src/core/merge-evaluation.js";
import type { Actor, Timestamp, UserId, WorkItem } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { recordMergeEvaluation } from "../src/impl/store/sql/merge-evaluations.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { MIGRATIONS } from "../src/impl/store/sqlite/schema.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { human, issue, newStore, system } from "./helpers/store.js";

// Per-merge evaluations (design 06-measurement): one row per merge, written by the merge's own
// transition with a conditional insert, read back with what followed the merge, from store data only.

const merger: Actor = { kind: "user", id: "github:7" as UserId };

async function item(store: FactoryStore, n: number, title?: string): Promise<WorkItem> {
  return (await store.createWorkItem({ ...issue(n), ...(title ? { title } : {}) }, system)).item;
}

async function move(store: FactoryStore, it: WorkItem, patch: Parameters<FactoryStore["transition"]>[0]["patch"], reason = "seed", actor = system) {
  const cur = (await store.getWorkItem(it.id))!;
  return store.transition({ id: it.id, expected_version: cur.version, patch, actor, reason });
}

/** Spends tokens, then merges as `sha`. */
async function merge(store: FactoryStore, it: WorkItem, sha: string, tokens = 0) {
  if (tokens > 0) await move(store, it, { token_cost: tokens, tier: 2 });
  const r = await move(store, it, { stage: "CLOSED", close_reason: "completed", merge_sha: sha, blocked_on: "none", blocked_reason: null }, "pr_merged", merger);
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

const rows = async (store: SqlFactoryStore) => store.db.all("SELECT work_item_id, merge_sha FROM controller_merge_evaluations ORDER BY work_item_id");

describe("merge evaluations: the write", () => {
  it("a merge stores exactly one evaluation, in its own transition; a close that is not a merge stores none", async () => {
    const { store } = await newStore();
    const a = await item(store, 1);
    const b = await item(store, 2);
    await merge(store, a, "sha-a", 500);
    await move(store, b, { stage: "CLOSED", close_reason: "rejected" });
    expect(await rows(store)).toEqual([{ work_item_id: a.id, merge_sha: "sha-a" }]);
    // Later transitions of the merged item add nothing.
    await move(store, a, {}, "reverted");
    expect(await rows(store)).toHaveLength(1);
  });

  it("the conditional insert run a second time inserts nothing and changes nothing", async () => {
    const { store } = await newStore();
    const merged = await merge(store, await item(store, 1), "sha-a", 100);
    const before = await store.db.all("SELECT * FROM controller_merge_evaluations");
    expect(await recordMergeEvaluation(store.db, { ...merged, token_cost: 999 }, "system:other", "2030-01-01T00:00:00.000Z" as Timestamp)).toBe(false);
    expect(await store.db.all("SELECT * FROM controller_merge_evaluations")).toEqual(before);
  });

  it("two replicas on one database applying the same merge store one evaluation", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sf-merge-eval-")), "factory.db");
    const clock = new FakeClock();
    const one = new SqlFactoryStore(new SqliteDriver(file), clock);
    await one.migrate();
    const two = new SqlFactoryStore(new SqliteDriver(file), clock);
    await two.migrate();
    const it = await item(one, 1);
    const patch = { stage: "CLOSED", close_reason: "completed", merge_sha: "sha-a", blocked_on: "none", blocked_reason: null } as const;
    // One SQLite file in one thread: the replicas take turns (two open write transactions would wait on each other).
    const results = [];
    for (const s of [one, two]) results.push(await s.transition({ id: it.id, expected_version: it.version, patch, actor: merger, reason: "pr_merged" }));
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    const stored = await two.db.all("SELECT * FROM controller_merge_evaluations");
    // The second replica's own conditional insert of the same merge is a no-op too.
    expect(await recordMergeEvaluation(two.db, (await two.getWorkItem(it.id))!, merger.id, "2030-01-01T00:00:00.000Z" as Timestamp)).toBe(false);
    expect(await one.db.all("SELECT * FROM controller_merge_evaluations")).toEqual(stored);
    expect(await rows(one)).toEqual([{ work_item_id: it.id, merge_sha: "sha-a" }]);
    await one.close();
    await two.close();
  });

  it("merges from before the table existed get no row: the migration backfills nothing", async () => {
    const step = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS controller_merge_evaluations")) + 1;
    expect(step).toBeGreaterThan(0);
    const file = join(mkdtempSync(join(tmpdir(), "sf-merge-eval-")), "factory.db");
    const old = new SqlFactoryStore(new SqliteDriver(file), new FakeClock());
    await old.migrate();
    const it = await merge(old, await item(old, 1), "sha-old", 10);
    // Back to the schema before the step, with the merged item kept.
    await old.db.run("DROP TABLE controller_merge_evaluations");
    await old.db.run("DELETE FROM schema_migrations WHERE version >= ?", [step]);
    await old.close();

    const upgraded = new SqlFactoryStore(new SqliteDriver(file), new FakeClock());
    await upgraded.migrate();
    expect((await upgraded.getWorkItem(it.id))?.merge_sha).toBe("sha-old");
    expect(await upgraded.listMergeEvaluations(null)).toEqual([]);
    await upgraded.close();
  });
});

describe("merge evaluations: the read, from store data only", () => {
  it("returns each merge with its reverts, fix-forwards, verdicts and tokens, with no sync plugin configured", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const a = await merge(store, await item(store, 1, "First"), "sha-a", 1200);
    clock.advance(60_000);
    const b = await merge(store, await item(store, 2), "sha-b", 300);
    await move(store, a, {}, "reverted");
    await move(store, a, {}, "fixed_forward");
    const cur = (await store.getWorkItem(a.id))!;
    const v = await store.recordVerdict({
      id: a.id, expected_version: cur.version, actor: human, verdict: "changes", severity: "minor", reason: "x",
      comment_id: "c1", target: "pr", implicit: false, pr_head: null,
    });
    expect(v.ok).toBe(true);

    const all = await store.listMergeEvaluations(null);
    expect(all.map((e) => e.work_item_id)).toEqual([a.id, b.id]);
    expect(all[0]).toMatchObject({
      merge_sha: "sha-a", project: a.project, tier: 2, merged_by: merger.id, token_cost: 1200, title: "First",
      reverted: 1, fixed_forward: 1, verdicts: { ...noVerdicts(), changes: 1 }, explicit: { ...noVerdicts(), changes: 1 }, critical: 0,
    });
    expect(all[1]).toMatchObject({ merge_sha: "sha-b", token_cost: 300, reverted: 0, fixed_forward: 0, verdicts: noVerdicts(), explicit: noVerdicts(), critical: 0, title: null });
    // `since` keeps only the merges at or after it.
    expect((await store.listMergeEvaluations(all[1]!.merged_at)).map((e) => e.work_item_id)).toEqual([b.id]);

    expect(digestMerges(all)).toEqual({ merged: 2, reverted: 1, fixed_forward: 1, verdicts: { ...noVerdicts(), changes: 1 }, tokens: 1500 });
  });

  it("returns each merge's explicit verdicts by kind and its critical count apart from implicit verdicts", async () => {
    const { store } = await newStore();
    const a = await merge(store, await item(store, 1), "sha-a");
    const verdict = async (i: number, v: { verdict: "accept" | "changes" | "reject"; severity: "none" | "minor" | "critical"; implicit: boolean }) => {
      const cur = (await store.getWorkItem(a.id))!;
      const r = await store.recordVerdict({
        id: a.id, expected_version: cur.version, actor: human, reason: "x", comment_id: `${v.implicit ? "implicit:" : ""}c${i}`, target: "pr",
        pr_head: v.implicit ? `h${i}` : null, ...v,
      });
      if (!r.ok) throw new Error(r.reason);
    };
    await verdict(1, { verdict: "changes", severity: "critical", implicit: false });
    await verdict(2, { verdict: "reject", severity: "minor", implicit: false });
    await verdict(3, { verdict: "accept", severity: "none", implicit: false });
    // An implicit critical (a person's push) is not an owner verdict: not in `explicit`, not in `critical`.
    await verdict(4, { verdict: "changes", severity: "critical", implicit: true });

    const [e] = await store.listMergeEvaluations(null);
    expect(e).toMatchObject({
      verdicts: { ...noVerdicts(), accept: 1, changes: 2, reject: 1 },
      explicit: { ...noVerdicts(), accept: 1, changes: 1, reject: 1 },
      critical: 1,
    });
  });

  it("`within_ms` keeps the merges of that last stretch of the store's clock", async () => {
    const clock = new FakeClock("2026-10-01T00:00:00.000Z");
    const { store } = await newStore(clock);
    const old = await merge(store, await item(store, 1), "sha-old");
    clock.advance(40 * 86_400_000);
    const recent = await merge(store, await item(store, 2), "sha-new");
    clock.advance(1000);
    const ids = async (w: Parameters<FactoryStore["listMergeEvaluations"]>[0]) => (await store.listMergeEvaluations(w)).map((e) => e.work_item_id);
    expect(await ids({ within_ms: 30 * 86_400_000 })).toEqual([recent.id]);
    expect(await ids({ within_ms: 50 * 86_400_000 })).toEqual([old.id, recent.id]);
    expect(await ids(null)).toEqual([old.id, recent.id]);
  });
});
