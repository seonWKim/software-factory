import { describe, expect, it } from "vitest";
import { OwnerAuth } from "../src/core/authorize.js";
import { type DependencyLink, type DependencySource, parseDependsOn } from "../src/core/coordination.js";
import { buildTask } from "../src/core/task-build.js";
import type { DependencyState, SourceRef, UserId, WorkItemId, WorkItemPatch } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { SourceAdapter } from "../src/interfaces/source-adapter.js";
import { whyWaiting } from "../src/ui/why.js";
import { whyText } from "../web/src/lib/format.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore, system, w1 } from "./helpers/store.js";

// Local items honour `Depends on:` lines naming wi_ or tk_ ids (design 05-dependencies): the local source resolves
// each id to the named local item's source id through the store alone, and the coordination path holds, releases
// or blocks the item as it does for `#N`. The hold reason names the wi_ id.

const ME = "local:me@example.com" as UserId;

/** A GitHub source that fails every dependency read, and counts them: local resolution never reaches it. */
class FailingGitHub extends FakeSource implements DependencySource {
  calls = 0;
  async dependencyLinks(_s: SourceRef): Promise<DependencyLink[]> {
    this.calls++;
    throw new Error("network down");
  }
  async dependencyState(_id: string): Promise<DependencyState> {
    this.calls++;
    throw new Error("network down");
  }
}

async function setup(extra: SourceAdapter[] = []) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store), ...extra], auth: new OwnerAuth(store), clock, config, log: silent, scanner: cleanScanner,
  });
  let n = 0;
  /** A local item with `problem`, moved to `patch` (default: implementing with a queued implement run). */
  const item = async (problem: string, patch: WorkItemPatch = {}, implement = true): Promise<WorkItemId> => {
    const id = `local-dep-${++n}`;
    const source = { type: "local" as const, id, link: `local:${id}` };
    const { item: it } = await store.createWorkItem({ source, title: `item ${n}`, requester_id: ME, project: PROJECT_KEY, problem, resources: [] }, system);
    await store.transition({
      id: it.id, expected_version: 1, actor: system, reason: "x",
      patch: { stage: "RUNNING", tier: 2, allowed_paths: ["lib/"], files_to_change: [`lib/${n}.ts`], ...patch },
      ...(implement ? { enqueue: { kind: "implement" as const, idempotency_key: `${id}:implement` } } : {}),
    });
    return it.id;
  };
  /** A local item waiting for its merge: what `factory merge` lands. */
  const mergeable = () => item("the first part", { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" }, false);
  const claim = () => store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 });
  const get = async (id: WorkItemId) => (await store.getWorkItem(id))!;
  const reasons = async (id: WorkItemId) => (await store.listStateChanges(id)).map((c) => c.reason);
  const merge = async (id: WorkItemId) =>
    (await controller.unit("local-merge")).merged(id, ME, `merge:${id}`, { sha: "m1", already: false, not_updated: [] }, {});
  return { store, clock, controller, item, mergeable, claim, get, reasons, merge };
}

describe("local items: Depends on lines naming wi_ and tk_ ids (design 05-dependencies)", () => {
  it("holds the item until the wi_ item merges through the local merge, then releases it and its run is claimed", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.item(`the second part\n\nDepends on: ${x}`);
    await f.controller.tickCoordination();
    expect(await f.get(a)).toMatchObject({ stage: "RUNNING", blocked_on: "dependency", blocked_reason: `waiting for ${x} to merge` });
    expect(await f.reasons(a)).toContain("dependency_hold");
    expect(await f.claim()).toBeNull();
    // The comment in the item's thread names the wi_ id too.
    await f.controller.tickOutbox();
    expect((await f.store.listItemMessages(a)).map((m) => m.body).join("\n")).toContain(`waiting for ${x} to merge`);
    // The dashboard's why: the reason text names what it waits for.
    const held = await f.get(a);
    const why = whyWaiting({ item: held, run: null, decision: null, pauses: {}, not_before: null, phases: { waiting_on: 0, waiting_on_number: null } });
    expect(whyText(why)).toBe(`Waiting for ${x} to merge`);

    expect(await f.merge(x)).toBe("landed");
    expect(await f.get(x)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m1" });
    expect(await f.get(a)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    const r = await f.reasons(a);
    expect(r.indexOf("dependency_released")).toBeGreaterThan(r.indexOf("dependency_hold"));
    expect(await f.claim()).toMatchObject({ work_item_id: a, kind: "implement" });
  });

  it("a tk_ id resolves through the task's linked work item and holds the same way, naming the wi_ id", async () => {
    const f = await setup();
    await f.store.addTask({ id: "tk_first", title: "First part", list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: ME });
    const built = await buildTask(f.store, "tk_first", PROJECT_KEY, ME);
    if (!built.ok) throw new Error(built.reason);
    const x = built.item.id;
    const a = await f.item("the second part\n- Depends on: tk_first");
    await f.controller.tickCoordination();
    expect(await f.get(a)).toMatchObject({ blocked_on: "dependency", blocked_reason: `waiting for ${x} to merge` });
    expect(await f.claim()).toBeNull();
  });

  it("when the wi_ item closes without a merge: blocked on a human, dependency_closed:<wi_ id>, queued runs cancelled", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.item(`Depends on: ${x}`);
    await f.controller.tickCoordination();
    expect((await f.get(a)).blocked_on).toBe("dependency");
    const cur = await f.get(x);
    await f.store.transition({
      id: x, expected_version: cur.version, actor: system, reason: "closed",
      patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null },
    });
    await f.controller.tickCoordination();
    expect(await f.get(a)).toMatchObject({ blocked_on: "human", blocked_reason: `dependency_closed:${x}` });
    expect((await f.store.listRuns(a)).filter((run) => run.status === "queued")).toEqual([]);
  });

  it("an id naming no local item creates no edge: not held, no comment", async () => {
    const f = await setup();
    const a = await f.item("Depends on: wi_nosuchitem, tk_nosuchtask");
    await f.controller.tickCoordination();
    await f.controller.tickOutbox();
    expect(await f.store.listDependencyEdges({ work_item_id: a })).toEqual([]);
    expect(await f.get(a)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    expect(await f.store.listItemMessages(a)).toEqual([]);
    expect(await f.claim()).toMatchObject({ work_item_id: a });
  });

  it("makes no network call: with a failing GitHub source beside it, the local hold still applies and GitHub is not asked", async () => {
    const github = new FailingGitHub();
    const f = await setup([github]);
    const x = await f.mergeable();
    const a = await f.item(`Depends on: ${x}`);
    await f.controller.tickCoordination();
    expect(await f.get(a)).toMatchObject({ blocked_on: "dependency", blocked_reason: `waiting for ${x} to merge` });
    expect(github.calls).toBe(0);
  });

  it("the GitHub parser reads the same lines and ignores wi_ and tk_ ids", () => {
    expect(parseDependsOn("Depends on: #12, wi_abc\n- depends on tk_x and o/other#4", "o/r")).toEqual(["o/r#12", "o/other#4"]);
  });
});
