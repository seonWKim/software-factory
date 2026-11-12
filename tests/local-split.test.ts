import { OwnerAuth } from "../src/core/authorize.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { type CliAction, type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import { PHASE_HOLD, PHASES_OPEN, SPLIT_FILING, phaseMarker } from "../src/core/split.js";
import type { CloseReason, RunOutcome, SourceRef, UserId, WorkItem, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SubIssueInput } from "../src/interfaces/source-adapter.js";
import { FakeAuth, FakeSlackPollSource, cleanScanner, config, silent, slackRef, triageSpec } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore, system, w1 } from "./helpers/store.js";

// Split specs on a local task (design 04): with only the `local` source, `factory approve <parent>` files each
// phase as a local work item (source id `<parent>-phase-<n>`), holds the later ones, and closes the parent last.

const DAY = 24 * 60 * 60 * 1000;
const ME = "local:me@example.com" as UserId;

const bigSpec = {
  ...triageSpec,
  estimated_lines: 2600,
  estimated_files: 30,
  phases: [1, 2, 3].map((n) => ({ title: `Part ${n}`, problem: `Problem of part ${n}`, done_criteria: [`part ${n} works`], allowed_paths: [`src/p${n}/`] })),
};

/** The local source, made to fail once on one phase: a filing that stops part way. */
class FlakyLocal extends LocalSource {
  failPhase: number | null = null;
  override async fileSubIssue(input: SubIssueInput): Promise<SourceRef> {
    if (this.failPhase !== null && input.marker.endsWith(`:${this.failPhase} -->`)) {
      this.failPhase = null;
      throw new Error("disk full");
    }
    return super.fileSubIssue(input);
  }
}

async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const local = new FlakyLocal(store);
  const auth = new OwnerAuth({ store: store, claimer: null });
  const controller = new ControllerRole({ store, sources: [local], auth, clock, config, log: silent, scanner: cleanScanner });
  let n = 0;
  const cli = (a: CliAction) => {
    const d: LocalCliDeps = { store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "the body", newId: () => `id${++n}` };
    return runLocalCli(d, a);
  };
  const triaged = async () => {
    clock.advance(DAY);
    const run = await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 });
    const outcome: RunOutcome = { status: "succeeded", summary: "s", data: { spec: bigSpec } };
    await store.completeRun(run!.id, run!.lease!.token, outcome);
    await controller.tickRuns();
  };
  /** A parent with its split spec at the gate. */
  const parent = async (): Promise<WorkItem> => {
    const id = (await cli({ action: "create", title: "Big change", bodyFile: "b" })).lines[0] as WorkItemId;
    await controller.tickIntake();
    await triaged();
    const it = (await store.getWorkItem(id))!;
    expect(it).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    return it;
  };
  const approve = async (id: WorkItemId) => {
    expect((await cli({ action: "command", command: "approve", id, text: "" })).code).toBe(0);
    await controller.tickIntake();
  };
  const close = async (id: WorkItemId, close_reason: CloseReason) => {
    const cur = (await store.getWorkItem(id))!;
    const r = await store.transition({
      id, expected_version: cur.version, patch: { stage: "CLOSED", close_reason, blocked_on: "none", blocked_reason: null }, actor: system, reason: "closed",
    });
    expect(r.ok).toBe(true);
  };
  const get = async (id: WorkItemId) => (await store.getWorkItem(id))!;
  const messages = async (id: WorkItemId) => (await store.listItemMessages(id)).map((m) => m.body);
  return { clock, store, local, controller, parent, approve, close, get, messages };
}

afterEach(() => vi.restoreAllMocks());

describe("split spec on a local task", () => {
  it("approve files one local work item per phase, in order, holds the later ones, and the parent waits on them", async () => {
    const f = await setup();
    const p = await f.parent();
    await f.approve(p.id);

    const phases = await f.store.listPhases(p.id);
    expect(phases.map((x) => x.phase)).toEqual([1, 2, 3]);
    for (const [i, x] of phases.entries()) {
      expect(x.parent_id).toBe(p.id);
      expect(x.source).toEqual({ type: "local", id: `${p.source.id}-phase-${i + 1}`, link: `local:${p.source.id}-phase-${i + 1}` });
      expect(x.title).toBe(`Phase ${i + 1}/3: Part ${i + 1}`);
      expect(x.requester_id).toBe(ME);
    }
    const [one, two, three] = phases as [WorkItem, WorkItem, WorkItem];
    expect(one).toMatchObject({ stage: "NEW", blocked_on: "none" });
    expect((await f.store.listRuns(one.id)).map((r) => [r.kind, r.status])).toEqual([["triage", "queued"]]);
    for (const x of [two, three]) {
      expect(x).toMatchObject({ stage: "NEW", blocked_on: "upstream", blocked_reason: PHASE_HOLD });
      expect(await f.store.listRuns(x.id)).toEqual([]);
    }

    expect(await f.get(p.id)).toMatchObject({ stage: "READY", blocked_on: "upstream", blocked_reason: PHASES_OPEN });
    const split = await f.messages(p.id);
    expect(split.filter((b) => b.startsWith("The split spec was approved"))).toHaveLength(1);
    expect(split.find((b) => b.startsWith("The split spec was approved"))).toContain(`local:${p.source.id}-phase-1 (starts now)`);
    // The local source files its own sub-tasks: the split comment, never the fallback's one-line list.
    expect(split.some((b) => b.startsWith("The split spec was approved, so the factory filed its 3 phases as local tasks"))).toBe(false);
    // The parent is never implemented.
    await f.controller.tickPhases();
    expect((await f.store.listRuns(p.id)).filter((r) => r.kind === "implement")).toEqual([]);
  });

  it("a failed filing is outbound's retry, through the local target: the next phases wait, then each is filed once", async () => {
    const f = await setup();
    const p = await f.parent();
    f.local.failPhase = 2;
    await f.approve(p.id);
    const first = await f.store.listPhases(p.id);
    expect(first.map((x) => x.phase)).toEqual([1]);
    // Not refused: the approval stands and the filing waits for outbound's retry.
    expect(await f.get(p.id)).toMatchObject({ blocked_on: "upstream", blocked_reason: SPLIT_FILING });
    expect((await f.messages(p.id)).some((b) => b.includes("is filing the 3 phases of this split"))).toBe(true);

    f.clock.advance(config.retry_max_ms);
    await f.controller.tickOutbox();
    const again = await f.store.listPhases(p.id);
    expect(again.map((x) => x.phase)).toEqual([1, 2, 3]);
    expect(again[0]!.id).toBe(first[0]!.id);
    expect(new Set(again.map((x) => x.source.id)).size).toBe(3);
    expect(await f.get(p.id)).toMatchObject({ blocked_reason: PHASES_OPEN });
  });

  it("each phase closed as completed releases the next; the last one closes the parent as completed with one comment", async () => {
    const f = await setup();
    const fetch = vi.spyOn(globalThis, "fetch");
    const p = await f.parent();
    await f.approve(p.id);
    const [one, two, three] = (await f.store.listPhases(p.id)) as [WorkItem, WorkItem, WorkItem];

    await f.close(one.id, "completed");
    await f.controller.tickPhases();
    expect(await f.get(two.id)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    expect((await f.store.listRuns(two.id)).map((r) => r.kind)).toEqual(["triage"]);
    expect(await f.get(three.id)).toMatchObject({ blocked_reason: PHASE_HOLD });

    await f.close(two.id, "completed");
    await f.controller.tickPhases();
    await f.close(three.id, "completed");
    await f.controller.tickPhases();
    await f.controller.tickPhases();
    expect(await f.get(p.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect((await f.messages(p.id)).filter((b) => b.startsWith("Closed because"))).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a phase closed any other way keeps the next phase held and the parent open", async () => {
    const f = await setup();
    const p = await f.parent();
    await f.approve(p.id);
    const [one, two] = (await f.store.listPhases(p.id)) as [WorkItem, WorkItem];
    await f.close(one.id, "wont_do");
    await f.controller.tickPhases();
    expect(await f.get(two.id)).toMatchObject({ stage: "NEW", blocked_on: "upstream", blocked_reason: PHASE_HOLD });
    expect(await f.get(p.id)).toMatchObject({ stage: "READY", blocked_reason: PHASES_OPEN });
  });
});

describe("LocalSource.fileSubIssue", () => {
  const parent: SourceRef = { type: "local", id: "local-abc", link: "local:local-abc" };
  const input = (n: number): SubIssueInput => ({ parent, title: `Phase ${n}/2: x`, body: "b", marker: phaseMarker("wi_p" as WorkItemId, n) });
  /** A store that fails on any call: filing reads and writes nothing. */
  const noStore = new Proxy({}, { get: () => () => { throw new Error("store touched"); } }) as FactoryStore;

  it("derives the same ref from the same input, with no network call and no store access", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const s = new LocalSource(noStore);
    const a = await s.fileSubIssue(input(2));
    expect(a).toEqual({ type: "local", id: "local-abc-phase-2", link: "local:local-abc-phase-2" });
    expect(await s.fileSubIssue(input(2))).toEqual(a);
    expect((await s.fileSubIssue(input(1))).id).toBe("local-abc-phase-1");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a parent that is not local and a marker with no phase number", async () => {
    const s = new LocalSource(noStore);
    await expect(s.fileSubIssue({ ...input(1), parent: { type: "github_issue", id: "o/r#1", link: "x" } })).rejects.toThrow(/not a local item/);
    await expect(s.fileSubIssue({ ...input(1), marker: "nope" })).rejects.toThrow(/no phase number/);
  });
});

describe("split spec on an item whose source cannot file sub-issues (a Slack thread)", () => {
  /** The fake Slack source without fileSubIssue, as the Slack adapter is. */
  async function slackSetup() {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const slack = new FakeSlackPollSource();
    Object.defineProperty(slack, "fileSubIssue", { value: undefined });
    const local = new LocalSource(store);
    const controller = new ControllerRole({ store, sources: [slack, local], auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const requester = { provider: "slack", subject: "1" } as const;
    slack.queue.push({ kind: "item_requested", source: slackRef(1), requester, title: "Big change", body: "do it all" });
    await controller.tickIntake();
    clock.advance(DAY);
    const run = await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 });
    await store.completeRun(run!.id, run!.lease!.token, { status: "succeeded", summary: "s", data: { spec: bigSpec } });
    await controller.tickRuns();
    const parent = (await store.getWorkItemBySource("slack_thread", slackRef(1).id))!;
    expect(parent).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    let comment = 1000;
    const approve = async () => {
      slack.queue.push({ kind: "spec_approved", source: slackRef(1), comment_id: String(++comment), approver: requester });
      await controller.tickIntake();
      await controller.tickOutbox();
    };
    return { clock, store, slack, controller, parent, approve };
  }

  it("approve files one local phase item per phase, in order, held after the first, and lists them in one line on the thread", async () => {
    const f = await slackSetup();
    await f.approve();

    const phases = await f.store.listPhases(f.parent.id);
    expect(phases.map((x) => [x.parent_id, x.phase])).toEqual([[f.parent.id, 1], [f.parent.id, 2], [f.parent.id, 3]]);
    const ids = [1, 2, 3].map((n) => `${slackRef(1).id}-phase-${n}`);
    expect(phases.map((x) => x.source)).toEqual(ids.map((id) => ({ type: "local", id, link: `local:${id}` })));
    const [one, two, three] = phases as [WorkItem, WorkItem, WorkItem];
    expect(one).toMatchObject({ stage: "NEW", blocked_on: "none" });
    expect((await f.store.listRuns(one.id)).map((r) => r.kind)).toEqual(["triage"]);
    for (const x of [two, three]) expect(x).toMatchObject({ stage: "NEW", blocked_on: "upstream", blocked_reason: PHASE_HOLD });
    expect(await f.store.getWorkItem(f.parent.id)).toMatchObject({ stage: "READY", blocked_on: "upstream", blocked_reason: PHASES_OPEN });

    // One line on the parent's Slack thread, listing the phases in order; no refusal.
    const lines = f.slack.comments.filter((c) => c.source.id === slackRef(1).id && c.body.includes("as local tasks"));
    expect(lines).toHaveLength(1);
    const line = lines[0]!.body;
    expect(line).not.toContain("\n");
    expect(line.indexOf(`local:${ids[0]}`)).toBeLessThan(line.indexOf(`local:${ids[1]}`));
    expect(line.indexOf(`local:${ids[1]}`)).toBeLessThan(line.indexOf(`local:${ids[2]}`));
    expect(f.slack.comments.some((c) => c.body.includes("cannot file sub-issues"))).toBe(false);
  });

  it("approve again files no second local phase item", async () => {
    const f = await slackSetup();
    await f.approve();
    const first = await f.store.listPhases(f.parent.id);
    await f.approve();
    await f.controller.tickPhases();
    const again = await f.store.listPhases(f.parent.id);
    expect(again.map((x) => x.id)).toEqual(first.map((x) => x.id));
  });

  it("each phase closed as completed releases the next; the last closes the Slack parent as completed", async () => {
    const f = await slackSetup();
    await f.approve();
    const phases = await f.store.listPhases(f.parent.id);
    for (const [i, x] of phases.entries()) {
      const cur = (await f.store.getWorkItem(x.id))!;
      if (i > 0) expect(cur).toMatchObject({ blocked_on: "none", blocked_reason: null });
      const r = await f.store.transition({
        id: x.id, expected_version: cur.version, patch: { stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null }, actor: system, reason: "closed",
      });
      expect(r.ok).toBe(true);
      await f.controller.tickPhases();
    }
    await f.controller.tickPhases();
    await f.controller.tickOutbox();
    expect(await f.store.getWorkItem(f.parent.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect(f.slack.closed.map((s) => s.id)).toEqual([slackRef(1).id]);
  });
});
