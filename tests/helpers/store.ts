import type { Actor, UserId, WorkerId } from "../../src/core/types.js";
import type { NewWorkItem } from "../../src/interfaces/factory-store.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { SqliteFactoryStore } from "../../src/impl/store/sqlite/sqlite-store.js";

export async function newStore(clock = new FakeClock()) {
  const store = new SqliteFactoryStore(":memory:", clock);
  await store.migrate();
  return { store, clock };
}

export const system: Actor = { kind: "system", id: "system:test" };
export const human: Actor = { kind: "user", id: "github:1" as UserId };
export const w1 = "worker-1" as WorkerId;
export const w2 = "worker-2" as WorkerId;

export function issue(n: number): NewWorkItem {
  return {
    source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` },
    requester_id: "github:1" as UserId,
    project: "o/r",
    problem: `problem ${n}`,
    resources: [],
  };
}
