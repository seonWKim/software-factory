import type { Actor, UserId, WorkerId } from "../../src/core/types.js";
import type { FactoryStore, NewWorkItem } from "../../src/interfaces/factory-store.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../../src/impl/store/sqlite/sqlite-driver.js";

/** The project key test items carry (the configured repo o/r, see PROJECT in fakes.ts). */
export const PROJECT_KEY = "github:github.com:R_kgDOrepo1";
/** Another repository's key, for tests that need two projects. */
export const OTHER_PROJECT_KEY = "github:github.com:R_kgDOrepo2";

export async function newStore(clock = new FakeClock()) {
  const store = new SqlFactoryStore(new SqliteDriver(":memory:"), clock);
  await store.migrate();
  return { store, clock };
}

export interface Backend {
  name: string;
  make(clock?: FakeClock): Promise<{ store: FactoryStore; clock: FakeClock }>;
}

export const BACKENDS: Backend[] = [{ name: "sqlite", make: newStore }];

export const system: Actor = { kind: "system", id: "system:test" };
export const human: Actor = { kind: "user", id: "github:1" as UserId };
export const w1 = "worker-1" as WorkerId;
export const w2 = "worker-2" as WorkerId;

export function issue(n: number): NewWorkItem {
  return {
    source: { type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` },
    requester_id: "github:1" as UserId,
    project: PROJECT_KEY,
    problem: `problem ${n}`,
    resources: [],
  };
}
