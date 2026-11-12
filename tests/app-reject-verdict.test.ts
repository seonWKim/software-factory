import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { AppCommandRequest } from "../src/interfaces/factory-store.js";
import type { AuthAction, AuthProvider, AuthResource, CommandPassport, Principal } from "../src/interfaces/auth-provider.js";
import type { EgressScanner } from "../src/interfaces/egress-scanner.js";
import { FakeAuth, FakeForge, FakeSource, alice, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The dashboard's reject and verdict (issue #452): an app `reject` goes through the `/reject` transition and its
// close, which now also closes an open PR; an app `verdict` is stored through the verdict path, also on a local item
// with no PR. A dashboard `revise` (issue #527) is the issue's `/revise`, its feedback stored as typed. A refusal is one
// reply on the item's source and changes nothing. A dashboard approve, retry and resolve (issue #453) go through the
// comment command's handler too.

/** FakeAuth lets github:1 do everything, nobody else. */
const WRITER = "github:1" as UserId;
const READER = "github:666" as UserId;
const SPEC_PENDING: WorkItemPatch = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" };
const MAX_LOOPS_PR: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "max_loops", change_ref: "42" };
const MERGE_PENDING: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" };
const MERGED: WorkItemPatch = { stage: "CLOSED", close_reason: "completed", merge_sha: "m1", blocked_on: "none", blocked_reason: null };
const REJECTED: WorkItemPatch = { stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null };
const localRef = (n: number): SourceRef => ({ type: "local", id: `local-${n}`, link: `local:local-${n}` });

/** Flags any text with "SECRET" in it. */
const flagging: EgressScanner = {
  async scan(channel, content) {
    return content.includes("SECRET") ? { clean: false, findings: [{ rule: "test_rule", channel }] } : { clean: true };
  },
};

async function harness(opts: { scanner?: EgressScanner; auth?: AuthProvider } = {}) {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const forge = new FakeForge(source);
  const controller = new ControllerRole({
    store, sources: [source], forge, auth: opts.auth ?? new FakeAuth(), clock, config, log: silent, scanner: opts.scanner ?? cleanScanner,
  });
  const actor = { kind: "system" as const, id: "system:test" };
  const itemIn = async (ref: SourceRef, patch: WorkItemPatch): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: ref, requester_id: WRITER, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
    const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch: { ...patch, tier: 2 } });
    if (!r.ok) throw new Error("setup failed");
    return r.item;
  };
  let keys = 0;
  const request = async (it: WorkItem, command: string, note: string | null, who: UserId = WRITER, key = `k${++keys}`): Promise<AppCommandRequest> => {
    const args = { work_item_id: it.id, ...(note === null ? {} : { note }) };
    return (await store.recordAppCommandRequest({ key, actor: who, command, args })).request;
  };
  /** Applies the pending requests, then lets outbound deliver what they wrote. */
  const apply = async () => {
    await controller.tickCommands();
    await controller.tickOutbox();
  };
  /** The item's thread entries refusing request `r`. */
  const refusals = async (it: WorkItem, r: AppCommandRequest) =>
    (await store.listItemMessages(it.id)).filter((m) => m.marker === `<!-- factory:refused:app-${r.seq} -->`).map((m) => m.body);
  const verdicts = (it: WorkItem) => store.listVerdicts(it.id);
  const changes = async (it: WorkItem) => (await store.listStateChanges(it.id)).slice(2);
  const get = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  return { store, clock, source, forge, controller, itemIn, request, apply, refusals, verdicts, changes, get };
}

describe("dashboard reject", () => {
  it("on a GitHub spec waiting for approval: the /reject transition, the reason as feedback, the seq on the change", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const r = await h.request(it1, "reject", "out of scope");
    await h.apply();

    expect(await h.get(it1)).toMatchObject({
      stage: "CLOSED", close_reason: "rejected", spec_feedback: "out of scope", blocked_on: "none", blocked_reason: null,
    });
    const reject = (await h.changes(it1)).find((c) => c.reason === "spec_rejected");
    expect(reject).toMatchObject({ actor: { kind: "user", id: WRITER }, detail: expect.objectContaining({ app_request: r.seq }) });
    expect(h.source.closed).toEqual([it1.source]);
    expect(h.source.comments.map((c) => c.body)).toEqual([expect.stringContaining("> out of scope")]);
    expect(h.forge.prCloseCalls).toEqual([]);
    expect(await h.store.getAppCommandRequest(r.seq)).toMatchObject({ refusal: null });
    expect(await h.refusals(it1, r)).toEqual([]);
  });

  it("on a GitHub item with an open PR: one PR comment quoting the reason, then the PR closed without a merge", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), MAX_LOOPS_PR);
    await h.request(it1, "reject", "wrong approach");
    await h.apply();

    expect(await h.get(it1)).toMatchObject({ stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null });
    expect(h.source.closed).toEqual([it1.source]);
    expect(h.forge.prStates.get(42)).toBe("closed");
    expect(h.forge.mergeCalls).toEqual([]);
    expect(h.forge.prComments).toEqual([expect.objectContaining({ pr_number: 42, body: expect.stringContaining("> wrong approach") })]);
  });

  it("the pending mark stays until the PR close is done; a failed close is retried later and posts no second comment", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), MAX_LOOPS_PR);
    h.forge.prCloseError = new Error("boom");
    await h.request(it1, "reject", "wrong approach");
    await h.apply();
    expect(await h.get(it1)).toMatchObject({ stage: "CLOSED", close_reason: "rejected", blocked_on: "upstream", blocked_reason: "pr_close_pending" });
    expect(h.source.closed).toEqual([it1.source]);
    expect(h.forge.prStates.get(42) ?? "open").toBe("open");

    h.forge.prCloseError = null;
    await h.controller.tickSourceCloses();
    h.clock.advance(config.retry_max_ms);
    await h.controller.tickOutbox();
    expect(h.forge.prStates.get(42)).toBe("closed");
    expect(h.forge.prComments).toHaveLength(1);
    expect(await h.get(it1)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    // Later ticks change nothing.
    const calls = h.forge.prCloseCalls.length;
    await h.controller.tickSourceCloses();
    await h.controller.tickOutbox();
    expect(h.forge.prCloseCalls).toHaveLength(calls);
  });

  it("on a GitHub item whose PR is already merged: the item closes, the PR gets no comment and no close", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), MAX_LOOPS_PR);
    h.forge.prStates.set(42, "merged");
    await h.request(it1, "reject", "too late");
    await h.apply();
    expect(await h.get(it1)).toMatchObject({ stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null });
    expect(h.forge.prStates.get(42)).toBe("merged");
    expect(h.forge.prComments).toEqual([]);
  });

  it("on a local item: closed locally, with no call to any sync plugin", async () => {
    const h = await harness();
    h.source.commentError = new Error("github down");
    h.source.closeError = new Error("github down");
    h.forge.prCloseError = new Error("github down");
    const it1 = await h.itemIn(localRef(1), SPEC_PENDING);
    const r = await h.request(it1, "reject", "not needed");
    await h.apply();
    expect(await h.get(it1)).toMatchObject({
      stage: "CLOSED", close_reason: "rejected", spec_feedback: "not needed", blocked_on: "none", blocked_reason: null,
    });
    const messages = (await h.store.listItemMessages(it1.id)).map((m) => m.body);
    expect(messages).toContainEqual(expect.stringContaining("> not needed"));
    expect(h.source.closed).toEqual([]);
    expect(h.forge.prCloseCalls).toEqual([]);
    expect(await h.refusals(it1, r)).toEqual([]);
  });

  it("at the merge wait: the item closes as rejected with its open PR, and gets no refusal", async () => {
    const h = await harness();
    for (const [n, ref, patch] of [[1, issueRef(1), MERGE_PENDING], [2, localRef(2), { ...MERGE_PENDING, change_ref: null }]] as const) {
      const it1 = await h.itemIn(ref, patch);
      const r = await h.request(it1, "reject", "no");
      await h.apply();
      await h.apply();
      expect(await h.get(it1), `item ${n}`).toMatchObject({ stage: "CLOSED", close_reason: "rejected", spec_feedback: "no", blocked_on: "none", blocked_reason: null });
      expect(await h.refusals(it1, r)).toEqual([]);
      expect((await h.store.getAppCommandRequest(r.seq))!.refusal).toBeNull();
    }
    expect(h.forge.prStates.get(42)).toBe("closed");
    expect(h.forge.mergeCalls).toEqual([]);
    expect(h.forge.prComments).toEqual([expect.objectContaining({ pr_number: 42, body: expect.stringContaining("> no") })]);
  });

  it("a reason the egress scan flags is refused with one reply, and nothing changes", async () => {
    const h = await harness({ scanner: flagging });
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const r = await h.request(it1, "reject", "the key is SECRET");
    await h.apply();
    expect(await h.get(it1)).toEqual(it1);
    const [reply, ...more] = await h.refusals(it1, r);
    expect(more).toEqual([]);
    expect(reply).toMatch(/^`\/reject` was not applied: the note was blocked by the leak scanner \(`test_rule`\)/);
    expect(reply).not.toContain("SECRET");
    expect(h.source.closed).toEqual([]);
  });

  it("a user without approve_spec is refused with the existing wording, and nothing is stored", async () => {
    const h = await harness();
    for (const ref of [issueRef(1), localRef(2)]) {
      const it1 = await h.itemIn(ref, SPEC_PENDING);
      const r = await h.request(it1, "reject", "no", READER);
      await h.apply();
      expect(await h.get(it1)).toEqual(it1);
      expect(await h.refusals(it1, r)).toEqual(["`/reject` was not applied: it needs write permission on this repository (`not_a_collaborator`)."]);
    }
  });

  it("the same request applied again (same seq, same key) rejects once", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), MAX_LOOPS_PR);
    const r = await h.request(it1, "reject", "no", WRITER, "same");
    await h.apply();
    await h.request(it1, "reject", "no", WRITER, "same");
    await h.apply();
    expect((await h.changes(it1)).filter((c) => c.reason === "spec_rejected")).toHaveLength(1);
    expect(h.forge.prComments).toHaveLength(1);
    expect(h.source.comments).toHaveLength(1);
    expect(await h.refusals(it1, r)).toEqual([]);
  });
});

describe("/reject comment on an item with an open PR", () => {
  it("also closes the PR, with one comment quoting the reason", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), MAX_LOOPS_PR);
    await h.controller.handleEvent({ kind: "spec_rejected", source: issueRef(1), comment_id: "c1", approver: alice, reason: "no thanks" });
    await h.controller.tickOutbox();
    expect(await h.get(it1)).toMatchObject({ stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null });
    expect(h.forge.prStates.get(42)).toBe("closed");
    expect(h.forge.prComments.map((c) => c.body)).toEqual([expect.stringContaining("> no thanks")]);
  });
});

describe("dashboard verdict", () => {
  it("on an open local item with no PR: one verdict (comment app-<seq>, target issue, no pr_head) and one state change", async () => {
    const h = await harness();
    const it1 = await h.itemIn(localRef(1), SPEC_PENDING);
    const r = await h.request(it1, "verdict", "changes minor rename the flag");
    await h.apply();
    expect(await h.verdicts(it1)).toEqual([expect.objectContaining({
      verdict: "changes", severity: "minor", reason: "rename the flag", comment_id: `app-${r.seq}`, target: "issue", pr_head: null, implicit: false,
    })]);
    expect((await h.changes(it1)).map((c) => [c.reason, c.actor])).toEqual([["human_verdict", { kind: "user", id: WRITER }]]);
    expect(await h.get(it1)).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    expect(await h.refusals(it1, r)).toEqual([]);
    expect(await h.store.getAppCommandRequest(r.seq)).toMatchObject({ refusal: null });
  });

  it("on a merged local item: stored the same way", async () => {
    const h = await harness();
    const it1 = await h.itemIn(localRef(1), MERGED);
    const r = await h.request(it1, "verdict", "accept");
    await h.apply();
    expect(await h.verdicts(it1)).toEqual([expect.objectContaining({ verdict: "accept", comment_id: `app-${r.seq}`, target: "issue", pr_head: null })]);
    expect(await h.get(it1)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
  });

  it("on a GitHub item with a PR: stored", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), MERGE_PENDING);
    const r = await h.request(it1, "verdict", "accept none");
    await h.apply();
    expect(await h.verdicts(it1)).toEqual([expect.objectContaining({ verdict: "accept", comment_id: `app-${r.seq}`, target: "issue" })]);
  });

  it("on a closed local item that was not merged: refused with one reply, nothing stored", async () => {
    const h = await harness();
    const it1 = await h.itemIn(localRef(1), REJECTED);
    const r = await h.request(it1, "verdict", "accept");
    await h.apply();
    await h.apply();
    expect(await h.verdicts(it1)).toEqual([]);
    expect(await h.get(it1)).toEqual(it1);
    expect(await h.refusals(it1, r)).toEqual(["`/verdict` was not applied: the work item is closed."]);
  });

  it("on a GitHub item with no PR yet: refused as before", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const r = await h.request(it1, "verdict", "accept");
    await h.apply();
    expect(await h.verdicts(it1)).toEqual([]);
    expect(await h.refusals(it1, r)).toEqual(["`/verdict` was not applied: the work item has no PR yet."]);
  });

  it("a malformed note is refused with the usage line, and nothing is stored", async () => {
    const h = await harness();
    for (const ref of [localRef(1), issueRef(2)]) {
      const it1 = await h.itemIn(ref, MERGE_PENDING);
      const r = await h.request(it1, "verdict", "lgtm");
      await h.apply();
      expect(await h.verdicts(it1)).toEqual([]);
      expect(await h.get(it1)).toEqual(it1);
      const [reply, ...more] = await h.refusals(it1, r);
      expect(more).toEqual([]);
      expect(reply).toContain("/verdict accept|changes|reject <none|minor|major|critical> <reason>");
    }
  });

  it("a user without record_verdict is refused with the existing wording, and nothing is stored", async () => {
    const h = await harness();
    for (const ref of [localRef(1), issueRef(2)]) {
      const it1 = await h.itemIn(ref, MERGE_PENDING);
      const r = await h.request(it1, "verdict", "accept", READER);
      await h.apply();
      expect(await h.verdicts(it1)).toEqual([]);
      expect(await h.get(it1)).toEqual(it1);
      expect(await h.refusals(it1, r)).toEqual(["`/verdict` was not applied: it needs write permission on this repository (`not_a_collaborator`)."]);
    }
  });

  it("the same request applied again (same seq, same key) stores one verdict", async () => {
    const h = await harness();
    const it1 = await h.itemIn(localRef(1), SPEC_PENDING);
    const r = await h.request(it1, "verdict", "accept", WRITER, "same");
    await h.apply();
    await h.request(it1, "verdict", "accept", WRITER, "same");
    await h.apply();
    expect(await h.verdicts(it1)).toHaveLength(1);
    expect((await h.changes(it1)).filter((c) => c.reason === "human_verdict")).toHaveLength(1);
    expect(await h.refusals(it1, r)).toEqual([]);
  });
});

describe("dashboard revise (issue #527)", () => {
  const FEEDBACK = "### Problem\nSay why the gate is slow.\n\n### Done when\nAdd a timing test.";

  it("on a spec waiting for approval: the /revise transition, the feedback stored as typed, the seq on the change, a new triage run", async () => {
    const h = await harness();
    for (const [n, ref] of [[1, issueRef(1)], [2, localRef(2)]] as const) {
      const it1 = await h.itemIn(ref, SPEC_PENDING);
      const r = await h.request(it1, "revise", FEEDBACK);
      await h.apply();
      expect(await h.get(it1), `item ${n}`).toMatchObject({ stage: "NEW", blocked_on: "none", blocked_reason: null, spec_feedback: FEEDBACK, revision_count: 1 });
      const revise = (await h.changes(it1)).find((c) => c.reason === "spec_revision_requested");
      expect(revise).toMatchObject({ actor: { kind: "user", id: WRITER }, detail: expect.objectContaining({ app_request: r.seq }) });
      expect((await h.store.listRuns(it1.id)).map((x) => x.kind)).toEqual(["triage"]);
      expect(await h.store.getAppCommandRequest(r.seq)).toMatchObject({ refusal: null });
      expect(await h.refusals(it1, r)).toEqual([]);
    }
  });

  it("a user without approve_spec is refused with the existing wording, and nothing is stored", async () => {
    const h = await harness();
    for (const ref of [issueRef(1), localRef(2)]) {
      const it1 = await h.itemIn(ref, SPEC_PENDING);
      const r = await h.request(it1, "revise", FEEDBACK, READER);
      await h.apply();
      expect(await h.get(it1)).toEqual(it1);
      expect(await h.store.listRuns(it1.id)).toEqual([]);
      expect(await h.refusals(it1, r)).toEqual(["`/revise` was not applied: it needs write permission on this repository (`not_a_collaborator`)."]);
    }
  });

  it("where /revise is refused (a floor block): one reply naming the state, and nothing changes", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), { stage: "RUNNING", blocked_on: "human", blocked_reason: "floor_tier" });
    const r = await h.request(it1, "revise", FEEDBACK);
    await h.apply();
    expect(await h.get(it1)).toEqual(it1);
    const [reply, ...more] = await h.refusals(it1, r);
    expect(more).toEqual([]);
    expect(reply).toMatch(/^`\/revise` was not applied: the item is .*not waiting on a spec/);
  });

  it("feedback the egress scan flags is refused with one reply, and nothing changes", async () => {
    const h = await harness({ scanner: flagging });
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const r = await h.request(it1, "revise", "the key is SECRET");
    await h.apply();
    expect(await h.get(it1)).toEqual(it1);
    const [reply] = await h.refusals(it1, r);
    expect(reply).toMatch(/^`\/revise` was not applied: the note was blocked by the leak scanner \(`test_rule`\)/);
    expect(reply).not.toContain("SECRET");
  });

  it("the same request applied again (same seq, same key) revises once", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const r = await h.request(it1, "revise", FEEDBACK, WRITER, "same");
    await h.apply();
    await h.request(it1, "revise", FEEDBACK, WRITER, "same");
    await h.apply();
    expect((await h.changes(it1)).filter((c) => c.reason === "spec_revision_requested")).toHaveLength(1);
    expect(await h.store.listRuns(it1.id)).toHaveLength(1);
    expect(await h.refusals(it1, r)).toEqual([]);
  });
});

describe("dashboard approve, retry and resolve (issue #453): the comment command's path", () => {
  const FAILED_IMPLEMENT: WorkItemPatch = { stage: "RUNNING", blocked_on: "human", blocked_reason: "run_failed:implement:agent_error" };
  const CONFLICT: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending", change_ref: "42" };
  const CASES: [string, WorkItemPatch, string, WorkItemPatch, string][] = [
    ["approve", SPEC_PENDING, "spec_approved", { stage: "RUNNING", blocked_on: "none", blocked_reason: null }, "implement"],
    ["retry", FAILED_IMPLEMENT, "retry_requested", { stage: "RUNNING", blocked_on: "none", blocked_reason: null, restart_count: 1 }, "implement"],
    ["resolve", CONFLICT, "resolve_requested", { stage: "RUNNING", blocked_on: "none", blocked_reason: null, restart_count: 1 }, "resolve"],
  ];

  it.each(CASES)("%s: the comment's transition, the seq on the change, one run; on a GitHub and on a local item", async (command, from, reason, to, run) => {
    const h = await harness();
    for (const [n, ref] of [[1, issueRef(1)], [2, localRef(2)]] as const) {
      const it1 = await h.itemIn(ref, from);
      const r = await h.request(it1, command, "keep it small");
      await h.apply();
      expect(await h.get(it1), `item ${n}`).toMatchObject(to);
      const change = (await h.changes(it1)).find((c) => c.reason === reason);
      expect(change).toMatchObject({ actor: { kind: "user", id: WRITER }, detail: expect.objectContaining({ app_request: r.seq }) });
      expect((await h.store.listRuns(it1.id)).map((x) => x.kind)).toEqual([run]);
      expect(await h.store.getAppCommandRequest(r.seq)).toMatchObject({ refusal: null });
      expect(await h.refusals(it1, r)).toEqual([]);
    }
  });

  it.each(CASES)("%s from the same comment gives the same state as from the dashboard", async (command, from, reason) => {
    const h = await harness();
    const byPage = await h.itemIn(issueRef(1), from);
    const byComment = await h.itemIn(issueRef(2), from);
    await h.request(byPage, command, null);
    await h.apply();
    const at = { source: byComment.source, comment_id: "c1" };
    const e = command === "approve"
      ? { kind: "spec_approved" as const, ...at, approver: alice }
      : command === "retry"
        ? { kind: "retry_requested" as const, ...at, requester: alice }
        : { kind: "resolve_requested" as const, ...at, requester: alice, notes: "", pr: null };
    await h.controller.handleEvent(e);
    const { id: _a, source: _s, version: _v, created_at: _c, updated_at: _u, ...page } = await h.get(byPage);
    const { id: _b, source: _t, version: _w, created_at: _d, updated_at: _x, ...comment } = await h.get(byComment);
    expect(page).toEqual(comment);
    expect((await h.changes(byPage)).map((c) => c.reason)).toEqual((await h.changes(byComment)).map((c) => c.reason));
    expect((await h.changes(byPage)).map((c) => c.reason)).toContain(reason);
  });

  it.each(CASES)("%s by a user without approve_spec: refused with the comment's wording, once, and nothing is written", async (command, from) => {
    const h = await harness();
    for (const ref of [issueRef(1), localRef(2)]) {
      const it1 = await h.itemIn(ref, from);
      const r = await h.request(it1, command, null, READER);
      await h.apply();
      await h.apply();
      expect(await h.get(it1)).toEqual(it1);
      expect(await h.changes(it1)).toEqual([]);
      expect(await h.store.listRuns(it1.id)).toEqual([]);
      const reply = `\`/${command}\` was not applied: it needs write permission on this repository (\`not_a_collaborator\`).`;
      expect(await h.refusals(it1, r)).toEqual([reply]);
      expect((await h.store.getAppCommandRequest(r.seq))!.refusal).toBe(reply);
    }
  });

  it.each(CASES)("%s where the state cannot take it: the comment's refusal, posted once and stored on the row", async (command) => {
    const h = await harness();
    for (const ref of [issueRef(1), localRef(2)]) {
      const it1 = await h.itemIn(ref, MERGE_PENDING);
      const r = await h.request(it1, command, null);
      await h.apply();
      await h.apply();
      expect(await h.get(it1)).toEqual(it1);
      const [reply, ...more] = await h.refusals(it1, r);
      expect(more).toEqual([]);
      expect(reply).toMatch(new RegExp(`^\`/${command}\` was not applied: `));
      expect((await h.store.getAppCommandRequest(r.seq))!.refusal).toBe(reply);
    }
  });

  it.each(CASES)("%s applied a second time (the same row again, before its mark) changes nothing", async (command, from, reason) => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), from);
    const r = await h.request(it1, command, null);
    await h.apply();
    await (await h.controller.unit("app-requests")).applyAppRequest(r);
    expect((await h.changes(it1)).filter((c) => c.reason === reason)).toHaveLength(1);
    expect(await h.store.listRuns(it1.id)).toHaveLength(1);
    expect(await h.refusals(it1, r)).toEqual([]);
  });

  it("the note is the note: a `+paths` line is not read, and the paths stay as they were", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    await h.request(it1, "approve", "+paths src/other.ts");
    await h.apply();
    expect(await h.get(it1)).toMatchObject({ stage: "RUNNING", allowed_paths: it1.allowed_paths });
    expect((await h.changes(it1)).find((c) => c.reason === "spec_approved")?.detail).toMatchObject({ note: "+paths src/other.ts" });
  });

  it("the check is approve_spec on the item for the request's user, with the request's edge passport", async () => {
    const asked: unknown[] = [];
    const fake = new FakeAuth();
    const recording: AuthProvider = {
      resolve: (i) => fake.resolve(i),
      authorize: async (p: Principal, action: AuthAction, resource: AuthResource, passport?: CommandPassport) => {
        asked.push({ user_id: p.user_id, action, resource, passport });
        return fake.authorize(p, action);
      },
    };
    const h = await harness({ auth: recording });
    const it1 = await h.itemIn(localRef(1), FAILED_IMPLEMENT);
    // The row as the unit gets it, with its passport (the request's edge passport, recorded by the page).
    const r = { ...(await h.request(it1, "retry", null)), passport_id: "pp1" };
    await (await h.controller.unit("app-requests")).applyAppRequest(r);
    expect(asked).toEqual([{ user_id: WRITER, action: "approve_spec", resource: { kind: "work_item", id: it1.id }, passport: { id: "pp1", at: r.created_at } }]);
  });
});

describe("app commands still not applied", () => {
  it("the refusal names the commands that are: approve, merge, reject, resolve, retry, revise and verdict", async () => {
    const h = await harness();
    const it1 = await h.itemIn(issueRef(1), SPEC_PENDING);
    const r = await h.request(it1, "budget", "1000");
    await h.apply();
    expect(await h.get(it1)).toEqual(it1);
    expect(await h.refusals(it1, r)).toEqual([
      "`budget` was not applied: only `approve`, `merge`, `reject`, `resolve`, `retry`, `revise` and `verdict` are applied from an app request; reply `/budget` on the issue instead.",
    ]);
  });
});
