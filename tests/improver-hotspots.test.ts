// Conflict hotspots (design 07-self-improvement): each improve run counts, per file, the merge_conflict and resolve
// runs whose outcome names the file in `conflicts` and the items a coordination hold kept back on it, over the last
// 7 days. A file at or over `conflict_hotspot_threshold` (default 3) is a `hotspot` row in the report's patterns and
// gets one filed task, deduped by the filed-pattern claim. No live model, no remote service.

import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { IMPROVER, SYSTEM_ITEM, patternKey, systemSource } from "../src/core/improver.js";
import { DEFAULT_HOTSPOT_THRESHOLD, HOTSPOT, conflictFiles, hotspotGroups } from "../src/core/hotspots.js";
import { SETTABLE_DEFAULTS, SETTABLE_KEYS, parseSettable } from "../src/core/settings.js";
import { Worker } from "../src/worker/index.js";
import type { ClaimDecision, ImproveReport, ImproveWindow, Run, RunId, RunKind, RunOutcome, Timestamp, UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import type { AgentRunner } from "../src/interfaces/agent-runner.js";
import type { EgressScanner, ScanResult } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeAuth, FakeBroker, FakeSandbox, MemoryStorage, PROJECT, config, prompts, silent } from "./helpers/fakes.js";

const noRunner = { run: () => { throw new Error("the improve run called the agent runner"); } } as unknown as AgentRunner;

/** Records every scan; flags any text with `LEAK` in it. */
class RecordingScanner implements EgressScanner {
  scans: { channel: string; content: string }[] = [];
  async scan(channel: Parameters<EgressScanner["scan"]>[0], content: string): Promise<ScanResult> {
    this.scans.push({ channel, content });
    return content.includes("LEAK") ? { clean: false, findings: [{ rule: "test_leak", channel }] } : { clean: true };
  }
}

/** Under a default hotspot folder, so two items changing it hold each other (weight 3, max cost 2.5). */
const FILE = "src/worker/runner.ts";
const DAY: ImproveWindow = { window_start: "2026-03-04T00:00:00.000Z" as Timestamp, window_end: "2026-03-05T00:00:00.000Z" as Timestamp };
const NEXT_DAY: ImproveWindow = { window_start: DAY.window_end, window_end: "2026-03-06T00:00:00.000Z" as Timestamp };

async function setup() {
  const clock = new FakeClock("2026-03-04T01:00:00.000Z");
  const { store } = await newStore(clock);
  const scanner = new RecordingScanner();
  const controller = new ControllerRole({ store, sources: [new LocalSource(store)], auth: new FakeAuth(), clock, config, log: silent, scanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: noRunner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config, prompts, log: silent, scanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  let n = 0;
  /** A finished run of a new item: `kind` with `outcome`, finished now (then the clock moves a second). */
  const finish = async (kind: RunKind, outcome: RunOutcome): Promise<RunId> => {
    n++;
    await store.createWorkItem(issue(n), system, { enqueue: { kind, idempotency_key: `${kind}${n}` } });
    const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: [kind], lease_ms: 60_000 }))!;
    await store.completeRun(run.id, run.lease!.token, outcome);
    clock.advance(1_000);
    return run.id;
  };
  /** An implement run that failed with merge_conflict on `files`, its detail its own (as each run names other files), so no failure group forms. */
  const conflict = (files: string[] = [FILE]) => {
    const other = `other-${String.fromCharCode(97 + n)}.ts`;
    return finish("implement", { status: "failed", error_code: "merge_conflict", detail: `x; conflicting files: ${[...files, other].join(", ")}`, infra: false, conflicts: files });
  };
  /**
   * Two items that both change FILE: the first's implement run is claimed and left running, so the second's is held
   * (a claim decision `held` naming FILE). Returns the held item.
   */
  const held = async (): Promise<WorkItemId> => {
    const ids: WorkItemId[] = [];
    for (let i = 0; i < 2; i++) {
      n++;
      const { item } = await store.createWorkItem(issue(n), system);
      await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "x", patch: { stage: "RUNNING", files_to_change: [FILE], allowed_paths: ["src/worker/"] } });
      await store.transition({ id: item.id, expected_version: 2, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: `hold${n}` } });
      clock.advance(1_000);
      ids.push(item.id);
    }
    expect((await store.claimRun({ worker_id: "parked" as WorkerId, kinds: ["implement"], lease_ms: 1e12 }))!.work_item_id).toBe(ids[0]);
    expect(await store.claimRun({ worker_id: "parked" as WorkerId, kinds: ["implement"], lease_ms: 1e12 })).toBeNull();
    expect((await store.listClaimDecisions(ids[1]!)).map((d) => d.decision)).toEqual(["held"]);
    return ids[1]!;
  };
  const { item: sys } = await store.createWorkItem({
    source: systemSource(PROJECT.key), title: "Factory improve runs", requester_id: IMPROVER.id as UserId, project: PROJECT.key,
    problem: "", resources: [], hold: { blocked_on: "upstream", blocked_reason: SYSTEM_ITEM },
  }, IMPROVER);
  let k = 0;
  /** One improve run over `window`, worked and applied; the filed items' triage runs are parked first. */
  const improve = async (window: ImproveWindow): Promise<ImproveReport> => {
    while (await store.claimRun({ worker_id: "parked" as WorkerId, kinds: ["triage"], lease_ms: 1e12 }));
    const { run } = await store.enqueueRun({ work_item_id: sys.id, kind: "improve", idempotency_key: `improve-${++k}`, input: { improve: window } });
    expect(await worker.tick()).toBe(true);
    await controller.applyRun((await store.getRun(run.id))!);
    return (await store.getImproveReport(run.id))!;
  };
  return { clock, store, scanner, finish, conflict, held, improve };
}

/** The local work items the improver filed. */
async function filedItems(store: FactoryStore) {
  return (await store.listWorkItems(100)).filter((i) => i.source.id.startsWith("local-filed-"));
}

describe("conflict hotspots: the improve run", () => {
  it("3 conflict runs on one file file exactly one task; a 4th, while it is open, files none and comments once", async () => {
    const w = await setup();
    const runs = [await w.conflict(), await w.conflict(), await w.conflict()];
    w.clock.set("2026-03-05T06:00:00.000Z");
    const report = await w.improve(DAY);

    const items = await filedItems(w.store);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe(`Reduce conflicts on ${FILE}`);
    for (const id of runs) expect(items[0]!.problem).toContain(id);
    const row = report.patterns.find((p) => p.error_code === HOTSPOT)!;
    expect(row).toMatchObject({ detail: FILE, run_ids: runs, held_item_ids: [], filing: { status: "filed", ref: items[0]!.source } });
    expect(row.work_item_ids).toHaveLength(3);
    // Claimed through the filed-pattern row of `hotspot` plus the file path.
    expect(patternKey(row)).toBe(patternKey({ error_code: HOTSPOT, detail: FILE }));
    expect(await w.store.getFiledPattern(PROJECT.key, patternKey(row))).toMatchObject({ error_code: HOTSPOT, detail: FILE, filed_ref: items[0]!.source });
    // Not a failure group: not drafted, not in failure_groups.
    expect(report.groups.some((g) => g.error_code === HOTSPOT)).toBe(false);
    expect(row.draft).toBeUndefined();
    // The body passed the G5 comment scan before it was filed.
    expect(w.scanner.scans.some((s) => s.channel === "comment" && s.content.includes(`Reduce conflicts on ${FILE}`))).toBe(true);

    w.clock.set("2026-03-05T08:00:00.000Z");
    const fourth = await w.conflict();
    w.clock.set("2026-03-06T06:00:00.000Z");
    const next = await w.improve(NEXT_DAY);
    expect(await filedItems(w.store)).toHaveLength(1);
    const again = next.patterns.find((p) => p.error_code === HOTSPOT)!;
    expect(again.run_ids).toEqual([...runs, fourth]);
    expect(again.filing).toEqual({ status: "commented", ref: items[0]!.source, run_ids: [fourth] });
    const messages = await w.store.listItemMessages(items[0]!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toContain(fourth);
    expect(messages[0]!.body).not.toContain(runs[0]!);
  });

  it("a file with 2 counts, below the threshold, files no task and is not listed", async () => {
    const w = await setup();
    await w.conflict();
    await w.conflict();
    w.clock.set("2026-03-05T06:00:00.000Z");
    const report = await w.improve(DAY);
    expect(await filedItems(w.store)).toEqual([]);
    expect(report.patterns.some((p) => p.error_code === HOTSPOT)).toBe(false);
  });

  it("runs finished more than 7 days before the improve run's window end are not counted", async () => {
    const w = await setup();
    await w.conflict();
    w.clock.set("2026-03-05T06:00:00.000Z");
    await w.conflict();
    await w.conflict();
    // The first run finished 2026-03-04T01:00; the window ending 2026-03-12T00:00 starts 2026-03-05T00:00.
    const late: ImproveWindow = { window_start: "2026-03-11T00:00:00.000Z" as Timestamp, window_end: "2026-03-12T00:00:00.000Z" as Timestamp };
    w.clock.set("2026-03-12T06:00:00.000Z");
    const report = await w.improve(late);
    expect(report.patterns.some((p) => p.error_code === HOTSPOT)).toBe(false);
    expect(await filedItems(w.store)).toEqual([]);
  });

  it("an item held back by another item's change to the file counts once per file, with resolve runs", async () => {
    const w = await setup();
    const r1 = await w.finish("resolve", { status: "failed", error_code: "tests_failed", detail: "x", infra: false, conflicts: [FILE] });
    const r2 = await w.finish("resolve", { status: "succeeded", summary: "", data: { result: "pushed", conflicts: [FILE] } });
    const heldItem = await w.held();
    w.clock.set("2026-03-05T06:00:00.000Z");
    const report = await w.improve(DAY);
    const row = report.patterns.find((p) => p.error_code === HOTSPOT)!;
    expect(row.run_ids).toEqual([r1, r2]);
    expect(row.held_item_ids).toEqual([heldItem]);
    expect(row.work_item_ids).toContain(heldItem);
    const [item] = await filedItems(w.store);
    expect(item!.problem).toContain(heldItem);
    expect(item!.problem).toContain("Items held back by another item's change to this file: 1");
  });
});

describe("conflict hotspots: counting", () => {
  const run = (id: string, kind: RunKind, outcome: RunOutcome, item = `wi_${id}`): Run =>
    ({ id, kind, work_item_id: item, outcome, finished_at: `2026-03-04T00:00:0${id.length}.000Z` }) as unknown as Run;
  const decision = (item: string, d: ClaimDecision["decision"], paths: string[]): ClaimDecision =>
    ({ work_item_id: item, decision: d, shared: paths.map((path) => ({ path, weight: 3, conflicts: 0, hotspot: true })) }) as unknown as ClaimDecision;

  it("reads only the outcome's `conflicts` field, never the detail text", () => {
    expect(conflictFiles(run("a", "implement", { status: "failed", error_code: "merge_conflict", detail: `conflicting files: ${FILE}`, infra: false }))).toEqual([]);
    expect(conflictFiles(run("a", "implement", { status: "failed", error_code: "merge_conflict", detail: "", infra: false, conflicts: [FILE, FILE] }))).toEqual([FILE]);
    // Another failure of an implement run names no conflict; a resolve run's does.
    expect(conflictFiles(run("a", "implement", { status: "failed", error_code: "tests_failed", detail: "", infra: false, conflicts: [FILE] }))).toEqual([]);
    expect(conflictFiles(run("a", "implement", { status: "succeeded", summary: "", data: { conflicts: [FILE] } }))).toEqual([]);
  });

  it("each held item counts once per file, whatever its decisions; overlap_allowed and deadlock hold nothing back", () => {
    const decisions = [
      decision("wi_1", "held", [FILE, "web/src/i18n/en.ts"]), decision("wi_1", "timed_out", [FILE]), decision("wi_2", "approved", [FILE]),
      decision("wi_3", "overlap_allowed", [FILE]), decision("wi_4", "deadlock", [FILE]),
    ];
    const [row, ...rest] = hotspotGroups([], decisions, 2);
    expect(row).toMatchObject({ error_code: HOTSPOT, detail: FILE, run_ids: [], held_item_ids: ["wi_1", "wi_2"] });
    expect(rest).toEqual([]);
  });
});

describe("conflict hotspots: the setting", () => {
  it("conflict_hotspot_threshold is settable live, an integer of 1 or more, default 3", () => {
    expect(SETTABLE_KEYS).toContain("conflict_hotspot_threshold");
    expect(SETTABLE_DEFAULTS.conflict_hotspot_threshold).toBe(3);
    expect(DEFAULT_HOTSPOT_THRESHOLD).toBe(3);
    expect(parseSettable("conflict_hotspot_threshold", 5)).toBe(5);
    for (const bad of [0, -1, 2.5, "3"]) expect(() => parseSettable("conflict_hotspot_threshold", bad)).toThrow("conflict_hotspot_threshold must be a positive integer");
  });
});
