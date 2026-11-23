import type { Tier } from "../../src/core/types.js";
import type { FactoryStore } from "../../src/interfaces/factory-store.js";
import type { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { issue, system } from "./store.js";

let seeded = 0;

/**
 * Seeds `tier`'s merge record (design 06-measurement) through the store's own merge transition: `merges` closed,
 * merged items (default 50, a met record), the last `bad` of them reverted. The clock moves 1 ms per merge, so the
 * record's order is the seeding order. Returns the merged items' ids, oldest first.
 */
export async function seedMergeRecord(
  store: FactoryStore, clock: FakeClock, o: { tier: Tier; merges?: number; bad?: number },
): Promise<string[]> {
  const ids: string[] = [];
  const merges = o.merges ?? 50;
  for (let i = 0; i < merges; i++) {
    const n = 900_000 + ++seeded;
    const { item } = await store.createWorkItem(issue(n), system);
    clock.advance(1);
    const r = await store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "pr_merged",
      patch: { stage: "CLOSED", close_reason: "completed", merge_sha: `seed${n}`, tier: o.tier, blocked_on: "none", blocked_reason: null },
    });
    if (!r.ok) throw new Error(r.reason);
    if (i >= merges - (o.bad ?? 0)) {
      const rev = await store.transition({ id: item.id, expected_version: r.item.version, patch: {}, actor: system, reason: "reverted" });
      if (!rev.ok) throw new Error(rev.reason);
    }
    ids.push(item.id);
  }
  return ids;
}
