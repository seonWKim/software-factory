import { describe, expect, it } from "vitest";
import { OwnerAuth } from "../src/core/authorize.js";
import { type DependencyLink, type DependencySource, parseDependsOn } from "../src/core/coordination.js";
import { commandFooter, itemCommandState } from "../src/core/commands.js";
import { buildTask, createLocalItem, dependencyQuestion } from "../src/core/task-build.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";
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
  await store.claimOwner(ME);
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
  /**
   * A local item filed with `body` and triaged: its spec's problem (`spec`) replaces the filed text, as triage's does,
   * and `note`'s `N:` lines answer the spec's `decisions` on its approval, which queues the implement run.
   */
  const approved = async (body: string, spec: string, decisions: string[], note: string) => {
    const { item: it } = await createLocalItem(store, { source_id: `local-dep-${++n}`, title: `item ${n}`, body, project: PROJECT_KEY, user: ME });
    const split = splitAnswers(note, decisions.map((text) => ({ text, default: "yes" })));
    if ("refuse" in split) throw new Error(split.refuse);
    const r = await store.transition({
      id: it.id, expected_version: it.version, actor: { kind: "user", id: ME }, reason: "spec_approved", detail: answersDetail(split.answers),
      patch: { stage: "RUNNING", problem: spec, tier: 2, allowed_paths: ["lib/"], files_to_change: [`lib/${n}.ts`] },
      enqueue: { kind: "implement", idempotency_key: `${it.id}:implement` },
    });
    if (!r.ok) throw new Error("setup");
    return it.id;
  };
  /** Claims `id`'s implement run and finishes it with the agent asking for a human, then applies the result. */
  const asks = async (id: WorkItemId, reason: string) => {
    const run = await claim();
    if (run?.work_item_id !== id) throw new Error("no implement run to claim");
    await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: { needs_human: { reason, question: "Should it wait?" } } });
    await controller.tickRuns();
    expect(await get(id)).toMatchObject({ blocked_on: "human", blocked_reason: "agent_needs_human" });
  };
  let cmd = 0;
  /** `/hold <text>` on `id` from the CLI, applied by the controller; the reply it posted, if any. */
  const hold = async (id: WorkItemId, text: string) => {
    const key = `cli:hold-${++cmd}`;
    await store.appendCliCommand({ key, actor: ME, command: "hold", args: { item: id, text } });
    await controller.tickCommands();
    await controller.tickOutbox();
    return (await store.listItemMessages(id)).find((m) => m.marker === `<!-- factory:refused:${key} -->`)?.body ?? null;
  };
  return { store, clock, controller, item, mergeable, claim, get, reasons, merge, approved, asks, hold };
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

describe("entry points that write the Depends on line (design 05-dependencies, 2026-11-20)", () => {
  it("triage's proposal approved yes: the next coordination pass writes `Depends on: wi_X` and holds the item until wi_X merges", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.approved(`the second part; run after ${x} merges`, "the spec's problem", [dependencyQuestion(x)], "1: yes");
    await f.controller.tickCoordination();
    expect((await f.get(a)).problem).toBe(`the spec's problem\n\nDepends on: ${x}`);
    expect(await f.get(a)).toMatchObject({ blocked_on: "dependency", blocked_reason: `waiting for ${x} to merge` });
    expect(await f.reasons(a)).toEqual(expect.arrayContaining(["depends_on_written", "dependency_hold"]));
    expect(await f.claim()).toBeNull();
    // A second pass writes nothing more.
    await f.controller.tickCoordination();
    expect((await f.reasons(a)).filter((r) => r === "depends_on_written")).toHaveLength(1);
    expect(await f.merge(x)).toBe("landed");
    expect(await f.get(a)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    expect(await f.claim()).toMatchObject({ work_item_id: a, kind: "implement" });
  });

  it("an approval that takes the default (yes) holds the same way", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.approved(`after ${x} merges`, "spec", [dependencyQuestion(x)], "");
    await f.controller.tickCoordination();
    expect(await f.get(a)).toMatchObject({ blocked_on: "dependency", blocked_reason: `waiting for ${x} to merge` });
  });

  it("triage's proposal approved no: no Depends on line, the text stays as written, and the item is not held", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.approved(`after ${x} merges`, `spec; it builds on ${x}`, [dependencyQuestion(x)], "1: no");
    await f.controller.tickCoordination();
    expect(await f.get(a)).toMatchObject({ problem: `spec; it builds on ${x}`, blocked_on: "none", blocked_reason: null });
    expect(await f.reasons(a)).not.toContain("depends_on_written");
    expect(await f.claim()).toMatchObject({ work_item_id: a });
  });

  it("`task create --depends-on`'s line, which triage's spec replaced, is written back from the filed text and holds the item", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.approved(`the body\n\nDepends on: ${x}`, "the spec's problem", [], "");
    await f.controller.tickCoordination();
    expect(await f.get(a)).toMatchObject({ problem: `the spec's problem\n\nDepends on: ${x}`, blocked_on: "dependency", blocked_reason: `waiting for ${x} to merge` });
  });

  it("an item whose links were read already is not backfilled; a later approval answering yes writes its line", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.item("the spec, read before this change");
    await f.controller.tickCoordination();
    // Its filed text gains a line only in the store (an item from before this change): no pass writes it.
    await f.store.db.run("UPDATE controller_work_items SET issue_text = ? WHERE id = ?", [`Depends on: ${x}`, a]);
    f.clock.advance(1_000);
    await f.controller.tickCoordination();
    expect(await f.get(a)).toMatchObject({ problem: "the spec, read before this change", blocked_on: "none" });
    // A new approval that answers the proposal yes (after a revision) does.
    const cur = await f.get(a);
    const split = splitAnswers("1: yes", [{ text: dependencyQuestion(x), default: "no" }]);
    if ("refuse" in split) throw new Error(split.refuse);
    f.clock.advance(1_000);
    await f.store.transition({ id: a, expected_version: cur.version, actor: { kind: "user", id: ME }, reason: "spec_approved", detail: answersDetail(split.answers), patch: {} });
    await f.controller.tickCoordination();
    expect(await f.get(a)).toMatchObject({ problem: `the spec, read before this change\n\nDepends on: ${x}`, blocked_on: "dependency" });
  });

  it("a local stop at agent_needs_human lists `/hold <id>` with its help text; a GitHub item's does not", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.item("the second part");
    await f.asks(a, `This builds on ${x}, which has not merged yet.`);
    const footer = commandFooter(itemCommandState(await f.get(a), await f.store.listRuns(a)));
    expect(footer).toContain("- `/hold <id>`: Hold until <id> merges");
    expect(commandFooter({ phase: "agent_needs_human", has_pr: false, asked_by: "implement" })).not.toContain("/hold");
    await f.controller.tickOutbox();
    expect((await f.store.listItemMessages(a)).map((m) => m.body).join("\n")).toContain("`/hold <id>`");
  });

  it("a stop whose reason names no unmerged item (none, only itself, or one already merged) does not offer `/hold` in its comment", async () => {
    const f = await setup();
    const x = await f.mergeable();
    await f.merge(x);
    for (const reason of ["The spec is unclear.", "This item needs more context.", `This builds on ${x}.`, "It builds on wi_nosuch."]) {
      const a = await f.item("the second part");
      await f.asks(a, reason.replace("This item", a));
      await f.controller.tickOutbox();
      const body = (await f.store.listItemMessages(a)).map((m) => m.body).join("\n");
      expect(body).toContain("`/retry`");
      expect(body).not.toContain("/hold");
    }
  });

  it("`/hold <id>` appends the line, holds the item on `blocked_on: dependency` with a queued implement run, and the merge releases it", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.item("the second part");
    await f.asks(a, `needs ${x}`);
    expect(await f.hold(a, x)).toBeNull();
    const held = await f.get(a);
    expect(held).toMatchObject({ problem: `the second part\n\nDepends on: ${x}`, blocked_on: "dependency", blocked_reason: `waiting for ${x} to merge` });
    expect(await f.reasons(a)).toContain("hold_requested");
    expect(await f.store.listDependencyEdges({ work_item_id: a })).toEqual([expect.objectContaining({ state: "open" })]);
    expect((await f.store.listRuns(a)).filter((r) => r.status === "queued").map((r) => r.kind)).toEqual(["implement"]);
    expect(await f.claim()).toBeNull();
    // The same row read again changes nothing and says nothing.
    await f.controller.tickCommands();
    expect((await f.get(a)).version).toBe(held.version);
    expect(await f.merge(x)).toBe("landed");
    expect(await f.get(a)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    expect(await f.claim()).toMatchObject({ work_item_id: a, kind: "implement" });
  });

  it("`/hold` refuses an id naming no local item, the item itself, an item already merged, and a bad id, naming the reason; nothing changes", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.item("the second part");
    await f.asks(a, `needs ${x}`);
    expect(await f.merge(x)).toBe("landed");
    const before = await f.get(a);
    expect(await f.hold(a, "wi_nosuch")).toBe("`/hold` was not applied: `wi_nosuch` names no local work item or built task.");
    expect(await f.hold(a, a)).toBe(`\`/hold\` was not applied: \`${a}\` is this item itself, and an item cannot wait for itself.`);
    expect(await f.hold(a, x)).toContain(`${x} is already merged`);
    expect(await f.hold(a, "soon please")).toContain("`/hold` takes one ID");
    expect(await f.get(a)).toEqual(before);
  });

  it("`/hold <short id>` on an item whose implement run is queued writes the full ID's line, and that run waits until the item merges", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.item("queued, not started");
    const [queued] = await f.store.listRuns(a);
    expect(await f.hold(a, x.slice(0, 11))).toBeNull();
    expect(await f.get(a)).toMatchObject({ problem: `queued, not started\n\nDepends on: ${x}`, blocked_on: "dependency", blocked_reason: `waiting for ${x} to merge` });
    expect(await f.reasons(a)).toContain("hold_requested");
    expect(await f.store.listDependencyEdges({ work_item_id: a })).toEqual([expect.objectContaining({ state: "open" })]);
    // The same queued run, no second one, and it is not claimed while x is open.
    expect((await f.store.listRuns(a)).map((r) => [r.id, r.status])).toEqual([[queued!.id, "queued"]]);
    expect(await f.claim()).toBeNull();
    expect(await f.merge(x)).toBe("landed");
    expect(await f.claim()).toMatchObject({ id: queued!.id, work_item_id: a, kind: "implement" });
  });

  it("`/hold` while the implement run is running is refused, saying it applies once the run ends; the run keeps running", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.item("running");
    const run = await f.claim();
    expect(run).toMatchObject({ work_item_id: a, status: "running" });
    const before = await f.get(a);
    expect(await f.hold(a, x)).toBe(
      "`/hold` was not applied: the item's implement run is running, and a running run is never stopped for a hold; `/hold <id>` applies once the run ends.",
    );
    expect(await f.get(a)).toEqual(before);
    expect((await f.store.listRuns(a)).map((r) => r.status)).toEqual(["running"]);
  });

  it("`/hold` on an item with no implement run queued or stopped for a human is refused with its phase", async () => {
    const f = await setup();
    const x = await f.mergeable();
    const a = await f.item("implementing, no run", {}, false);
    expect(await f.hold(a, x)).toContain("the item is implementing; `/hold <id>` applies only to a local item whose implement run is queued or asked for a human");
    expect((await f.get(a)).blocked_on).toBe("none");
  });
});
