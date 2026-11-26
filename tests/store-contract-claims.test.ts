import { describe, expect, it } from "vitest";
import type { RunKind, Timestamp, UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { projectLabelCursor } from "../src/core/project.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { newStore, human, issue, system, w1, w2, PROJECT_KEY, OTHER_PROJECT_KEY } from "./helpers/store.js";

const LEASE = 60_000;
/** A project label as the cursor `project_label:<key>` stores it, and the PR link the store writes as change_url. */
const LABEL = "github.com/o/r";
const prUrl = (label: string, n: number) => `https://${label}/pull/${n}`;

describe.each([{ name: "sqlite", make: newStore }])("FactoryStore contract: $name", ({ name, make: makeBackend }) => {
  const make = makeBackend;
  describe("run input", () => {
    it("stores a run's input (e.g. /resolve notes) with the run; runs enqueued without one have input null", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const notes = "keep main's API\n`x` and ünïcode, 'quotes'";
      const r = await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x",
        enqueue: { kind: "resolve", idempotency_key: "r", input: { notes } },
      });
      expect(r.ok && r.enqueued?.input).toEqual({ notes });
      const runs = await store.listRuns(item.id);
      expect(runs.map((x) => [x.kind, x.input])).toEqual([["triage", null], ["resolve", { notes }]]);
      const claimed = (await store.claimRun({ worker_id: w1, kinds: ["resolve"], lease_ms: LEASE }))!;
      expect(claimed.input).toEqual({ notes });
      expect((await store.getRun(claimed.id))!.input).toEqual({ notes });
    });
  });

  describe("adopted PRs, PR heads and unreviewed merges (migration 12)", () => {
    const adopted = (n: number) => ({
      ...issue(n),
      source: { type: "github_issue" as const, id: `o/r#${n}`, link: `https://github.com/o/r/pull/${n}` },
      title: `PR ${n}`,
      adopted: { change_ref: String(n), head_branch: "feature/x", head_sha: "h1", allowed_paths: ["src/a.ts", "b/c.md"], tier: 4 as const },
    });

    it("items from intake are origin factory with no head branch or head sha", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      expect(item).toMatchObject({ origin: "factory", head_branch: null, last_head_sha: null });
      expect((await store.getWorkItem(item.id))!).toMatchObject({ origin: "factory", head_branch: null, last_head_sha: null });
    });

    it("an adoption creates the item at REVIEW with its PR, branch, head, paths and tier, idempotent on the source", async () => {
      const { store } = await make();
      const enqueue = { kind: "review" as const, idempotency_key: "o/r#5:adopt:review" };
      const a = await store.createWorkItem(adopted(5), human, { enqueue });
      const b = await store.createWorkItem(adopted(5), human, { enqueue });
      expect([a.created, b.created]).toEqual([true, false]);
      const it = (await store.getWorkItem(a.item.id))!;
      expect(it).toEqual(a.item);
      expect(it).toMatchObject({
        origin: "adopted", stage: "REVIEW", blocked_on: "none", change_ref: "5", head_branch: "feature/x", last_head_sha: "h1",
        allowed_paths: ["src/a.ts", "b/c.md"], tier: 4, done_criteria: null, version: 1,
      });
      expect((await store.listRuns(it.id)).map((r) => r.kind)).toEqual(["review"]);
      const [sc] = await store.listStateChanges(it.id);
      expect(sc).toMatchObject({ reason: "pr_adopted", actor: human, version: 1 });
      expect(sc!.changes).toMatchObject({ stage: { from: null, to: "REVIEW" }, change_ref: { from: null, to: "5" } });
      expect((await store.getWorkItemByPr(PROJECT_KEY, "5"))!.id).toBe(it.id);
    });

    it("transitions keep origin, head_branch and last_head_sha", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(adopted(5), human);
      const r = await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "x", patch: { blocked_on: "human" } });
      expect(r.ok && r.item).toMatchObject({ origin: "adopted", head_branch: "feature/x", last_head_sha: "h1" });
    });

    it("recordPushedHead is fenced by the run's lease and bumps no version", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "i" } });
      const run = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))!;
      expect(await store.recordPushedHead(run.id, run.lease!.token + 1, "x")).toEqual({ ok: false, reason: "lease_lost" });
      expect(await store.recordPushedHead(run.id, run.lease!.token, "p1")).toEqual({ ok: true });
      expect((await store.getWorkItem(item.id))!).toMatchObject({ last_head_sha: "p1", version: 1 });
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: {} });
      expect(await store.recordPushedHead(run.id, run.lease!.token, "p2")).toEqual({ ok: false, reason: "lease_lost" });
      expect((await store.getWorkItem(item.id))!.last_head_sha).toBe("p1");
    });

    it("recordPrHead: a baseline writes no run; a person's push writes one acknowledged manual run, once", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const base = await store.recordPrHead({ id: item.id, expected_head: null, head_sha: "a", manual: { actor: human, change_ref: "9" } });
      expect(base).toMatchObject({ ok: true, run: null, item: { last_head_sha: "a", version: 1 } });

      const push = { id: item.id, expected_head: "a", head_sha: "b", manual: { actor: human, change_ref: "9" } };
      const r = await store.recordPrHead(push);
      if (!r.ok || !r.run) throw new Error("expected a manual run");
      expect(r.item).toMatchObject({ last_head_sha: "b", version: 1, stage: "NEW", blocked_on: "none" });
      expect(r.run).toMatchObject({
        kind: "manual", status: "succeeded", attempt: 0, lease: null, work_item_id: item.id,
        outcome: { status: "succeeded", data: { actor: human, from_sha: "a", to_sha: "b", pr_number: 9 } },
      });
      expect(r.run.acknowledged_at).not.toBeNull();
      expect(r.run.finished_at).not.toBeNull();
      expect(await store.recordPrHead(push)).toMatchObject({ ok: false, reason: "head_moved", current: { last_head_sha: "b" } });
      expect((await store.listRuns(item.id)).filter((x) => x.kind === "manual")).toHaveLength(1);
      expect(await store.listUnacknowledgedRuns(10)).toEqual([]);
      expect(await store.claimRun({ worker_id: w1, kinds: ["manual"], lease_ms: LEASE })).toBeNull();
      expect(await store.listStateChanges(item.id)).toHaveLength(1);
      expect(await store.recordPrHead({ ...push, id: "wi_missing" as WorkItemId })).toEqual({ ok: false, reason: "not_found" });
    });

    it("recordUnreviewedMerge is idempotent on (project, change_ref); listUnreviewedMerges is newest first", async () => {
      const { store, clock } = await make();
      const a = await store.recordUnreviewedMerge({ project: PROJECT_KEY, change_ref: "7", merge_sha: "m7", merger_id: "github:1" as UserId });
      clock.advance(1000);
      const again = await store.recordUnreviewedMerge({ project: PROJECT_KEY, change_ref: "7", merge_sha: "other", merger_id: null });
      const b = await store.recordUnreviewedMerge({ project: PROJECT_KEY, change_ref: "8", merge_sha: "m8", merger_id: null });
      const c = await store.recordUnreviewedMerge({ project: OTHER_PROJECT_KEY, change_ref: "7", merge_sha: "m7b", merger_id: null });
      expect([a.created, again.created, b.created, c.created]).toEqual([true, false, true, true]);
      expect(again.merge).toEqual(a.merge);
      expect(a.merge).toMatchObject({ project: PROJECT_KEY, change_ref: "7", merge_sha: "m7", merger_id: "github:1" });
      const rows = await store.listUnreviewedMerges(10);
      expect(rows.map((r) => [r.project, r.change_ref])).toEqual([[OTHER_PROJECT_KEY, "7"], [PROJECT_KEY, "8"], [PROJECT_KEY, "7"]]);
      expect(await store.listUnreviewedMerges(1)).toHaveLength(1);
    });

    it("countUnreviewedMergesSince counts rows recorded inside the window and not outside it", async () => {
      const { store, clock } = await make();
      await store.recordUnreviewedMerge({ project: PROJECT_KEY, change_ref: "1", merge_sha: "a", merger_id: null });
      clock.advance(10 * 24 * 3600_000);
      await store.recordUnreviewedMerge({ project: PROJECT_KEY, change_ref: "2", merge_sha: "b", merger_id: null });
      await store.recordUnreviewedMerge({ project: OTHER_PROJECT_KEY, change_ref: "2", merge_sha: "c", merger_id: null });
      const since = new Date(clock.now().getTime() - 7 * 24 * 3600_000).toISOString() as Timestamp;
      expect(await store.countUnreviewedMergesSince(since)).toBe(2);
      expect(await store.countUnreviewedMergesSince(new Date(clock.now().getTime() + 1000).toISOString() as Timestamp)).toBe(0);
      expect(await store.countUnreviewedMergesSince("1970-01-01T00:00:00.000Z" as Timestamp)).toBe(3);
    });
  });

  describe("change fields (migration 35; pr_number removed by 20261112T1200-controller-change-ref-only)", () => {
    const raw = async (store: FactoryStore, table: string, id: string) =>
      (await store.listTableRows({ table, filter: { column: "id", value: id } }))!.rows[0]!;
    const adoptedIn = (n: number, project: string) => ({
      ...issue(n),
      project,
      source: { type: "github_issue" as const, id: `o/r#${n}`, link: `https://github.com/o/r/pull/${n}` },
      adopted: { change_ref: String(n), head_branch: "feature/x", head_sha: "h1", allowed_paths: ["src/a.ts"], tier: 4 as const },
    });

    it("the adopted insert writes change_ref, and change_url from the stored label; intake writes neither", async () => {
      const { store } = await make();
      await store.advanceCursor(projectLabelCursor(PROJECT_KEY), null, LABEL);
      const labelled = (await store.createWorkItem(adoptedIn(5, PROJECT_KEY), human)).item;
      const unlabelled = (await store.createWorkItem(adoptedIn(6, OTHER_PROJECT_KEY), human)).item;
      const plain = (await store.createWorkItem(issue(7), system)).item;
      expect(await raw(store, "controller_work_items", labelled.id)).toMatchObject({ change_ref: "5", change_url: prUrl(LABEL, 5) });
      expect(await raw(store, "controller_work_items", labelled.id)).not.toHaveProperty("pr_number");
      expect(await raw(store, "controller_work_items", unlabelled.id)).toMatchObject({ change_ref: "6", change_url: null });
      expect(await raw(store, "controller_work_items", plain.id)).toMatchObject({ change_ref: null, change_url: null });
      expect((await store.getWorkItemByPr(PROJECT_KEY, "5"))!.id).toBe(labelled.id);
      expect((await store.getWorkItemByPr(OTHER_PROJECT_KEY, "6"))!.id).toBe(unlabelled.id);
    });

    it("a patch that sets change_ref derives change_url from the label when no URL is given", async () => {
      const { store } = await make();
      const a = (await store.createWorkItem(issue(1), system)).item;
      const b = (await store.createWorkItem({ ...issue(2), project: OTHER_PROJECT_KEY }, system)).item;
      await store.advanceCursor(projectLabelCursor(PROJECT_KEY), null, LABEL);
      await store.transition({ id: a.id, expected_version: 1, patch: { change_ref: "34" }, actor: system, reason: "x" });
      await store.transition({ id: b.id, expected_version: 1, patch: { change_ref: "35" }, actor: system, reason: "x" });
      expect(await raw(store, "controller_work_items", a.id)).toMatchObject({ change_ref: "34", change_url: prUrl(LABEL, 34) });
      expect(await raw(store, "controller_work_items", b.id)).toMatchObject({ change_ref: "35", change_url: null });
      expect(await store.getWorkItem(a.id)).toMatchObject({ change_ref: "34" });
      // A patch without change_ref leaves the change columns alone.
      await store.transition({ id: a.id, expected_version: 2, patch: { blocked_on: "human" }, actor: system, reason: "x" });
      expect(await raw(store, "controller_work_items", a.id)).toMatchObject({ change_ref: "34", change_url: prUrl(LABEL, 34) });
      // change_url is not part of the state change: only the patched field is.
      const [, set] = await store.listStateChanges(a.id);
      expect(set!.changes).toEqual({ change_ref: { from: null, to: "34" } });
      expect((await store.getWorkItemByPr(PROJECT_KEY, "34"))!.id).toBe(a.id);
      expect((await store.getWorkItemByPr(OTHER_PROJECT_KEY, "35"))!.id).toBe(b.id);
    });

    it("a patch's change_url (the forge's open result) is stored over the derived one", async () => {
      const { store } = await make();
      await store.advanceCursor(projectLabelCursor(PROJECT_KEY), null, LABEL);
      const a = (await store.createWorkItem(issue(1), system)).item;
      const opened = "https://github.example/o/r/pull/34";
      await store.transition({ id: a.id, expected_version: 1, patch: { change_ref: "34", change_url: opened }, actor: system, reason: "x" });
      expect(await raw(store, "controller_work_items", a.id)).toMatchObject({ change_ref: "34", change_url: opened });
      expect(await store.getWorkItem(a.id)).toMatchObject({ change_ref: "34", change_url: opened });
    });

    it("a later patch never overwrites a stored change_url", async () => {
      const { store } = await make();
      await store.advanceCursor(projectLabelCursor(PROJECT_KEY), null, LABEL);
      const a = (await store.createWorkItem(issue(1), system)).item;
      const opened = "https://github.example/o/r/pull/34";
      await store.transition({ id: a.id, expected_version: 1, patch: { change_ref: "34", change_url: opened }, actor: system, reason: "x" });
      // Another URL, and a new change_ref with no URL (which would derive one), both keep the stored URL.
      await store.transition({ id: a.id, expected_version: 2, patch: { change_ref: "35", change_url: "https://other/pull/35" }, actor: system, reason: "x" });
      await store.transition({ id: a.id, expected_version: 3, patch: { change_ref: "36" }, actor: system, reason: "x" });
      expect(await raw(store, "controller_work_items", a.id)).toMatchObject({ change_ref: "36", change_url: opened });
    });

    it("every work item read returns change_ref and change_url from the row, and intake returns the stored item", async () => {
      const { store } = await make();
      await store.advanceCursor(projectLabelCursor(PROJECT_KEY), null, LABEL);
      const labelled = await store.createWorkItem(adoptedIn(5, PROJECT_KEY), human);
      const unlabelled = await store.createWorkItem(adoptedIn(6, OTHER_PROJECT_KEY), human);
      const plain = await store.createWorkItem(issue(7), system);
      const factory = (await store.createWorkItem(issue(8), system)).item;
      const patched = await store.transition({ id: factory.id, expected_version: 1, patch: { change_ref: "40" }, actor: system, reason: "x" });
      const want = new Map([
        [labelled.item.id, { change_ref: "5", change_url: prUrl(LABEL, 5) }],
        [unlabelled.item.id, { change_ref: "6", change_url: null }],
        [plain.item.id, { change_ref: null, change_url: null }],
        [factory.id, { change_ref: "40", change_url: prUrl(LABEL, 40) }],
      ]);
      // Intake (created or adopted) returns the same change fields as its stored row; so does a transition.
      for (const r of [labelled, unlabelled, plain]) {
        expect(r.created).toBe(true);
        expect(r.item).toEqual(await store.getWorkItem(r.item.id));
        expect(r.item).toMatchObject(want.get(r.item.id)!);
      }
      expect(patched.ok && patched.item).toMatchObject(want.get(factory.id)!);
      // An intake that finds the item already there returns the stored row too.
      const again = await store.createWorkItem(adoptedIn(5, PROJECT_KEY), human);
      expect(again).toMatchObject({ created: false, item: want.get(labelled.item.id) });
      for (const [id, fields] of want) {
        expect(await store.getWorkItem(id)).toMatchObject(fields);
        const it = (await store.getWorkItem(id))!;
        expect(await store.getWorkItemBySource(it.source.type, it.source.id)).toMatchObject(fields);
      }
      expect(await store.getWorkItemByPr(PROJECT_KEY, "5")).toMatchObject(want.get(labelled.item.id)!);
      const listed = await store.listWorkItems(50);
      for (const [id, fields] of want) expect(listed.find((i) => i.id === id)).toMatchObject(fields);
    });

    it("an unreviewed merge insert writes change_ref, also one that is not a PR number", async () => {
      const { store } = await make();
      const { merge } = await store.recordUnreviewedMerge({ project: PROJECT_KEY, change_ref: "7", merge_sha: "m7", merger_id: null });
      expect(await raw(store, "controller_unreviewed_merges", merge.id)).toMatchObject({ change_ref: "7" });
      expect(await raw(store, "controller_unreviewed_merges", merge.id)).not.toHaveProperty("pr_number");
      const mr = await store.recordUnreviewedMerge({ project: PROJECT_KEY, change_ref: "MR-7", merge_sha: "m8", merger_id: null });
      expect(mr).toMatchObject({ created: true, merge: { change_ref: "MR-7" } });
    });

    it("a patch with a non-numeric change_ref, or none, writes the change columns", async () => {
      const { store } = await make();
      await store.advanceCursor(projectLabelCursor(PROJECT_KEY), null, LABEL);
      const a = (await store.createWorkItem(issue(1), system)).item;
      await store.transition({ id: a.id, expected_version: 1, patch: { change_ref: "MR-7" }, actor: system, reason: "x" });
      expect(await raw(store, "controller_work_items", a.id)).toMatchObject({ change_ref: "MR-7", change_url: null });
      await store.transition({ id: a.id, expected_version: 2, patch: { change_ref: "34" }, actor: system, reason: "x" });
      await store.transition({ id: a.id, expected_version: 3, patch: { change_ref: null }, actor: system, reason: "x" });
      expect(await raw(store, "controller_work_items", a.id)).toMatchObject({ change_ref: null, change_url: prUrl(LABEL, 34) });
    });
  });

  describe("budget checkpoints", () => {
    const held = {
      tier: 2 as const,
      tokens_spent: 1_200_000,
      budget: 1_000_000,
      suggested_budget: 2_000_000,
      held_run_kind: "review" as const,
      held_run_key: "k:review:l0:r0",
      held_run_not_before: null,
    };
    const block = { blocked_on: "budget" as const, blocked_reason: "budget_checkpoint" };

    async function opened(store: FactoryStore) {
      const { item } = await store.createWorkItem(issue(1), system);
      const r = await store.openBudgetCheckpoint({
        id: item.id, expected_version: 1, patch: block, actor: system, reason: "budget_checkpoint", checkpoint: held,
      });
      if (!r.ok) throw new Error(r.reason);
      return r;
    }

    it("opens a pending checkpoint in the same transaction as the block and its state change", async () => {
      const { store, clock } = await make();
      const r = await opened(store);
      expect(r.item).toMatchObject({ version: 2, blocked_on: "budget", blocked_reason: "budget_checkpoint" });
      expect(r.state_change.reason).toBe("budget_checkpoint");
      expect(r.enqueued).toBeNull();
      expect(r.checkpoint).toMatchObject({
        ...held, work_item_id: r.item.id, answer: "pending", granted_budget: null, outcome: null,
        created_at: clock.now().toISOString(), answered_at: null,
      });
      expect(await store.listBudgetCheckpoints(r.item.id)).toEqual([r.checkpoint]);
      expect(await store.listRuns(r.item.id)).toEqual([]);
    });

    it("opens nothing on a version conflict, or while another checkpoint of the item is pending", async () => {
      const { store } = await make();
      const { item: other } = await store.createWorkItem(issue(2), system);
      const stale = { id: other.id, expected_version: 0, patch: block, actor: system, reason: "budget_checkpoint", checkpoint: held };
      expect(await store.openBudgetCheckpoint(stale)).toMatchObject({ ok: false, reason: "version_conflict" });
      expect(await store.listBudgetCheckpoints(other.id)).toEqual([]);
      expect(await store.listStateChanges(other.id)).toHaveLength(1);

      const r = await opened(store);
      const again = { id: r.item.id, patch: {}, actor: system, reason: "budget_checkpoint", checkpoint: held };
      expect(await store.openBudgetCheckpoint({ ...again, expected_version: 2 })).toEqual({ ok: false, reason: "checkpoint_pending" });
      expect(await store.listBudgetCheckpoints(r.item.id)).toHaveLength(1);
      expect(await store.listStateChanges(r.item.id)).toHaveLength(2);
    });

    it("answers a pending checkpoint once, enqueueing the held run with its key and not_before in the same transaction", async () => {
      const { store, clock } = await make();
      const r = await opened(store);
      clock.advance(5_000);
      const at = new Date(clock.now().getTime() + 1_000).toISOString();
      const answer = {
        id: r.item.id, patch: { blocked_on: "none" as const, blocked_reason: null }, actor: human, reason: "budget_continued",
        checkpoint_id: r.checkpoint.id, answer: "continued_custom" as const, granted_budget: 9_000_000,
        enqueue: { kind: "review" as const, idempotency_key: held.held_run_key, not_before: at as never },
      };
      const a = await store.answerBudgetCheckpoint({ ...answer, expected_version: 2 });
      if (!a.ok) throw new Error(a.reason);
      expect(a.item).toMatchObject({ version: 3, blocked_on: "none" });
      expect(a.state_change).toMatchObject({ reason: "budget_continued", actor: human });
      expect(a.enqueued).toMatchObject({ kind: "review", idempotency_key: held.held_run_key, not_before: at, status: "queued" });
      expect(a.checkpoint).toMatchObject({
        answer: "continued_custom", granted_budget: 9_000_000, answered_at: clock.now().toISOString(), outcome: null,
      });
      // A second answer (a redelivery) changes nothing, whatever the version.
      expect(await store.answerBudgetCheckpoint({ ...answer, expected_version: 3 })).toEqual({ ok: false, reason: "checkpoint_not_pending" });
      expect(await store.listStateChanges(r.item.id)).toHaveLength(3);
      expect(await store.listRuns(r.item.id)).toHaveLength(1);
    });

    it("an answer on a version conflict changes nothing", async () => {
      const { store } = await make();
      const r = await opened(store);
      const a = await store.answerBudgetCheckpoint({
        id: r.item.id, expected_version: 1, patch: {}, actor: human, reason: "budget_continued",
        checkpoint_id: r.checkpoint.id, answer: "continued_suggested", granted_budget: 2_000_000,
        enqueue: { kind: "review", idempotency_key: held.held_run_key },
      });
      expect(a).toMatchObject({ ok: false, reason: "version_conflict" });
      expect((await store.listBudgetCheckpoints(r.item.id))[0]).toMatchObject({ answer: "pending", granted_budget: null });
      expect(await store.listRuns(r.item.id)).toEqual([]);
    });

    it("a rejecting answer that closes the item sets answer rejected and outcome rejected", async () => {
      const { store } = await make();
      const r = await opened(store);
      const a = await store.answerBudgetCheckpoint({
        id: r.item.id, expected_version: 2, actor: human, reason: "budget_rejected",
        patch: { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null },
        checkpoint_id: r.checkpoint.id, answer: "rejected", granted_budget: null,
      });
      if (!a.ok) throw new Error(a.reason);
      expect(a.checkpoint).toMatchObject({ answer: "rejected", granted_budget: null, outcome: "rejected" });
    });

    for (const [close_reason, outcome] of [["completed", "merged"], ["rejected", "rejected"], ["failed", "failed"]] as const) {
      it(`closing the item with ${close_reason} sets the open checkpoint's outcome to ${outcome}, in the same transition`, async () => {
        const { store } = await make();
        const r = await opened(store);
        await store.transition({
          id: r.item.id, expected_version: 2, actor: system, reason: "close",
          patch: { stage: "CLOSED", close_reason, blocked_on: "none", blocked_reason: null },
        });
        expect((await store.listBudgetCheckpoints(r.item.id))[0]).toMatchObject({ answer: "pending", outcome });
      });
    }

    it("lists an item's checkpoints oldest first; an outcome already set is not overwritten", async () => {
      const { store, clock } = await make();
      const r = await opened(store);
      await store.answerBudgetCheckpoint({
        id: r.item.id, expected_version: 2, patch: { blocked_on: "none", blocked_reason: null }, actor: human,
        reason: "budget_continued", checkpoint_id: r.checkpoint.id, answer: "continued_suggested", granted_budget: 2_000_000,
      });
      clock.advance(1_000);
      const second = await store.openBudgetCheckpoint({
        id: r.item.id, expected_version: 3, patch: { blocked_on: "budget", blocked_reason: "budget_checkpoint" }, actor: system,
        reason: "budget_checkpoint", checkpoint: { ...held, tokens_spent: 2_100_000, budget: 2_000_000, held_run_key: "k2" },
      });
      if (!second.ok) throw new Error(second.reason);
      await store.transition({
        id: r.item.id, expected_version: 4, actor: system, reason: "pr_merged",
        patch: { stage: "CLOSED", close_reason: "completed", blocked_on: "none", blocked_reason: null },
      });
      // A later transition of a closed item does not touch the outcome again.
      await store.transition({ id: r.item.id, expected_version: 5, actor: system, reason: "x", patch: { close_reason: "rejected" } });
      const list = await store.listBudgetCheckpoints(r.item.id);
      expect(list.map((c) => [c.held_run_key, c.answer, c.outcome])).toEqual([
        ["k:review:l0:r0", "continued_suggested", "merged"],
        ["k2", "pending", "merged"],
      ]);
      expect(await store.listBudgetCheckpoints("wi_missing" as WorkItemId)).toEqual([]);
    });

    it("tier history: finished (CLOSED) items of the project and tier, and token_cost of the merged ones", async () => {
      const { store } = await make();
      const close = async (n: number, tier: 1 | 2, close_reason: "completed" | "rejected" | null, token_cost: number, project = PROJECT_KEY) => {
        const { item } = await store.createWorkItem({ ...issue(n), project }, system);
        await store.transition({
          id: item.id, expected_version: 1, actor: system, reason: "x",
          patch: close_reason ? { tier, token_cost, stage: "CLOSED", close_reason } : { tier, token_cost, stage: "RUNNING" },
        });
      };
      await close(1, 2, "completed", 300);
      await close(2, 2, "completed", 100);
      await close(3, 2, "rejected", 900);
      await close(4, 2, null, 5_000);
      await close(5, 1, "completed", 7_000);
      await close(6, 2, "completed", 8_000, OTHER_PROJECT_KEY);
      const h = await store.getTierHistory(PROJECT_KEY, 2);
      expect(h.finished).toBe(3);
      expect([...h.merged_token_costs].sort((a, b) => a - b)).toEqual([100, 300]);
      expect(await store.getTierHistory(PROJECT_KEY, 4)).toEqual({ finished: 0, merged_token_costs: [] });
    });
  });

  describe("cancel on close", () => {
    const close = { stage: "CLOSED" as const, close_reason: "wont_do" as const, blocked_on: "none" as const, blocked_reason: null };

    it("a close with cancel_queued_runs cancels the item's queued runs, waiting ones too, in the same transaction", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const later = new Date(clock.now().getTime() + 60_000).toISOString();
      const waiting = await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x",
        enqueue: { kind: "implement", idempotency_key: "i", not_before: later as never },
      });
      if (!waiting.ok) throw new Error(waiting.reason);
      const other = await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "t2" } });

      const r = await store.transition({
        id: item.id, expected_version: 2, patch: close, actor: human, reason: "source_closed", cancel_queued_runs: true,
      });
      if (!r.ok) throw new Error(r.reason);
      expect(r.cancelled).toHaveLength(2);
      const runs = await store.listRuns(item.id);
      expect(runs.map((x) => x.status)).toEqual(["cancelled", "cancelled"]);
      expect(r.cancelled.sort()).toEqual(runs.map((x) => x.id).sort());
      expect(runs.every((x) => x.acknowledged_at === null && x.lease === null)).toBe(true);

      // No worker can claim them, even after the backoff; the other item's run is untouched.
      clock.advance(120_000);
      const claimed = await store.claimRun({ worker_id: w1, kinds: ["triage", "implement"], lease_ms: LEASE });
      expect(claimed!.work_item_id).toBe(other.item.id);
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage", "implement"], lease_ms: LEASE })).toBeNull();

      // Cancelled runs go through the ack path like any finished run.
      const unacked = await store.listUnacknowledgedRuns(10);
      expect(unacked.map((x) => x.id).sort()).toEqual(runs.map((x) => x.id).sort());
      const ack = await store.transition({
        id: item.id, expected_version: 3, patch: {}, actor: system, reason: "run_ignored", ack_run: runs[0]!.id,
      });
      expect(ack.ok).toBe(true);
    });

    it("any close cancels the item's queued runs without the flag, a merge's too; an already closed item's transition cancels nothing", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const queue = async (v: number, key: string) => {
        const r = await store.transition({ id: item.id, expected_version: v, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: key } });
        if (!r.ok) throw new Error(r.reason);
        return r.enqueued!;
      };
      const retry = await queue(1, "i:a1"); // a retry queued while the item was open (a takeover's, before 2026-11-22)
      const merged = await store.transition({
        id: item.id, expected_version: 2, actor: system, reason: "local_merged",
        patch: { stage: "CLOSED", close_reason: "completed", merge_sha: "m".repeat(40), blocked_on: "none", blocked_reason: null },
      });
      if (!merged.ok) throw new Error(merged.reason);
      expect(merged.cancelled).toEqual([retry.id]);
      expect(await store.getRun(retry.id)).toMatchObject({ status: "cancelled", acknowledged_at: null, lease: null });
      clock.advance(120_000);
      expect(await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE })).toBeNull();
      const late = await queue(3, "late"); // a transition on a closed item is no close
      expect((await store.getRun(late.id))!.status).toBe("queued");
    });

    it("leaves a running run alone, and cancels nothing without the flag or when the transition loses", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const running = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "review", idempotency_key: "r" },
      });

      const plain = await store.transition({ id: item.id, expected_version: 2, patch: {}, actor: system, reason: "y" });
      expect(plain.ok && plain.cancelled).toEqual([]);
      const lost = await store.transition({
        id: item.id, expected_version: 2, patch: close, actor: human, reason: "source_closed", cancel_queued_runs: true,
      });
      expect(lost).toMatchObject({ ok: false, reason: "version_conflict" });
      expect((await store.listRuns(item.id)).map((x) => x.status)).toEqual(["running", "queued"]);

      const r = await store.transition({
        id: item.id, expected_version: 3, patch: close, actor: human, reason: "source_closed", cancel_queued_runs: true,
      });
      if (!r.ok) throw new Error(r.reason);
      expect((await store.listRuns(item.id)).map((x) => x.status)).toEqual(["running", "cancelled"]);
      // The running run still finishes normally.
      expect((await store.completeRun(running.id, running.lease!.token, { status: "succeeded", summary: "", data: {} })).ok).toBe(true);
    });

    it("a close with cancel_running_runs stops every running run of the item, of any kind, in the same write", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      const triage = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      await store.transition({
        id: item.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "update", idempotency_key: "u" },
      });
      const update = (await store.claimRun({ worker_id: w2, kinds: ["update"], lease_ms: LEASE }))!;
      await store.transition({
        id: item.id, expected_version: 2, patch: {}, actor: system, reason: "x", enqueue: { kind: "review", idempotency_key: "r" },
      });
      const other = await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "t2" } });
      const otherRun = (await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))!;
      expect(otherRun.work_item_id).toBe(other.item.id);

      // Losing the version check stops nothing.
      const lost = await store.transition({
        id: item.id, expected_version: 2, patch: close, actor: human, reason: "source_closed",
        cancel_queued_runs: true, cancel_running_runs: true,
      });
      expect(lost).toMatchObject({ ok: false, reason: "version_conflict" });
      expect((await store.listRuns(item.id)).map((x) => x.status)).toEqual(["running", "running", "queued"]);

      const r = await store.transition({
        id: item.id, expected_version: 3, patch: close, actor: human, reason: "source_closed",
        cancel_queued_runs: true, cancel_running_runs: true,
      });
      if (!r.ok) throw new Error(r.reason);
      const runs = await store.listRuns(item.id);
      expect(runs.map((x) => x.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
      expect(runs.every((x) => x.lease === null && x.outcome === null && x.acknowledged_at === null)).toBe(true);
      expect([...r.cancelled].sort()).toEqual(runs.map((x) => x.id).sort());

      // The stopped runs lose their lease: the next heartbeat fails, and the outcome is not stored.
      expect(await store.heartbeat(triage.id, triage.lease!.token, LEASE)).toEqual({ ok: false, reason: "lease_lost" });
      expect(await store.completeRun(update.id, update.lease!.token, { status: "succeeded", summary: "", data: {} }))
        .toEqual({ ok: false, reason: "lease_lost" });
      expect((await store.getRun(update.id))).toMatchObject({ status: "cancelled", outcome: null });
      // Another item's running run is untouched.
      expect((await store.getRun(otherRun.id))!.status).toBe("running");
      expect((await store.heartbeat(otherRun.id, otherRun.lease!.token, LEASE)).ok).toBe(true);
    });

    it("the reaper cancels an expired run of a CLOSED item instead of requeueing it", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
      await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE });
      await store.transition({ id: item.id, expected_version: 1, patch: close, actor: human, reason: "source_closed", cancel_queued_runs: true });
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(3)).toHaveLength(1);
      const [run] = await store.listRuns(item.id);
      expect(run).toMatchObject({ status: "cancelled", lease: null });
      expect(await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
    });
  });

  describe("one branch writer per item: overlapping paths below the coordination threshold do not hold runs back", () => {
    const ALL: RunKind[] = ["triage", "implement", "review", "update"];
    const ok = { status: "succeeded" as const, summary: "", data: {} };

    /** Item `n` with these allowed_paths and one queued run per kind given, in order. */
    async function item(store: FactoryStore, n: number, allowed_paths: string[], kinds: RunKind[]) {
      const { item } = await store.createWorkItem(issue(n), system);
      let version = 1;
      await store.transition({ id: item.id, expected_version: version++, patch: { allowed_paths }, actor: system, reason: "x" });
      for (const kind of kinds) {
        await store.transition({
          id: item.id, expected_version: version++, patch: {}, actor: system, reason: "x",
          enqueue: { kind, idempotency_key: `${n}:${kind}` },
        });
      }
      return item.id;
    }
    const claim = (store: FactoryStore, worker_id = w1) => store.claimRun({ worker_id, kinds: ALL, lease_ms: LEASE });

    it("two items with overlapping allowed_paths have implement-type runs running at the same time", async () => {
      const { store } = await make();
      // Two ordinary shared files: cost 2.0, under the default max_coordination_cost of 2.5 (design §5, 2026-11-03).
      const a = await item(store, 1, ["lib/", "docs/notes.md"], ["implement"]);
      const b = await item(store, 2, ["lib/x.ts", "docs/notes.md"], ["update"]);
      const [first, second] = await Promise.all([claim(store, w1), claim(store, w2)]);
      expect(new Set([first?.work_item_id, second?.work_item_id])).toEqual(new Set([a, b]));
      expect(await store.listRunsByStatus(["running"], 10)).toHaveLength(2);
    });

    it("an item never has two implement-type runs running at once, even with no allowed_paths", async () => {
      const { store } = await make();
      const self = await item(store, 3, [], ["update", "implement"]);
      const [first, second] = await Promise.all([claim(store, w1), claim(store, w2)]);
      expect([first, second].filter((r) => r !== null).map((r) => r!.kind)).toEqual(["update"]);
      expect(await claim(store)).toBeNull();
      expect((await store.listRuns(self)).map((r) => r.status)).toEqual(["running", "queued"]);
    });

    it("the held run stays queued and is claimed once its item's run completes", async () => {
      const { store } = await make();
      const a = await item(store, 1, ["src/"], ["update", "implement"]);
      const first = (await claim(store))!;
      expect(await claim(store, w2)).toBeNull();
      await store.completeRun(first.id, first.lease!.token, ok);
      expect(await claim(store, w2)).toMatchObject({ work_item_id: a, kind: "implement", status: "running", attempt: 1 });
    });

    it("a held run does not hold up a later run of another item (FIFO among eligible runs)", async () => {
      const { store } = await make();
      // `lib/` is one ordinary shared path (cost 1.0), so only the same-item rule holds a's implement run.
      const a = await item(store, 1, ["lib/"], ["update", "implement"]);
      const b = await item(store, 2, ["lib/"], ["implement"]);
      await claim(store);
      expect((await claim(store))?.work_item_id).toBe(b);
      expect((await store.listRuns(a)).find((r) => r.kind === "implement")!.status).toBe("queued");
    });

    it("triage and review runs are never held back, and do not hold back an implement", async () => {
      const { store } = await make();
      const a = await item(store, 1, ["src/"], ["implement", "review", "triage"]);
      // Kind rank: review, then triage, then the implement that was queued before both.
      expect([(await claim(store))?.kind, (await claim(store))?.kind]).toEqual(["review", "triage"]);
      expect((await claim(store))?.kind).toBe("implement");

      const other = await make();
      await item(other.store, 2, ["src/"], ["review", "implement"]);
      expect((await claim(other.store))?.kind).toBe("review");
      expect((await claim(other.store))?.kind).toBe("implement");
      expect(a).toBeTruthy();
    });
  });

  describe("claim order: kind rank, then created_at, then insertion order", () => {
    const ALL_KINDS: RunKind[] = ["triage", "implement", "review", "update", "resolve", "merge-check", "screenshot", "judge"];
    const claim = (store: FactoryStore, worker_id = w1) => store.claimRun({ worker_id, kinds: ALL_KINDS, lease_ms: LEASE });
    const enqueue = (store: FactoryStore, n: number, kind: RunKind, not_before?: string) =>
      store.createWorkItem(issue(n), system, { enqueue: { kind, idempotency_key: `${n}:${kind}`, not_before: not_before as never } });

    it("a queued review and a queued triage, created after an older implement, are claimed before it", async () => {
      const { store, clock } = await make();
      await enqueue(store, 1, "implement");
      clock.advance(1_000);
      await enqueue(store, 2, "triage");
      clock.advance(1_000);
      await enqueue(store, 3, "review");
      expect([(await claim(store))?.kind, (await claim(store))?.kind, (await claim(store))?.kind]).toEqual([
        "review", "triage", "implement",
      ]);
    });

    it("a queued merge check, created after an older implement, is claimed first", async () => {
      const { store, clock } = await make();
      await enqueue(store, 1, "implement");
      clock.advance(1_000);
      await enqueue(store, 2, "merge-check");
      expect([(await claim(store))?.kind, (await claim(store))?.kind]).toEqual(["merge-check", "implement"]);
    });

    it("ranks merge-check, resolve, review, screenshot, judge, triage, update, implement, whatever their age", async () => {
      const { store, clock } = await make();
      for (const [n, kind] of (["implement", "update", "triage", "judge", "screenshot", "review", "resolve", "merge-check"] as RunKind[]).entries()) {
        await enqueue(store, n + 1, kind);
        clock.advance(1_000);
      }
      const order: (RunKind | undefined)[] = [];
      for (let i = 0; i < 8; i++) order.push((await claim(store))?.kind);
      expect(order).toEqual(["merge-check", "resolve", "review", "screenshot", "judge", "triage", "update", "implement"]);
    });

    it("a queued judge and a queued screenshot, created after an older implement, are claimed before it (a starved judge holds its split's next phase)", async () => {
      const { store, clock } = await make();
      await enqueue(store, 1, "implement");
      clock.advance(1_000);
      await enqueue(store, 2, "judge");
      clock.advance(1_000);
      await enqueue(store, 3, "screenshot");
      expect([(await claim(store))?.kind, (await claim(store))?.kind, (await claim(store))?.kind]).toEqual(["screenshot", "judge", "implement"]);
    });

    it("within one kind, the oldest queued run is claimed first; equal created_at breaks on insertion order", async () => {
      const { store, clock } = await make();
      await enqueue(store, 1, "implement");
      await enqueue(store, 2, "implement"); // same created_at as #1
      clock.advance(1_000);
      await enqueue(store, 3, "implement");
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await claim(store))!.idempotency_key);
      expect(ids).toEqual(["1:implement", "2:implement", "3:implement"]);
    });

    it("a held implement-type run does not block a later run of any kind behind it", async () => {
      const { store, clock } = await make();
      // Held by its item's running branch writer: item 1 has update running and implement queued.
      const { item: a } = await enqueue(store, 1, "update");
      expect((await claim(store))?.kind).toBe("update");
      await store.transition({
        id: a.id, expected_version: 1, patch: {}, actor: system, reason: "x",
        enqueue: { kind: "implement", idempotency_key: "1:implement" },
      });
      // Held by not_before: an update that may not start yet.
      await enqueue(store, 2, "update", new Date(clock.now().getTime() + 60_000).toISOString());
      clock.advance(1_000);
      for (const [n, kind] of (["implement", "resolve", "triage", "review", "update"] as RunKind[]).entries()) {
        await enqueue(store, n + 10, kind);
      }
      const order: (string | undefined)[] = [];
      for (let i = 0; i < 5; i++) order.push((await claim(store))?.idempotency_key);
      expect(order).toEqual(["11:resolve", "13:review", "12:triage", "14:update", "10:implement"]);
      expect(await claim(store)).toBeNull();
      const held = (await store.listRunsByStatus(["queued"], 10)).map((r) => r.idempotency_key).sort();
      expect(held).toEqual(["1:implement", "2:update"]);
    });

    it("Run next puts the item's queued run first, ahead of the kind rank; a later Run next goes ahead of it; the rest keep their order", async () => {
      const { store, clock } = await make();
      const items = [];
      for (const [n, kind] of (["implement", "triage", "implement", "merge-check", "review"] as RunKind[]).entries()) {
        items.push((await enqueue(store, n + 1, kind)).item);
        clock.advance(1_000);
      }
      const keys = async () => (await store.listQueuedInClaimOrder(10)).map((r) => r.idempotency_key);
      // No Run next yet: the kind rank, as before (no backfill changes it).
      expect(await keys()).toEqual(["4:merge-check", "5:review", "2:triage", "1:implement", "3:implement"]);
      expect((await store.runNext(items[2]!.id)).map((r) => r.idempotency_key)).toEqual(["3:implement"]);
      expect((await store.runNext(items[1]!.id)).map((r) => r.idempotency_key)).toEqual(["2:triage"]);
      // The later Run next is position 1, the earlier one position 2; the other runs keep their order.
      expect(await keys()).toEqual(["2:triage", "3:implement", "4:merge-check", "5:review", "1:implement"]);
      const order: (string | undefined)[] = [];
      for (let i = 0; i < 5; i++) order.push((await claim(store))?.idempotency_key);
      expect(order).toEqual(["2:triage", "3:implement", "4:merge-check", "5:review", "1:implement"]);
    });

    it("Run next on an item with no queued run changes nothing; it never starts a run its item holds back", async () => {
      const { store } = await make();
      // Item 1: an update running and an implement queued behind it, so its implement is held (one branch writer per item).
      const { item: a } = await enqueue(store, 1, "update");
      expect((await claim(store))?.kind).toBe("update");
      expect(await store.runNext(a.id)).toEqual([]);
      await store.transition({ id: a.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: "1:implement" } });
      await enqueue(store, 2, "triage");
      expect((await store.runNext(a.id)).map((r) => r.status)).toEqual(["queued"]);
      expect((await store.listQueuedInClaimOrder(10)).map((r) => r.idempotency_key)).toEqual(["1:implement", "2:triage"]);
      // Position 1, but held: the triage behind it is claimed and the implement stays queued.
      expect((await claim(store))?.idempotency_key).toBe("2:triage");
      expect(await claim(store)).toBeNull();
      expect((await store.listQueuedInClaimOrder(10)).map((r) => r.idempotency_key)).toEqual(["1:implement"]);
    });
  });

  describe("claim cap: every kind waits at `workers`; a merge check takes one slot beyond", () => {
    const ALL_KINDS: RunKind[] = ["triage", "implement", "review", "update", "resolve", "merge-check", "screenshot", "judge"];
    /** Loop ids: p:0 … p:3, so three `workers` and the first loop above them. The cap counts every process's runs. */
    const owners = [0, 1, 2, 3].map((n) => `p:${n}` as WorkerId);
    const claim = (store: FactoryStore, worker_id: WorkerId, workers?: number) =>
      store.claimRun({ worker_id, kinds: ALL_KINDS, lease_ms: LEASE, ...(workers !== undefined ? { workers: { count: workers } } : {}) });
    const enqueue = (store: FactoryStore, n: number, kind: RunKind) =>
      store.createWorkItem(issue(n), system, { enqueue: { kind, idempotency_key: `${n}:${kind}` } });
    /** Fills the first slots: kinds[i] runs on item i + 1, leased by p:i. */
    const fill = async (store: FactoryStore, kinds: RunKind[]) => {
      for (const [i, kind] of kinds.entries()) {
        await enqueue(store, i + 1, kind);
        expect((await claim(store, owners[i]!, kinds.length))?.kind).toBe(kind);
      }
    };

    it("with workers 3 on three implement runs, a merge check is still claimed and a fourth implement is not", async () => {
      const { store } = await make();
      await fill(store, ["implement", "implement", "implement"]);
      await enqueue(store, 4, "implement");
      await enqueue(store, 5, "merge-check");
      expect((await claim(store, owners[3]!, 3))?.idempotency_key).toBe("5:merge-check");
      expect(await claim(store, owners[3]!, 3)).toBeNull();
      expect((await store.listRunsByStatus(["queued"], 10)).map((r) => r.idempotency_key)).toEqual(["4:implement"]);
    });

    it("a queued resolve is not claimed while `workers` implement or resolve runs are running", async () => {
      const { store } = await make();
      await fill(store, ["implement", "resolve"]);
      await enqueue(store, 3, "resolve");
      expect(await claim(store, owners[2]!, 2)).toBeNull();
      expect((await store.listRunsByStatus(["queued"], 10)).map((r) => r.idempotency_key)).toEqual(["3:resolve"]);
    });

    it("with every slot on implement or resolve, only a merge check takes the slot beyond: review, triage, update and implement wait", async () => {
      const { store } = await make();
      await fill(store, ["implement", "resolve"]);
      for (const [n, kind] of (["update", "implement", "review", "triage"] as RunKind[]).entries()) await enqueue(store, n + 3, kind);
      expect(await claim(store, owners[2]!, 2)).toBeNull();
      await enqueue(store, 7, "merge-check");
      expect((await claim(store, owners[2]!, 2))?.kind).toBe("merge-check");
      // Only one slot beyond `workers`: a second merge check waits too.
      await enqueue(store, 8, "merge-check");
      expect(await claim(store, owners[3]!, 2)).toBeNull();
      const queued = (await store.listRunsByStatus(["queued"], 10)).map((r) => r.idempotency_key).sort();
      expect(queued).toEqual(["3:update", "4:implement", "5:review", "6:triage", "8:merge-check"]);
    });

    it("with every slot on a triage run, a merge check is claimed in the slot beyond before any queued triage run", async () => {
      const { store } = await make();
      await fill(store, ["triage", "triage"]);
      await enqueue(store, 3, "triage");
      expect(await claim(store, owners[2]!, 2)).toBeNull();
      await enqueue(store, 4, "merge-check");
      expect((await claim(store, owners[2]!, 2))?.idempotency_key).toBe("4:merge-check");
      expect(await claim(store, owners[3]!, 2)).toBeNull();
      expect((await store.listRunsByStatus(["queued"], 10)).map((r) => r.idempotency_key)).toEqual(["3:triage"]);
    });

    it("a Run next does not lift the cap: a bumped implement still waits at `workers`", async () => {
      const { store } = await make();
      await fill(store, ["triage", "review"]);
      const { item } = await enqueue(store, 3, "implement");
      expect(await store.runNext(item.id)).toHaveLength(1);
      expect(await claim(store, owners[2]!, 2)).toBeNull();
    });

    it("counts every process's running runs: B waits while A holds `workers` implement runs, then claims when they finish", async () => {
      const { store } = await make();
      // Process A (a:0 … a:3) holds 4 running implement runs, as a process draining after a merge does.
      const held = [];
      for (let n = 1; n <= 4; n++) {
        await enqueue(store, n, "implement");
        held.push((await claim(store, `a:${n - 1}` as WorkerId, 4))!);
      }
      await enqueue(store, 5, "implement");
      expect(await claim(store, "b:0" as WorkerId, 4)).toBeNull();
      for (const run of held) await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "", data: {} });
      expect((await claim(store, "b:0" as WorkerId, 4))?.idempotency_key).toBe("5:implement");
    });

    it("while another process holds `workers` implement runs, a merge check takes the one slot beyond and a review waits", async () => {
      const { store } = await make();
      for (let n = 1; n <= 4; n++) {
        await enqueue(store, n, "implement");
        expect((await claim(store, `a:${n - 1}` as WorkerId, 4))?.kind).toBe("implement");
      }
      await enqueue(store, 5, "review");
      expect(await claim(store, "b:0" as WorkerId, 4)).toBeNull();
      await enqueue(store, 6, "merge-check");
      expect((await claim(store, "b:0" as WorkerId, 4))?.kind).toBe("merge-check");
      expect(await claim(store, "b:1" as WorkerId, 4)).toBeNull();
    });

    it("with no worker count, nothing is capped: only the claim order applies", async () => {
      const { store } = await make();
      await fill(store, ["implement", "implement", "implement"]);
      await enqueue(store, 4, "implement");
      expect((await claim(store, owners[3]!))?.idempotency_key).toBe("4:implement");
    });
  });
});
