import { describe, expect, it } from "vitest";
import { type CoordinationSettings, DEFAULT_COORDINATION, pathWeight } from "../src/core/coordination.js";
import type { RunKind, WorkItemId, WorkItemPatch } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { FakeClock } from "../src/impl/clock/fake-clock.js";
// One contract for the FactoryStore (SQLite only; see helpers/store.ts).
import { BACKENDS, PROJECT_KEY, human, issue, system, w1, w2 } from "./helpers/store.js";

const LEASE = 60_000;
const ALL: RunKind[] = ["triage", "implement", "review", "update", "resolve"];
const WORKER = "src/worker/runner.ts"; // under a default hotspot folder (weight 3.0)
const ok = { status: "succeeded" as const, summary: "", data: {} };

describe.each(BACKENDS)("coordination in the store: $name", ({ make }) => {
  /** Item `n` set up with `patch` (stage RUNNING unless given) and one queued run per kind (default: implement). */
  async function item(store: FactoryStore, clock: FakeClock, n: number, patch: WorkItemPatch, kinds: RunKind[] = ["implement"]) {
    const { item } = await store.createWorkItem(issue(n), system);
    let version = 1;
    await store.transition({ id: item.id, expected_version: version++, patch: { stage: "RUNNING", ...patch }, actor: system, reason: "x" });
    for (const kind of kinds) {
      await store.transition({
        id: item.id, expected_version: version++, patch: {}, actor: system, reason: "x",
        enqueue: { kind, idempotency_key: `${n}:${kind}` },
      });
    }
    clock.advance(1_000); // created_at orders the items as written
    return item.id;
  }
  const claim = (store: FactoryStore, worker_id = w1) => store.claimRun({ worker_id, kinds: ALL, lease_ms: LEASE });
  const runOf = async (store: FactoryStore, id: WorkItemId, kind: RunKind = "implement") =>
    (await store.listRuns(id)).find((r) => r.kind === kind)!;

  describe("cost threshold", () => {
    it("two items at or above max_coordination_cost never run at once: the second claim is refused while the first runs", async () => {
      const { store, clock } = await make();
      const a = await item(store, clock, 1, { files_to_change: [WORKER], allowed_paths: ["src/worker/"] });
      const b = await item(store, clock, 2, { files_to_change: [WORKER], allowed_paths: ["src/worker/"] });
      const first = (await claim(store))!;
      expect(first.work_item_id).toBe(a);
      expect(await claim(store, w2)).toBeNull();
      expect((await runOf(store, b)).status).toBe("queued");

      // The held run's decision: shared paths with weights, total cost, threshold, holding item.
      const [held] = await store.listClaimDecisions(b);
      expect(held).toMatchObject({
        run_id: (await runOf(store, b)).id,
        decision: "held",
        holder_work_item_id: a,
        holder_ref: "#1",
        holder_kind: "running",
        shared: [{ path: WORKER, weight: 3, conflicts: 0, hotspot: true }],
        cost: 3,
        threshold: 2.5,
        fallback: false,
        approved_by: null,
      });
      // Asking again with the same answer writes no second decision.
      expect(await claim(store, w2)).toBeNull();
      expect(await store.listClaimDecisions(b)).toHaveLength(1);

      await store.completeRun(first.id, first.lease!.token, ok);
      expect(await claim(store, w2)).toMatchObject({ work_item_id: b, kind: "implement" });
    });

    it("two items below max_coordination_cost run in parallel: both claims succeed", async () => {
      const { store, clock } = await make();
      // Two ordinary shared files: 1.0 + 1.0 = 2.0 < 2.5.
      const a = await item(store, clock, 1, { files_to_change: ["lib/a.ts", "lib/b.ts"], allowed_paths: ["lib/"] });
      const b = await item(store, clock, 2, { files_to_change: ["lib/a.ts", "lib/b.ts"], allowed_paths: ["lib/"] });
      const [x, y] = await Promise.all([claim(store, w1), claim(store, w2)]);
      expect(new Set([x?.work_item_id, y?.work_item_id])).toEqual(new Set([a, b]));
      expect(await store.listClaimDecisions(b)).toEqual([]);
    });

    it("two items that each add a numbered migration step, a History line in one topic file and an index line score under 2.5: both claims succeed at once", async () => {
      const { store, clock } = await make();
      const a = await item(store, clock, 1, {
        files_to_change: ["migrations/mysql/0025-a.sql", "docs/design/05-coordination.md", "docs/design.md", "lib/a.ts"],
        allowed_paths: ["migrations/mysql/", "docs/design/", "docs/design.md", "lib/a.ts"],
      });
      const b = await item(store, clock, 2, {
        files_to_change: ["migrations/mysql/0025-b.sql", "docs/design/05-coordination.md", "docs/design.md", "lib/b.ts"],
        allowed_paths: ["migrations/mysql/", "docs/design/", "docs/design.md", "lib/b.ts"],
      });
      const [x, y] = await Promise.all([claim(store, w1), claim(store, w2)]);
      expect(new Set([x?.work_item_id, y?.work_item_id])).toEqual(new Set([a, b]));
      expect(await store.listClaimDecisions(b)).toEqual([]);
    });

    it("two items that both change a file under src/controller/ are still held; the stored decision shows a mechanical path with its weight", async () => {
      const { store, clock } = await make();
      const a = await item(store, clock, 1, { files_to_change: ["src/controller/router/router.ts", "docs/design.md"] });
      const b = await item(store, clock, 2, { files_to_change: ["src/controller/router/router.ts", "docs/design.md"] });
      expect((await claim(store))?.work_item_id).toBe(a);
      expect(await claim(store, w2)).toBeNull();
      const [held] = await store.listClaimDecisions(b);
      expect(held).toMatchObject({ decision: "held", cost: 3.25, threshold: 2.5 });
      expect(held!.shared).toEqual([
        { path: "docs/design.md", weight: 0.25, conflicts: 0, hotspot: false, mechanical: true },
        { path: "src/controller/router/router.ts", weight: 3, conflicts: 0, hotspot: true },
      ]);
    });

    it("the threshold comes from the claim input: 2.0 at a threshold of 2.0 holds", async () => {
      const { store, clock } = await make();
      await item(store, clock, 1, { files_to_change: ["lib/a.ts", "lib/b.ts"] });
      const b = await item(store, clock, 2, { files_to_change: ["lib/a.ts", "lib/b.ts"] });
      const coordination = { ...DEFAULT_COORDINATION, max_cost: 2 };
      expect(await store.claimRun({ worker_id: w1, kinds: ALL, lease_ms: LEASE, coordination })).not.toBeNull();
      expect(await store.claimRun({ worker_id: w2, kinds: ALL, lease_ms: LEASE, coordination })).toBeNull();
      expect((await store.listClaimDecisions(b))[0]).toMatchObject({ cost: 2, threshold: 2 });
    });

    it("two items sharing a hotspot file are serialized; the hotspot weight comes from the settings", async () => {
      const { store, clock } = await make();
      await item(store, clock, 1, { files_to_change: ["SET_UP.md"] });
      const b = await item(store, clock, 2, { files_to_change: ["SET_UP.md"] });
      expect(await claim(store)).not.toBeNull();
      expect(await claim(store, w2)).toBeNull();
      expect((await store.listClaimDecisions(b))[0]!.shared).toEqual([{ path: "SET_UP.md", weight: 3, conflicts: 0, hotspot: true }]);

      // The same pair with a lower configured hotspot weight runs side by side.
      const other = await make();
      await item(other.store, other.clock, 1, { files_to_change: ["SET_UP.md"] });
      await item(other.store, other.clock, 2, { files_to_change: ["SET_UP.md"] });
      const coordination = { ...DEFAULT_COORDINATION, hotspot_weight: 2 };
      expect(await other.store.claimRun({ worker_id: w1, kinds: ALL, lease_ms: LEASE, coordination })).not.toBeNull();
      expect(await other.store.claimRun({ worker_id: w2, kinds: ALL, lease_ms: LEASE, coordination })).not.toBeNull();
    });

    it("recorded conflicts raise a file's weight: 1.0 with none, 1.0 after one, 2.0 after two; an event counts once", async () => {
      const { store } = await make();
      const weight = async () => pathWeight("lib/x.ts", await store.conflictCounts(PROJECT_KEY), DEFAULT_COORDINATION).weight;
      expect(await weight()).toBe(1);
      expect(await store.recordConflicts({ project: PROJECT_KEY, paths: ["lib/x.ts", "lib/y.ts"], event_key: "wi_a:sha1" })).toBe(2);
      expect(await weight()).toBe(1);
      // The same event again (an update run and its resolve on one base merge) adds nothing.
      expect(await store.recordConflicts({ project: PROJECT_KEY, paths: ["lib/x.ts"], event_key: "wi_a:sha1" })).toBe(0);
      expect(await weight()).toBe(1);
      expect(await store.recordConflicts({ project: PROJECT_KEY, paths: ["lib/x.ts"], event_key: "wi_b:sha2" })).toBe(1);
      expect(await weight()).toBe(2);
      expect(await store.conflictCounts(PROJECT_KEY)).toEqual(new Map([["lib/x.ts", 2], ["lib/y.ts", 1]]));
    });

    it("a file with three recorded conflicts (2.5) alone holds the second item", async () => {
      const { store, clock } = await make();
      for (const k of ["e1", "e2", "e3"]) await store.recordConflicts({ project: PROJECT_KEY, paths: ["lib/x.ts"], event_key: k });
      await item(store, clock, 1, { files_to_change: ["lib/x.ts"] });
      const b = await item(store, clock, 2, { files_to_change: ["lib/x.ts"] });
      expect(await claim(store)).not.toBeNull();
      expect(await claim(store, w2)).toBeNull();
      expect((await store.listClaimDecisions(b))[0]).toMatchObject({ cost: 2.5, shared: [{ path: "lib/x.ts", weight: 2.5, conflicts: 3 }] });
    });
  });

  describe("conflict window (conflict_window_days)", () => {
    const DAY = 24 * 60 * 60_000;
    const record = async (store: FactoryStore, path: string, keys: string[]) => {
      for (const k of keys) await store.recordConflicts({ project: PROJECT_KEY, paths: [path], event_key: k });
    };

    it("conflicts all older than the window give no learned weight: an ordinary file weighs 1.0 and two items run side by side", async () => {
      const { store, clock } = await make();
      await record(store, "lib/x.ts", ["e1", "e2", "e3", "e4", "e5", "e6"]);
      clock.advance(3 * DAY + 1);
      const a = await item(store, clock, 1, { files_to_change: ["lib/x.ts"] });
      const b = await item(store, clock, 2, { files_to_change: ["lib/x.ts"] });
      const [x, y] = await Promise.all([claim(store, w1), claim(store, w2)]);
      expect(new Set([x?.work_item_id, y?.work_item_id])).toEqual(new Set([a, b]));
      expect(await store.listClaimDecisions(b)).toEqual([]);
      // The rows stay: read without a window they all still count.
      expect((await store.conflictCounts(PROJECT_KEY)).get("lib/x.ts")).toBe(6);
    });

    it("a hotspot whose conflicts are all old weighs the hotspot weight and still holds the same-file overlap", async () => {
      const { store, clock } = await make();
      await record(store, WORKER, ["e1", "e2", "e3", "e4", "e5", "e6"]);
      clock.advance(3 * DAY + 1);
      await item(store, clock, 1, { files_to_change: [WORKER] });
      const b = await item(store, clock, 2, { files_to_change: [WORKER] });
      expect(await claim(store)).not.toBeNull();
      expect(await claim(store, w2)).toBeNull();
      expect((await store.listClaimDecisions(b))[0]).toMatchObject({
        decision: "held", cost: 3, shared: [{ path: WORKER, weight: 3, conflicts: 0, hotspot: true }],
      });
    });

    it("three recent conflicts inside the window still hold a same-file overlap; old ones beside them are not counted", async () => {
      const { store, clock } = await make();
      await record(store, "lib/x.ts", ["old1", "old2", "old3", "old4"]);
      clock.advance(2 * DAY);
      await record(store, "lib/x.ts", ["new1", "new2", "new3"]);
      clock.advance(2 * DAY); // the old four are 4 days old, the new three 2 days old
      await item(store, clock, 1, { files_to_change: ["lib/x.ts"] });
      const b = await item(store, clock, 2, { files_to_change: ["lib/x.ts"] });
      expect(await claim(store)).not.toBeNull();
      expect(await claim(store, w2)).toBeNull();
      expect((await store.listClaimDecisions(b))[0]).toMatchObject({ cost: 2.5, shared: [{ path: "lib/x.ts", weight: 2.5, conflicts: 3 }] });
    });

    it("two recent conflicts raise the weight to 2.0 as before; the window comes from the claim's settings", async () => {
      const { store, clock } = await make();
      await record(store, "lib/x.ts", ["e1", "e2"]);
      clock.advance(DAY);
      await item(store, clock, 1, { files_to_change: ["lib/x.ts", "lib/y.ts"] });
      const b = await item(store, clock, 2, { files_to_change: ["lib/x.ts", "lib/y.ts"] });
      // 2.0 + 1.0 = 3.0 holds under the default 3-day window.
      expect(await claim(store)).not.toBeNull();
      expect(await claim(store, w2)).toBeNull();
      expect((await store.listClaimDecisions(b))[0]).toMatchObject({ cost: 3, shared: [{ path: "lib/x.ts", weight: 2, conflicts: 2 }, { path: "lib/y.ts", weight: 1 }] });
      // A one-day window no longer counts them (a day and the item set-up time have passed): 2.0 runs.
      const coordination = { ...DEFAULT_COORDINATION, conflict_window_days: 1 };
      expect(await store.claimRun({ worker_id: w2, kinds: ALL, lease_ms: LEASE, coordination })).toMatchObject({ work_item_id: b });
    });

    it("conflictCounts with since counts only rows at or after it; rows before stay in the table", async () => {
      const { store, clock } = await make();
      await record(store, "lib/x.ts", ["e1"]);
      clock.advance(DAY);
      const since = clock.now().toISOString() as never;
      await record(store, "lib/x.ts", ["e2"]);
      await record(store, "lib/y.ts", ["e3"]);
      expect(await store.conflictCounts(PROJECT_KEY, since)).toEqual(new Map([["lib/x.ts", 1], ["lib/y.ts", 1]]));
      expect(await store.conflictCounts(PROJECT_KEY)).toEqual(new Map([["lib/x.ts", 2], ["lib/y.ts", 1]]));
    });
  });

  describe("open PRs", () => {
    it("an open PR holds a conflicting waiting item with no run active for the PR's item; the PR's stored file list is used", async () => {
      const { store, clock } = await make();
      const pr = await item(store, clock, 1, { stage: "REVIEW", change_ref: "92", allowed_paths: ["lib/"], pr_files: [WORKER] }, []);
      const b = await item(store, clock, 2, { files_to_change: [WORKER] });
      expect(await claim(store)).toBeNull();
      expect((await store.listClaimDecisions(b))[0]).toMatchObject({
        decision: "held", holder_work_item_id: pr, holder_ref: "#92", holder_kind: "pr", cost: 3, fallback: false,
      });
      // The stored list decides: allowed_paths ["lib/"] would not overlap at all.
      const other = await make();
      await item(other.store, other.clock, 1, { stage: "REVIEW", change_ref: "92", allowed_paths: [WORKER], pr_files: ["lib/x.ts"] }, []);
      await item(other.store, other.clock, 2, { files_to_change: [WORKER] });
      expect(await claim(other.store)).not.toBeNull();
    });

    it("a PR opened before PR file lists were stored falls back to its allowed_paths, and the decision says so", async () => {
      const { store, clock } = await make();
      await item(store, clock, 1, { stage: "REVIEW", change_ref: "92", allowed_paths: ["src/worker/"], pr_files: null }, []);
      const b = await item(store, clock, 2, { files_to_change: [WORKER] });
      expect(await claim(store)).toBeNull();
      expect((await store.listClaimDecisions(b))[0]).toMatchObject({ holder_ref: "#92", holder_kind: "pr", fallback: true, cost: 3 });
    });

    it("a closed item's PR holds nothing, and an item with a PR is never cost-held itself", async () => {
      const { store, clock } = await make();
      await item(store, clock, 1, { stage: "CLOSED", close_reason: "completed", change_ref: "91", pr_files: [WORKER] }, []);
      await item(store, clock, 2, { stage: "REVIEW", change_ref: "92", pr_files: [WORKER] }, []);
      // A review fix on PR 93: conflicts with PR 92 are handled at merge, not by holding the fix.
      const fix = await item(store, clock, 3, { change_ref: "93", pr_files: [WORKER] });
      expect(await claim(store)).toMatchObject({ work_item_id: fix });
    });
  });

  describe("deadlock rule and kinds", () => {
    it("three items holding each other: the oldest run is claimed, the others wait for it", async () => {
      const { store, clock } = await make();
      const a = await item(store, clock, 1, { files_to_change: [WORKER] });
      const b = await item(store, clock, 2, { files_to_change: [WORKER] });
      const c = await item(store, clock, 3, { files_to_change: [WORKER] });
      const first = (await claim(store))!;
      expect(first.work_item_id).toBe(a);
      expect((await store.listClaimDecisions(a))[0]).toMatchObject({ decision: "deadlock", holder_kind: "waiting" });
      expect(await claim(store, w2)).toBeNull();
      for (const id of [b, c]) expect((await store.listClaimDecisions(id))[0]).toMatchObject({ decision: "held", holder_work_item_id: a });
      await store.completeRun(first.id, first.lease!.token, ok);
      expect((await claim(store, w2))?.work_item_id).toBe(b);
    });

    it("two queued items that hold each other and an open PR: the decisions name the PR; once it merges they stop naming it at once and the oldest is claimed", async () => {
      const { store, clock } = await make();
      const pr = await item(store, clock, 1, { stage: "REVIEW", change_ref: "92", pr_files: ["SET_UP.md"] }, []);
      const a = await item(store, clock, 2, { files_to_change: [WORKER, "SET_UP.md"] });
      const b = await item(store, clock, 3, { files_to_change: [WORKER, "SET_UP.md"] });
      expect(await claim(store)).toBeNull();
      // Each also shares more (6.0) with the other than with the PR (3.0), but the PR is what holds them.
      for (const id of [a, b]) {
        expect(await store.listClaimDecisions(id)).toMatchObject([{ decision: "held", holder_work_item_id: pr, holder_kind: "pr", cost: 3 }]);
      }
      // The merge path closes the item: no decision names it from that commit on, before any claim runs.
      const it = (await store.getWorkItem(pr))!;
      await store.transition({
        id: pr, expected_version: it.version, actor: system, reason: "pr_merged",
        patch: { stage: "CLOSED", close_reason: "completed", merge_sha: "abc" },
      });
      expect(await store.listClaimDecisions(a)).toEqual([]);
      expect(await store.listClaimDecisions(b)).toEqual([]);
      // Now they hold only each other: the oldest goes first, the other waits for it.
      expect((await claim(store))?.work_item_id).toBe(a);
      expect(await claim(store, w2)).toBeNull();
      expect(await store.listClaimDecisions(b)).toMatchObject([{ decision: "held", holder_work_item_id: a, holder_kind: "running" }]);
    });

    it("a newer run that overlaps an older held run (an open PR holds it) waits behind it instead of going first", async () => {
      const { store, clock } = await make();
      const pr = await item(store, clock, 1, { stage: "REVIEW", change_ref: "92", pr_files: ["SET_UP.md"] }, []);
      const older = await item(store, clock, 2, { files_to_change: ["SET_UP.md", WORKER] });
      const younger = await item(store, clock, 3, { files_to_change: [WORKER] });
      expect(await claim(store)).toBeNull();
      expect((await store.listClaimDecisions(older))[0]).toMatchObject({ decision: "held", holder_kind: "pr" });
      expect((await store.listClaimDecisions(younger))[0]).toMatchObject({ decision: "held", holder_work_item_id: older, holder_kind: "waiting" });
      // The PR merges: the older run starts first, the younger one waits for it.
      const it = (await store.getWorkItem(pr))!;
      await store.transition({ id: pr, expected_version: it.version, actor: system, reason: "pr_merged", patch: { stage: "CLOSED", close_reason: "completed", merge_sha: "abc" } });
      expect((await claim(store))?.work_item_id).toBe(older);
      expect(await claim(store, w2)).toBeNull();
      expect((await store.listClaimDecisions(younger))[0]).toMatchObject({ decision: "held", holder_work_item_id: older, holder_kind: "running" });
    });

    it("closing an item keeps an approval of a run it held", async () => {
      const { store, clock } = await make();
      const a = await item(store, clock, 1, { files_to_change: [WORKER] });
      const b = await item(store, clock, 2, { files_to_change: [WORKER] });
      const first = (await claim(store))!;
      expect(await claim(store, w2)).toBeNull();
      const run = await runOf(store, b);
      const before = (await store.getWorkItem(b))!;
      expect(await store.approveClaimHold({ id: b, expected_version: before.version, actor: human as never, run_id: run.id })).toMatchObject({ ok: true });
      await store.completeRun(first.id, first.lease!.token, ok);
      const it = (await store.getWorkItem(a))!;
      await store.transition({ id: a, expected_version: it.version, actor: system, reason: "x", patch: { stage: "CLOSED", close_reason: "completed" } });
      expect(await store.listClaimDecisions(b)).toMatchObject([{ holder_work_item_id: a, approved_by: human.id }]);
    });

    it("triage and review runs are never held by the coordination rule", async () => {
      const { store, clock } = await make();
      const a = await item(store, clock, 1, { files_to_change: [WORKER] });
      expect((await claim(store))?.work_item_id).toBe(a);
      // Same hotspot, but triage and review runs: both claimed while a's implement run holds the file.
      const b = await item(store, clock, 2, { stage: "REVIEW", change_ref: "92", files_to_change: [WORKER], pr_files: [WORKER] }, ["review"]);
      const c = await item(store, clock, 3, { stage: "NEW", files_to_change: [WORKER] }, ["triage"]);
      const kinds = [(await claim(store, w2))!, (await claim(store, w2))!].map((r) => [r.work_item_id, r.kind]);
      expect(kinds).toEqual([[b, "review"], [c, "triage"]]);
      expect(await store.listClaimDecisions(b)).toEqual([]);
      expect(await store.listClaimDecisions(c)).toEqual([]);
    });
  });

  describe("/approve on a cost hold", () => {
    it("records the approval with the approver's user ID; the next claim takes the run", async () => {
      const { store, clock } = await make();
      await item(store, clock, 1, { files_to_change: [WORKER] });
      const b = await item(store, clock, 2, { files_to_change: [WORKER] });
      await claim(store);
      expect(await claim(store, w2)).toBeNull();
      const run = await runOf(store, b);
      const current = (await store.getWorkItem(b))!;
      const r = await store.approveClaimHold({ id: b, expected_version: current.version, actor: human as never, run_id: run.id });
      expect(r).toMatchObject({ ok: true, decision: { approved_by: "github:1" } });
      const change = (await store.listStateChanges(b)).at(-1)!;
      expect(change).toMatchObject({
        reason: "coordination_approved", actor: human, changes: {}, detail: { run_id: run.id, holder: "#1", cost: 3, threshold: 2.5 },
      });
      expect(await claim(store, w2)).toMatchObject({ id: run.id, status: "running" });
      expect((await store.listClaimDecisions(b))[0]).toMatchObject({ decision: "approved", approved_by: "github:1" });
    });

    it("a run that is not held is refused and nothing changes", async () => {
      const { store, clock } = await make();
      const a = await item(store, clock, 1, { files_to_change: ["lib/a.ts"] });
      const it0 = (await store.getWorkItem(a))!;
      const r = await store.approveClaimHold({ id: a, expected_version: it0.version, actor: human as never, run_id: (await runOf(store, a)).id });
      expect(r).toEqual({ ok: false, reason: "not_held" });
      expect((await store.getWorkItem(a))!.version).toBe(it0.version);
    });
  });

  describe("hold_policy (issue #314)", () => {
    const MIN = 60_000;
    const policy = (p: Partial<CoordinationSettings>) => ({ ...DEFAULT_COORDINATION, ...p });
    const claimWith = (store: FactoryStore, coordination: CoordinationSettings, worker_id = w2) =>
      store.claimRun({ worker_id, kinds: ALL, lease_ms: LEASE, coordination });
    /** Item 1 running, item 2 queued and sharing `file` with it. */
    async function heldPair(file = "lib/a.ts") {
      const { store, clock } = await make();
      const a = await item(store, clock, 1, { files_to_change: [file, "lib/b.ts", "lib/c.ts"] });
      const b = await item(store, clock, 2, { files_to_change: [file, "lib/b.ts", "lib/c.ts"] });
      expect((await claim(store, w1))?.work_item_id).toBe(a);
      return { store, clock, a, b };
    }

    it("run_after_minutes 20: not claimed at 19 minutes, claimed at 20; the decision is timed_out with holder and cost", async () => {
      const { store, clock, a, b } = await heldPair();
      const s = policy({ hold_policy: { mode: "run_after_minutes", minutes: 20 } });
      expect(await claimWith(store, s)).toBeNull();
      const [held] = await store.listClaimDecisions(b);
      expect(held).toMatchObject({ decision: "held", holder_work_item_id: a, cost: 3 });
      clock.advance(19 * MIN);
      expect(await claimWith(store, s)).toBeNull();
      clock.advance(MIN);
      expect(await claimWith(store, s)).toMatchObject({ work_item_id: b, kind: "implement" });
      expect(await store.listClaimDecisions(b)).toMatchObject([
        { decision: "timed_out", holder_work_item_id: a, holder_ref: "#1", holder_kind: "running", cost: 3, threshold: 2.5, held_since: held!.held_since },
      ]);
    });

    it("run: a held run is claimed at once; the decision is overlap_allowed with holder and cost", async () => {
      const { store, a, b } = await heldPair();
      expect(await claimWith(store, policy({ hold_policy: { mode: "run" } }))).toMatchObject({ work_item_id: b });
      expect(await store.listClaimDecisions(b)).toMatchObject([
        { decision: "overlap_allowed", holder_work_item_id: a, holder_kind: "running", cost: 3, threshold: 2.5 },
      ]);
    });

    it("hold: the run stays held however long, and /approve still lifts it", async () => {
      const { store, clock, b } = await heldPair();
      const hold = policy({ hold_policy: { mode: "hold" } });
      expect(await claimWith(store, hold)).toBeNull();
      clock.advance(24 * 60 * MIN);
      expect(await claimWith(store, hold)).toBeNull();
      expect(await store.listClaimDecisions(b)).toMatchObject([{ decision: "held" }]);
      const run = await runOf(store, b);
      const it0 = (await store.getWorkItem(b))!;
      expect(await store.approveClaimHold({ id: b, expected_version: it0.version, actor: human as never, run_id: run.id })).toMatchObject({ ok: true });
      expect(await claimWith(store, hold)).toMatchObject({ id: run.id });
    });

    it("the default is run_after_minutes 120: a run held two hours is claimed and its decision is timed_out", async () => {
      expect(DEFAULT_COORDINATION.hold_policy).toEqual({ mode: "run_after_minutes", minutes: 120 });
      const { store, clock, b } = await heldPair();
      expect(await claim(store, w2)).toBeNull();
      clock.advance(119 * MIN);
      expect(await claim(store, w2)).toBeNull();
      clock.advance(MIN);
      expect(await claim(store, w2)).toMatchObject({ work_item_id: b, kind: "implement" });
      expect(await store.listClaimDecisions(b)).toMatchObject([{ decision: "timed_out", holder_kind: "running" }]);
    });

    it("a hold keeps its start when its holder changes, so the run_after_minutes timer does not restart", async () => {
      const { store, clock } = await make();
      const s = policy({ hold_policy: { mode: "run_after_minutes", minutes: 20 } });
      await item(store, clock, 1, { stage: "REVIEW", change_ref: "91", pr_files: [WORKER] }, []);
      const b = await item(store, clock, 2, { files_to_change: [WORKER] });
      expect(await claimWith(store, s)).toBeNull();
      const [first] = await store.listClaimDecisions(b);
      expect(first).toMatchObject({ decision: "held", holder_ref: "#91" });
      clock.advance(10 * MIN);
      // A second PR that shares more files takes over as the named holder.
      await item(store, clock, 3, { stage: "REVIEW", change_ref: "93", pr_files: [WORKER, "SET_UP.md"] }, []);
      const it2 = (await store.getWorkItem(b))!;
      await store.transition({ id: b, expected_version: it2.version, actor: system, reason: "x", patch: { files_to_change: [WORKER, "SET_UP.md"] } });
      expect(await claimWith(store, s)).toBeNull();
      const [second] = await store.listClaimDecisions(b);
      expect(second).toMatchObject({ decision: "held", holder_ref: "#93", held_since: first!.held_since });
      expect(second!.at).not.toBe(first!.at);
      clock.advance(10 * MIN);
      expect(await claimWith(store, s)).toMatchObject({ work_item_id: b });
      expect((await store.listClaimDecisions(b))[0]).toMatchObject({ decision: "timed_out", holder_ref: "#93", held_since: first!.held_since });
    });

    it("dependency holds never time out nor become overlap_allowed", async () => {
      // Held by a dependency and by cost against a running item at once.
      const { store, clock, b: a } = await heldPair();
      await store.replaceDependencyEdges(a, [{ depends_on: "o/r#92", kind: "depends_on" }]);
      for (const hold_policy of [{ mode: "run" }, { mode: "run_after_minutes", minutes: 1 }] as const) {
        clock.advance(60 * MIN);
        expect(await claimWith(store, policy({ hold_policy }))).toBeNull();
      }
      expect(await store.listClaimDecisions(a)).toEqual([]);
    });

    it("hotspot_mode hold: a hotspot cost stays held under run and run_after_minutes; with the default it follows hold_policy", async () => {
      for (const hold_policy of [{ mode: "run" }, { mode: "run_after_minutes", minutes: 1 }] as const) {
        const { store, clock, b } = await heldPair(WORKER);
        expect(await claimWith(store, policy({ hold_policy, hotspot_mode: "hold" }))).toBeNull();
        clock.advance(60 * MIN);
        expect(await claimWith(store, policy({ hold_policy, hotspot_mode: "hold" }))).toBeNull();
        expect(await store.listClaimDecisions(b)).toMatchObject([{ decision: "held" }]);
        expect(await claimWith(store, policy({ hold_policy }))).toMatchObject({ work_item_id: b });
      }
      // hotspot_mode hold leaves a cost of ordinary files to the policy.
      const { store, b } = await heldPair();
      expect(await claimWith(store, policy({ hold_policy: { mode: "run" }, hotspot_mode: "hold" }))).toMatchObject({ work_item_id: b });
    });

  });

  describe("oldest held first (design 05-dependencies, 2026-11-23)", () => {
    const finish = async (store: FactoryStore, id: WorkItemId) => {
      const r = await runOf(store, id);
      await store.completeRun(r.id, r.lease!.token, ok);
    };
    const merge = async (store: FactoryStore, id: WorkItemId) => {
      const it = (await store.getWorkItem(id))!;
      await store.transition({ id, expected_version: it.version, actor: system, reason: "pr_merged", patch: { stage: "CLOSED", close_reason: "completed", merge_sha: "abc" } });
    };
    /** Holds `id`'s queued implement run, approves it, and claims: the approved run starts. */
    const approved = async (store: FactoryStore, id: WorkItemId) => {
      expect(await claim(store, w2)).toBeNull();
      const it = (await store.getWorkItem(id))!;
      expect(await store.approveClaimHold({ id, expected_version: it.version, actor: human as never, run_id: (await runOf(store, id)).id })).toMatchObject({ ok: true });
      return claim(store, w2);
    };
    /** B running; A shares WORKER with it (held), and SET_UP.md with what comes later. */
    async function heldBehindB() {
      const { store, clock } = await make();
      const b = await item(store, clock, 1, { files_to_change: [WORKER] });
      expect((await claim(store))?.work_item_id).toBe(b);
      const a = await item(store, clock, 2, { files_to_change: [WORKER, "SET_UP.md"] });
      expect(await claim(store)).toBeNull();
      expect(await store.listClaimDecisions(a)).toMatchObject([{ decision: "held", holder_work_item_id: b, holder_kind: "running" }]);
      clock.advance(10 * 60_000);
      return { store, clock, a, b };
    }

    it("A is held behind B; C, queued after A's hold began, overlaps A: when B merges A is claimed and C stays held behind A", async () => {
      const { store, clock, a, b } = await heldBehindB();
      const c = await item(store, clock, 3, { files_to_change: ["SET_UP.md"] });
      // C overlaps only A, a queued run that is itself held: C waits behind it instead of going first.
      expect(await claim(store)).toBeNull();
      expect(await store.listClaimDecisions(c)).toMatchObject([{ decision: "held", holder_work_item_id: a, holder_kind: "waiting" }]);
      await finish(store, b);
      await merge(store, b);
      clock.advance(60_000);
      expect((await claim(store))?.work_item_id).toBe(a);
      expect(await claim(store, w2)).toBeNull();
      expect(await store.listClaimDecisions(c)).toMatchObject([{ decision: "held", holder_work_item_id: a, holder_kind: "running" }]);
    });

    it("a running item whose implement run started after the hold began does not hold it", async () => {
      const { store, clock, a, b } = await heldBehindB();
      // D overlaps A and starts after A's hold began (waiting behind A, then /approve).
      const d = await item(store, clock, 3, { files_to_change: ["SET_UP.md", "lib/d.ts"] });
      expect(await approved(store, d)).toMatchObject({ work_item_id: d });
      clock.advance(60_000);
      await finish(store, b); // B's run ends: only D, started after A's hold, still overlaps A
      expect(await claim(store)).toMatchObject({ work_item_id: a });
    });

    it("an open PR whose item's implement run started after the hold began does not hold it; a PR with no recorded run does", async () => {
      const { store, clock, a, b } = await heldBehindB();
      const d = await item(store, clock, 3, { files_to_change: ["SET_UP.md"] });
      expect(await approved(store, d)).toMatchObject({ work_item_id: d });
      await finish(store, d);
      const dv = (await store.getWorkItem(d))!;
      await store.transition({ id: d, expected_version: dv.version, actor: system, reason: "x", patch: { stage: "REVIEW", change_ref: "93", pr_files: ["SET_UP.md"] } });
      // A PR the store has no implement run for counts as started before any hold.
      const old = await item(store, clock, 4, { stage: "REVIEW", change_ref: "94", pr_files: [WORKER] }, []);
      await finish(store, b);
      expect(await claim(store)).toBeNull();
      expect(await store.listClaimDecisions(a)).toMatchObject([{ decision: "held", holder_work_item_id: old, holder_kind: "pr" }]);
      // That PR's files change so it no longer overlaps: only D's PR, started after A's hold began, is left.
      const ov = (await store.getWorkItem(old))!;
      await store.transition({ id: old, expected_version: ov.version, actor: system, reason: "x", patch: { pr_files: ["lib/other.ts"] } });
      expect(await claim(store)).toMatchObject({ work_item_id: a });
    });

    it("when the named blocker merges, an item that started after the hold began still does not hold it", async () => {
      const { store, clock, a, b } = await heldBehindB();
      const d = await item(store, clock, 3, { files_to_change: ["SET_UP.md"] });
      expect(await approved(store, d)).toMatchObject({ work_item_id: d });
      await finish(store, b);
      await merge(store, b);
      expect(await store.listClaimDecisions(a)).toEqual([]); // no reader sees a decision naming the merged item
      expect(await claim(store)).toMatchObject({ work_item_id: a });
    });

    it("when the named blocker merges, a re-hold keeps the hold's start, so the limit counts from the first hold", async () => {
      const { store, clock, a, b } = await heldBehindB();
      const start = (await store.listClaimDecisions(a))[0]!.held_since;
      const old = await item(store, clock, 3, { stage: "REVIEW", change_ref: "94", pr_files: [WORKER] }, []);
      await finish(store, b);
      await merge(store, b);
      clock.advance(60_000);
      expect(await claim(store, w2)).toBeNull(); // the default hold_policy: run_after_minutes, 120
      expect(await store.listClaimDecisions(a)).toMatchObject([{ decision: "held", holder_work_item_id: old, held_since: start }]);
      clock.advance(110 * 60_000);
      expect(await claim(store, w2)).toMatchObject({ work_item_id: a });
      expect(await store.listClaimDecisions(a)).toMatchObject([{ decision: "timed_out", held_since: start }]);
    });
  });

  describe("dependencies", () => {
    it("an unmerged dependency edge holds the implement run; merged, it is claimable on the next claim", async () => {
      const { store, clock } = await make();
      const a = await item(store, clock, 1, { files_to_change: ["lib/a.ts"] });
      await store.replaceDependencyEdges(a, [{ depends_on: "o/r#92", kind: "depends_on" }]);
      expect(await claim(store)).toBeNull();
      expect(await store.setDependencyState(a, "o/r#92", "merged")).toBe(true);
      expect(await claim(store)).toMatchObject({ work_item_id: a });
    });

    it("a dependency that is a work item counts as merged once it closed completed with a merge sha", async () => {
      const { store, clock } = await make();
      const dep = await item(store, clock, 92, { stage: "REVIEW", change_ref: "192" }, []);
      const a = await item(store, clock, 1, { files_to_change: ["lib/a.ts"] });
      await store.replaceDependencyEdges(a, [{ depends_on: "o/r#92", kind: "sub_issue" }]);
      expect(await claim(store)).toBeNull();
      const d = (await store.getWorkItem(dep))!;
      await store.transition({
        id: dep, expected_version: d.version, actor: system, reason: "pr_merged",
        patch: { stage: "CLOSED", close_reason: "completed", merge_sha: "abc" },
      });
      expect(await claim(store)).toMatchObject({ work_item_id: a });
    });

    it("blocked_on: dependency holds the run even with no edge; review runs of other items are not held", async () => {
      const { store, clock } = await make();
      await item(store, clock, 1, { blocked_on: "dependency", blocked_reason: "waiting for #92 to merge" });
      expect(await claim(store)).toBeNull();
    });

    it("replaceDependencyEdges is idempotent, keeps the state of kept edges and drops the others", async () => {
      const { store, clock } = await make();
      const a = await item(store, clock, 1, {});
      await store.replaceDependencyEdges(a, [{ depends_on: "o/r#2", kind: "depends_on" }, { depends_on: "o/r#3", kind: "blocked_by" }]);
      await store.setDependencyState(a, "o/r#2", "merged");
      const edges = await store.replaceDependencyEdges(a, [
        { depends_on: "o/r#2", kind: "depends_on" },
        { depends_on: "o/r#4", kind: "sub_issue" },
        { depends_on: "o/r#4", kind: "blocked_by" },
      ]);
      expect(edges.map((e) => [e.depends_on, e.kind, e.state])).toEqual([
        ["o/r#2", "depends_on", "merged"],
        ["o/r#4", "sub_issue", "open"],
      ]);
      expect((await store.listDependencyEdges({ depends_on: "o/r#4" })).map((e) => e.work_item_id)).toEqual([a]);
      expect(await store.setDependencyState(a, "o/r#9", "merged")).toBe(false);
    });
  });
});
