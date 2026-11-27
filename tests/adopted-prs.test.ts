import { describe, expect, it } from "vitest";
import type { WorkerId } from "../src/core/types.js";
import type { ForgeEvent } from "../src/interfaces/forge.js";
import { SKIP_LABEL } from "../src/core/policy.js";
import { projectLabelCursor } from "../src/core/project.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { alice, issueRef, mallory, recordingLog, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY } from "./helpers/store.js";
import { bob, factory, prOpen, prRef } from "./helpers/classifier.js";

// Pull requests the factory did not open (design 2026-11-01): adoption, `factory: skip` and a person's pushes
// recorded as `manual` runs. Merges and the first start are in adopted-prs-merges.test.ts.

describe("adopting a pull request a person opened", () => {
  it("one non-draft PR on a non-factory branch becomes one item at REVIEW with one review run; a second poll adds nothing", async () => {
    const f = await factory();
    f.forge.prFileMap[50] = ["src/core/stats.ts", "docs/design.md"];
    await f.poll(prOpen(50));
    await f.poll(prOpen(50));

    expect(await f.store.listWorkItems(10)).toHaveLength(1);
    const it = (await f.item(50))!;
    expect(it).toMatchObject({
      origin: "adopted",
      source: prRef(50),
      title: "Speed up the poll",
      requester_id: "github:2",
      stage: "REVIEW",
      blocked_on: "none",
      change_ref: "50",
      head_branch: "feature/x",
      last_head_sha: "h1",
      allowed_paths: ["src/core/stats.ts", "docs/design.md"],
      done_criteria: null,
    });
    expect(it.problem).toContain("Speed up the poll");
    expect(it.problem).toContain("It reads fewer pages now.");
    const runs = await f.store.listRuns(it.id);
    expect(runs.map((r) => [r.kind, r.status])).toEqual([["review", "queued"]]);
    // Full details are read only for a PR the store does not know yet.
    expect(f.forge.fileCalls).toEqual([50]);
    const sc = await f.store.listStateChanges(it.id);
    expect(sc.map((c) => [c.reason, c.actor])).toEqual([["pr_adopted", { kind: "user", id: "github:2" }]]);
    // The status label goes on the pull request (its source).
    expect(f.source.statusLabels(prRef(50))).toEqual(["in_review"]);
  });

  it("a GitHub item opened from change_open stores change_url as https://<label>/pull/<n>, the link the status UI shows", async () => {
    const f = await factory();
    const label = "github.com/o/r";
    await f.store.advanceCursor(projectLabelCursor(PROJECT_KEY), null, label);
    await f.poll(prOpen(50));
    const it = (await f.item(50))!;
    expect(it).toMatchObject({ change_ref: "50", change_url: `https://${label}/pull/50` });
    // The forge received the event, not the source (the harness routes change_* kinds to it).
    expect(f.forge.fileCalls).toEqual([50]);
  });

  it("the review reads the PR's head branch, its title, body and diff with no spec, and comments on the PR", async () => {
    const f = await factory();
    f.forge.prFileMap[50] = ["src/core/stats.ts"];
    await f.poll(prOpen(50));
    await f.work();

    expect(f.sandbox.created.map((s) => s.branch)).toEqual(["feature/x"]);
    const spec = f.runner.specs.find((s: AgentRunSpec) => s.role === "review")!;
    expect(spec.prompt).toContain("Speed up the poll");
    expect(spec.prompt).toContain("It reads fewer pages now.");
    expect(spec.prompt).toContain("+ a change");
    expect(spec.prompt).toContain("no spec");
    expect(spec.prompt).toContain("src/core/stats.ts");
    // The review comment went out through outbound, onto the PR; the run itself called no comment tool.
    expect(f.broker.calls.map((c) => c.name)).not.toContain("github.comment");
    const posted = f.forge.comments.filter((c) => c.marker.includes("factory:review:"));
    expect(posted.map((c) => c.pr_number)).toEqual([50]);

    const it = (await f.item(50))!;
    expect(it).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", tier: 1 });
    // The adopted item's own source is the PR: its comments go through the forge, onto the PR.
    const merge = f.forge.comments.find((c) => c.body.includes("human merge is required"))!;
    expect(merge.pr_number).toBe(50);
    expect(f.source.statusLabels(prRef(50))).toEqual(["ready_to_merge"]);
  });

  it("a floor path among the PR's files raises the tier", async () => {
    const f = await factory();
    f.forge.prFileMap[50] = ["src/impl/broker/github-broker.ts"];
    await f.poll(prOpen(50));
    expect((await f.item(50))!.tier).toBe(4);
    await f.work();
    expect((await f.item(50))!).toMatchObject({ tier: 4, blocked_reason: "merge_pending" });
  });

  it("a review that finds bugs blocks on a human: no implement run on a person's branch", async () => {
    const f = await factory({ review: () => ({ output: { verdict: "bug", tier: 1, findings: ["x"], summary: "bad" } }) });
    await f.poll(prOpen(50));
    await f.work();
    const it = (await f.item(50))!;
    expect(it).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "changes_requested", loop_count: 0 });
    expect((await f.store.listRuns(it.id)).map((r) => r.kind)).toEqual(["review"]);
  });

  it("a PR whose author the source does not name is not adopted", async () => {
    const f = await factory();
    await f.poll(prOpen(50, { author: null }));
    expect(await f.store.listWorkItems(10)).toEqual([]);
  });
});

describe("factory: skip", () => {
  it("added by a user with write permission: no item, and its merge writes one unreviewed merge", async () => {
    const f = await factory();
    f.forge.labelAdders[`51:${SKIP_LABEL}`] = alice;
    await f.poll(prOpen(51, { labels: [SKIP_LABEL] }));
    await f.poll(prOpen(51, { labels: [SKIP_LABEL] }));
    expect(await f.store.listWorkItems(10)).toEqual([]);
    expect(f.forge.fileCalls).toEqual([]);

    const merged: ForgeEvent = { kind: "change_merged", change_ref: "51", head_branch: "feature/x", merge_sha: "m51", merger: alice };
    await f.poll(merged);
    await f.poll(merged);
    expect(await f.store.listWorkItems(10)).toEqual([]);
    const rows = await f.store.listUnreviewedMerges(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ project: PROJECT_KEY, change_ref: "51", merge_sha: "m51", merger_id: "github:1" });
  });

  it("added by a user without write permission is ignored, and the PR is adopted", async () => {
    const f = await factory();
    f.forge.labelAdders[`52:${SKIP_LABEL}`] = mallory;
    await f.poll(prOpen(52, { labels: [SKIP_LABEL] }));
    expect((await f.item(52))!).toMatchObject({ origin: "adopted", stage: "REVIEW" });
  });

  it("a label added after adoption does nothing", async () => {
    const f = await factory();
    await f.poll(prOpen(53));
    f.forge.labelAdders[`53:${SKIP_LABEL}`] = alice;
    await f.poll(prOpen(53, { labels: [SKIP_LABEL] }));
    const it = (await f.item(53))!;
    expect(it).toMatchObject({ stage: "REVIEW", version: 1 });
  });
});

describe("a person's push to a factory or adopted PR", () => {
  it("gives one acknowledged manual run with the pusher and the range; no stage or blocked field changes", async () => {
    const f = await factory();
    await f.poll(prOpen(50));
    const before = (await f.item(50))!;
    f.forge.commitAuthors.h2 = alice;
    await f.poll(prOpen(50, { head_sha: "h2" }));
    await f.poll(prOpen(50, { head_sha: "h2" }));

    const after = (await f.item(50))!;
    expect(after).toMatchObject({
      stage: before.stage, blocked_on: before.blocked_on, blocked_reason: before.blocked_reason, version: before.version,
      last_head_sha: "h2",
    });
    const manual = (await f.store.listRuns(after.id)).filter((r) => r.kind === "manual");
    expect(manual).toHaveLength(1);
    expect(manual[0]!.status).toBe("succeeded");
    expect(manual[0]!.acknowledged_at).not.toBeNull();
    expect(manual[0]!.outcome).toMatchObject({
      status: "succeeded",
      data: { actor: { kind: "user", id: "github:1" }, from_sha: "h1", to_sha: "h2", pr_number: 50 },
    });
    // Never claimed, whatever kinds a worker asks for.
    await f.work();
    expect(await f.store.claimRun({ worker_id: "w9" as WorkerId, kinds: ["manual", "review"], lease_ms: 60_000 })).toBeNull();
    expect((await f.store.getRun(manual[0]!.id))!).toMatchObject({ status: "succeeded", attempt: 0, lease: null });
  });

  it("a pusher that does not resolve is recorded as system:pr-sync, with a warning", async () => {
    const log = recordingLog();
    const f = await factory({}, log);
    await f.poll(prOpen(50));
    await f.poll(prOpen(50, { head_sha: "h2" }));
    const manual = (await f.store.listRuns((await f.item(50))!.id)).filter((r) => r.kind === "manual");
    expect(manual[0]!.outcome).toMatchObject({ data: { actor: { kind: "system", id: "system:pr-sync" } } });
    expect(log.lines.some((l) => l.level === "warn" && l.msg.includes("pusher"))).toBe(true);
  });

  it("on a factory PR: the factory's own push gives none; a person's push after it gives one", async () => {
    const f = await factory();
    const src = issueRef(61);
    await f.poll({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await f.work();
    await f.poll({ kind: "spec_approved", source: src, comment_id: "300", approver: alice });
    await f.work();
    const it = (await f.store.getWorkItemBySource("github_issue", src.id))!;
    // The implement run recorded the head it pushed (FakeSandbox's HEAD).
    expect(it).toMatchObject({ origin: "factory", change_ref: "42", last_head_sha: "base", blocked_reason: "merge_pending" });

    const open = (sha: string) => prOpen(42, { head_branch: `factory/${it.id}`, head_sha: sha, source: prRef(42), author: alice });
    await f.poll(open("base"));
    expect((await f.store.listRuns(it.id)).filter((r) => r.kind === "manual")).toEqual([]);

    f.forge.commitAuthors.h9 = alice;
    await f.poll(open("h9"));
    const manual = (await f.store.listRuns(it.id)).filter((r) => r.kind === "manual");
    expect(manual).toHaveLength(1);
    expect(manual[0]!.outcome).toMatchObject({ data: { actor: { kind: "user", id: "github:1" }, from_sha: "base", to_sha: "h9" } });
    // The implicit `changes` verdict bumps the version once (design §4); no stage or blocked field changes.
    expect((await f.store.getWorkItem(it.id))!).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", version: it.version + 1 });
    expect((await f.store.listStateChanges(it.id)).at(-1)).toMatchObject({ reason: "implicit_verdict", actor: { kind: "user", id: "github:1" } });
    // The factory PR is not adopted a second time.
    expect(await f.store.listWorkItems(10)).toHaveLength(1);
  });

  it("on a factory PR: the implicit changes verdict gives the forge's commit count, or says it is unknown", async () => {
    const f = await factory();
    const src = issueRef(61);
    await f.poll({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await f.work();
    await f.poll({ kind: "spec_approved", source: src, comment_id: "300", approver: alice });
    await f.work();
    const it = (await f.store.getWorkItemBySource("github_issue", src.id))!;
    const open = (sha: string) => prOpen(42, { head_branch: `factory/${it.id}`, head_sha: sha, source: prRef(42), author: alice });

    f.forge.commitCounts["base..h2"] = 3;
    await f.poll(open("h2"));
    await f.poll(open("h3")); // h2..h3: the forge cannot say
    await f.poll(open("h3"));
    expect(f.forge.betweenCalls).toEqual(["base..h2", "h2..h3"]);
    expect((await f.store.listVerdicts(it.id)).map((v) => [v.verdict, v.severity, v.implicit, v.pr_head, v.reason])).toEqual([
      ["changes", "minor", true, "h2", "a person pushed 3 commits to the PR"],
      ["changes", "minor", true, "h3", "a person pushed to the PR; the commit count is unknown"],
    ]);
  });

  it("on an adopted PR: a person's push records no verdict", async () => {
    const f = await factory();
    await f.poll(prOpen(50));
    await f.poll(prOpen(50, { head_sha: "h2" }));
    expect(await f.store.listVerdicts((await f.item(50))!.id)).toEqual([]);
    expect(f.forge.betweenCalls).toEqual([]);
  });

  it("is not looked at while a run of the item is running (the factory may be pushing)", async () => {
    const f = await factory();
    await f.poll(prOpen(50));
    const run = await f.store.claimRun({ worker_id: "w9" as WorkerId, kinds: ["review"], lease_ms: 60_000 });
    expect(run).not.toBeNull();
    await f.poll(prOpen(50, { head_sha: "h2" }));
    const it = (await f.item(50))!;
    expect(it.last_head_sha).toBe("h1");
    expect((await f.store.listRuns(it.id)).filter((r) => r.kind === "manual")).toEqual([]);
  });
});

