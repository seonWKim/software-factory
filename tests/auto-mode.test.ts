import { describe, expect, it } from "vitest";
import { IMPROVER } from "../src/core/improver.js";
import { AUTO_ACTOR } from "../src/core/policy.js";
import { utcMinute } from "../src/core/spec-comment.js";
import { footerCommands } from "../src/impl/source/slack-format.js";
import { issue, system } from "./helpers/store.js";
import { AUTO, DEV, FAILS_ON_MERGE, ME, autoFactory, git } from "./helpers/classifier.js";

describe("auto mode: specs", { timeout: 60_000 }, () => {
  it("manual (no mode stored): a spec waits for /approve as before", async () => {
    const f = await autoFactory();
    const id = await f.create();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(await f.modeRows()).toEqual([]);
  });

  it("a spec below tier 4 with no decisions is approved with no /approve, actor system:auto, naming the mode change", async () => {
    const f = await autoFactory();
    expect((await f.mode("auto")).ok).toBe(true);
    const [flip] = await f.modeRows();
    const id = await f.create();
    await f.step();
    const approved = (await f.changes(id)).find((c) => c.reason === "spec_approved")!;
    expect(approved.actor).toEqual(AUTO);
    expect(approved.detail).toMatchObject({ approved_by: AUTO_ACTOR, mode_change: flip!.seq });
  });

  it("Rule of Two: the implement run auto mode approved is not started; the item waits for a person, and the reply says why", async () => {
    const f = await autoFactory();
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "rule_of_two" });
    expect((await f.store.listRuns(id)).map((r) => r.kind)).toEqual(["triage"]);
    const approved = (await f.changes(id)).find((c) => c.reason === "spec_approved")!;
    expect(approved.detail).toMatchObject({ held_by: "rule_of_two", held_run_kind: "implement" });
    const [reply] = await f.messages(id, "<!-- factory:rule-of-two:");
    expect(reply).toContain("a person must approve before it runs");
    expect(reply).toContain("Reply `/approve` to start it");
  });

  it("Rule of Two: a person's /approve starts the held implement run, with the person as actor", async () => {
    const f = await autoFactory();
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    const approved = (await f.changes(id)).find((c) => c.reason === "rule_of_two_approved")!;
    expect(approved.actor).toEqual({ kind: "user", id: ME });
    expect((await f.store.listRuns(id)).map((r) => r.kind)).toEqual(["triage", "implement", "review"]);
    expect((await f.changes(id)).map((c) => c.reason)).toContain("implemented");
  });

  it("a spec with decisions is approved with each proposed default, and the answers are posted in the thread", async () => {
    const decisions = [
      { text: "Fail the job, or only warn?", default: "Fail the job", owner_only: false },
      { text: "Name the step?", default: "scope", owner_only: false },
    ];
    const f = await autoFactory({ spec: { decisions } });
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    const approved = (await f.changes(id)).find((c) => c.reason === "spec_approved")!;
    expect(approved.actor).toEqual(AUTO);
    expect(approved.detail).toMatchObject({ approved_by: AUTO_ACTOR, decisions: 2 });
    const spec = (await f.messages(id, "<!-- factory:spec:")).join("\n");
    expect(spec).toContain("Auto mode (`system:auto`) approves");
    expect(spec).toContain("- Fail the job, or only warn? → Fail the job");
    expect(spec).toContain("- Name the step? → scope");
  });

  it("an auto-approved spec names the approval with its tier and time, and offers no /approve: no answer block, no Approve button (issue #586)", async () => {
    const decisions = [{ text: "Fail the job, or only warn?", default: "Fail the job", owner_only: false }];
    const f = await autoFactory({ spec: { decisions } });
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    const approved = (await f.changes(id)).find((c) => c.reason === "spec_approved")!;
    const tier = (await f.store.getWorkItem(id))!.tier;
    const [spec] = await f.messages(id, "<!-- factory:spec:");
    expect(spec).toContain(`Approved automatically (auto mode, tier ${tier}) at ${utcMinute(approved.at)}.`);
    expect(spec).not.toContain("To answer, reply");
    expect(spec).not.toContain("`/approve");
    // The footer a source builds its buttons from lists no approve.
    expect(footerCommands(spec!)).not.toContain("approve");
  });

  for (const [what, spec] of [
    ["an owner-only decision", { decisions: [{ text: "Drop the table?", default: "Yes", owner_only: true }] }],
    ["a decision with no flag", { decisions: [{ text: "Drop the table?", default: "Yes" }] }],
    ["a plain-text decision", { decisions: ["Drop the table?"] }],
    ["a tier 4 spec", { tier: 4 }],
    ["allowed paths on the gate list", { allowed_paths: ["prompts/"], files_to_change: ["prompts/x.md"] }],
    ["allowed paths that hold a gate path", { allowed_paths: ["src/"], files_to_change: ["src/x.ts"] }],
  ] as const) {
    it(`${what} waits for /approve, and the spec says why`, async () => {
      const f = await autoFactory({ spec });
      await f.mode("auto");
      const id = await f.create();
      await f.step();
      expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
      expect((await f.changes(id)).some((c) => c.reason === "spec_approved")).toBe(false);
      expect((await f.messages(id, "<!-- factory:spec:")).join("\n")).toContain("Auto mode is on, but this spec waits for `/approve`");
    });
  }
});

describe("auto mode: merges", { timeout: 60_000 }, () => {
  it("a reviewed local change that passed its checks merges through the local merge, actor system:auto, naming the mode change", async () => {
    const f = await autoFactory();
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const [flip] = await f.modeRows();
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    const done = (await f.store.getWorkItem(id))!;
    expect(done).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: git(f.repo, "rev-parse", "main") });
    expect(git(f.repo, "rev-parse", "main")).not.toBe(mainBefore);
    const merged = (await f.changes(id)).find((c) => c.reason === "local_merged")!;
    expect(merged.actor).toEqual(AUTO);
    // Through merge_queued, as a person's merge: moved by system:auto with its merge key before the check.
    const reasons = (await f.changes(id)).map((c) => c.reason);
    expect(reasons.indexOf("merge_requested")).toBeGreaterThan(-1);
    expect(reasons.indexOf("merge_requested")).toBeLessThan(reasons.indexOf("merge_check_queued"));
    expect((await f.changes(id)).find((c) => c.reason === "merge_requested")).toMatchObject({
      actor: AUTO, changes: { blocked_reason: { from: "merge_pending", to: "merge_queued" } }, detail: { merge_key: expect.stringMatching(/^auto-merge:/) },
    });
    expect(merged.detail).toMatchObject({ mode_change: flip!.seq });
    expect((await f.messages(id, "<!-- factory:local-merged:")).join("")).toContain("in auto mode");
    // The red-main check passed: still auto, no alert.
    expect(await f.store.listAlerts({ limit: 10 })).toEqual([]);
    expect((await f.modeRows()).map((r) => r.new_value)).toEqual(['"auto"']);
  });

  it("the drop-back: a holding tier still merges with 1 reverted merge among its last 20", async () => {
    const f = await autoFactory({ record: { merges: 51, bad: 1 } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect(await f.messages(id, "<!-- factory:auto-merge-held:")).toEqual([]);
  });

  it("the drop-back: after 2 reverted merges among its last 20 the tier waits for a person, and the stored setting is unchanged", async () => {
    const f = await autoFactory({ record: { merges: 52, bad: 2 } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const settingRows = async () => (await f.store.listSettingChanges(50)).filter((c) => c.key === "auto_merge_max_tier");
    const before = await settingRows();
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    const held = await f.messages(id, "<!-- factory:auto-merge-held:");
    expect(held).toHaveLength(1);
    expect(held[0]).toContain("tier 2 dropped back: 2 or more of its last 20 merges were reverted or fixed forward");
    expect(await settingRows()).toEqual(before);
    expect((await f.store.listSettingOverrides()).find((o) => o.key === "auto_merge_max_tier")).toMatchObject({ value: "3" });
  });

  it("with auto_merge_max_tier at its default 0, a reviewed change waits for a person, and the reply says why", async () => {
    const f = await autoFactory();
    await f.mode("auto");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect((await f.messages(id, "<!-- factory:auto-merge-held:")).join("")).toContain("above auto_merge_max_tier (0)");
  });

  for (const [what, o] of [
    ["a tier 4 change", { reviewTier: 4 }],
    ["a change touching the gate list", { spec: { allowed_paths: ["prompts/"], files_to_change: ["prompts/x.md"] } }],
  ] as const) {
    it(`${what} stays in merge_pending and never merges, whatever its checks say`, async () => {
      const f = await autoFactory(o);
      await f.setting("auto_merge_max_tier", 3);
      await f.mode("auto");
      const mainBefore = git(f.repo, "rev-parse", "main");
      const id = await f.create();
      await f.step();
      // A spec auto mode may not approve waits for /approve; one it approved waits for a person under the Rule of Two.
      await f.cli(ME, { action: "command", command: "approve", id, text: "" });
      await f.step();
      await f.step();
      expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
      expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
      expect((await f.changes(id)).some((c) => c.reason === "local_merged")).toBe(false);
      expect(await f.messages(id, "<!-- factory:auto-merge-held:")).toHaveLength(1);
    });
  }

  it("an item the improver filed is triaged with no person starting it, and its change touching the gate list waits for a person's merge", async () => {
    const f = await autoFactory({ spec: { allowed_paths: ["prompts/"], files_to_change: ["prompts/x.md"] } });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.fileAsImprover();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ requester_id: IMPROVER.id, stage: "READY", blocked_reason: "spec_pending" });
    expect((await f.messages(id, "<!-- factory:spec:")).join("\n")).toContain("Auto mode is on, but this spec waits for `/approve`");
    await f.cli(ME, { action: "command", command: "approve", id, text: "" });
    await f.step();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    expect((await f.changes(id)).some((c) => c.reason === "local_merged")).toBe(false);
    expect((await f.messages(id, "<!-- factory:auto-merge-held:")).join("")).toContain("it touches the gate list (`prompts/");
  });

  it("a merge whose checks fail on the merge commit moves nothing and sends the item back to implement as a loop", async () => {
    const f = await autoFactory({ test_command: FAILS_ON_MERGE });
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const mainBefore = git(f.repo, "rev-parse", "main");
    const id = await f.create();
    await f.step();
    await f.approveRun(id);
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "RUNNING", loop_count: 1 });
    expect((await f.changes(id)).map((c) => c.reason)).toContain("merge_check_failed");
    expect(git(f.repo, "rev-parse", "main")).toBe(mainBefore);
    // Tried once for this version of the item: one refusal, not one per tick.
    const refused = await f.messages(id, "<!-- factory:refused:auto-merge:");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("The automatic merge was not applied");
    expect(refused[0]).toContain("the factory sent it back to the implementer (loop 1 of");
  });

  it("a sync source's item is never merged in auto mode: it waits as in manual mode, with no post", async () => {
    const f = await autoFactory();
    await f.setting("auto_merge_max_tier", 3);
    await f.mode("auto");
    const { item: it0 } = await f.store.createWorkItem({ ...issue(7), project: f.project.key }, system);
    const r = await f.store.transition({
      id: it0.id, expected_version: it0.version, actor: system, reason: "test",
      patch: { stage: "REVIEW", tier: 1, change_ref: "7", allowed_paths: ["docs/"], blocked_on: "human", blocked_reason: "merge_pending" },
    });
    expect(r.ok).toBe(true);
    await f.controller.tickRuns();
    expect(await f.store.getWorkItem(it0.id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(await f.store.listItemMessages(it0.id)).toEqual([]);
  });
});

describe("auto mode: the flip", { timeout: 60_000 }, () => {
  it("factory mode writes one audit row naming the actor and the time; a project flip applies to that project only", async () => {
    const f = await autoFactory();
    const r = await f.mode("auto", ME, "--project", "o/r");
    expect(r).toMatchObject({ ok: true });
    const rows = await f.modeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ project: f.project.key, actor: ME, new_value: '"auto"', at: f.clock.now().toISOString() });
    const id = await f.create();
    await f.step();
    expect((await f.changes(id)).find((c) => c.reason === "spec_approved")?.actor).toEqual(AUTO);
  });

  it("a flip by anyone but the owner is refused and writes no row", async () => {
    const f = await autoFactory();
    // The first local identity is the owner; DEV is not.
    await f.store.claimOwner(ME);
    const r = await f.mode("auto", DEV);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("approve_merge");
    expect(await f.store.listSettingChanges(10)).toEqual([]);
  });
});
