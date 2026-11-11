// Two controllers on one SQLite store (two replicas, each with its own connection to one database file): an item
// taken in by either controller is finished by the other, with no in-process state between them.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkerId, WorkItem } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import {
  FakeAuth, FakeBroker, FakeForge, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, cleanScanner, config, issueRef, prompts,
  silent, triageSpec,
} from "./helpers/fakes.js";

async function twoControllers() {
  const file = join(mkdtempSync(join(tmpdir(), "sf-two-controllers-")), "factory.db");
  const clock = new FakeClock();
  const storeA = new SqlFactoryStore(new SqliteDriver(file), clock);
  await storeA.migrate();
  const storeB = new SqlFactoryStore(new SqliteDriver(file), clock);
  // One repository and its forge, polled by both replicas.
  const source = new FakeSource();
  const forge = new FakeForge(source);
  const controller = (store: SqlFactoryStore) =>
    new ControllerRole({ store, source, forge, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  const a = controller(storeA);
  const b = controller(storeB);
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "fine" } }),
  });
  const worker = new Worker({
    id: "w1" as WorkerId, store: storeA, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock,
    config, prompts, log: silent, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  /** One intake tick on `c`, then the worker's runs, their results handled by `c`. */
  const step = async (c: ControllerRole) => {
    await c.tickIntake();
    while (await worker.tick()) await c.tickRuns();
    await c.tickRuns();
  };
  const item = async (n: number): Promise<WorkItem> => (await storeB.getWorkItemBySource("github_issue", issueRef(n).id))!;
  return { a, b, source, forge, step, item };
}

describe("two controllers on one SQLite store", () => {
  it("finishes an item opened by either controller: each item's approval and merge are handled by the other", async () => {
    const f = await twoControllers();
    f.source.queue.push({ kind: "item_requested", source: issueRef(1), requester: alice, title: "one", body: "b" });
    await f.step(f.a);
    f.source.queue.push({ kind: "item_requested", source: issueRef(2), requester: alice, title: "two", body: "b" });
    await f.step(f.b);
    const one = await f.item(1);
    const two = await f.item(2);
    expect([one, two].map((i) => [i.stage, i.blocked_reason])).toEqual([["READY", "spec_pending"], ["READY", "spec_pending"]]);
    f.forge.prNumbers.set(`factory/${one.id}`, 41);
    f.forge.prNumbers.set(`factory/${two.id}`, 42);

    f.source.queue.push({ kind: "spec_approved", source: issueRef(1), comment_id: "100", approver: alice });
    await f.step(f.b);
    f.source.queue.push({ kind: "spec_approved", source: issueRef(2), comment_id: "101", approver: alice });
    await f.step(f.a);
    expect(await f.item(1)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", change_ref: "41" });
    expect(await f.item(2)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", change_ref: "42" });

    f.forge.queue.push({ kind: "change_merged", change_ref: "41", head_branch: `factory/${one.id}`, merge_sha: "m41", merger: alice });
    await f.step(f.b);
    f.forge.queue.push({ kind: "change_merged", change_ref: "42", head_branch: `factory/${two.id}`, merge_sha: "m42", merger: alice });
    await f.step(f.a);
    expect(await f.item(1)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m41" });
    expect(await f.item(2)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m42" });
  });
});
