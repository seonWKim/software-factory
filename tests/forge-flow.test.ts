// PRs through the forge (issue #273): a non-GitHub source runs alone with a forge, the forge is polled under its own
// guard, no forge means no PR read, and the forge takes over the GitHub source's old cursor.

import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { WorkerId, WorkItem } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubForge } from "../src/impl/github/github-forge.js";
import { GitHubIssueSource } from "../src/impl/github/github-issue-source.js";
import type { ExternalIdentity } from "../src/interfaces/auth-provider.js";
import {
  FakeAuth, FakeBroker, FakeForge, FakeRunner, FakeSandbox, FakeSlackPollSource, MemoryStorage,
  alice, cleanScanner, config, issueRef, prompts, recordingLog, silent, slackRef, triageSpec,
} from "./helpers/fakes.js";
import { RecordingGitHubClient } from "./helpers/github.js";
import { newStore } from "./helpers/store.js";

/** FakeAuth allows subject "1" only, whatever the provider. */
const slackAlice: ExternalIdentity = { provider: "slack", subject: "1" };
const CONFLICT = ["<<<<<<< HEAD", "export const gate = branchGate();", "=======", "export const gate = mainGate();", ">>>>>>> origin/main", ""].join("\n");

/** A Slack-type poll source alone, with a fake forge: no source of type github_issue anywhere. */
async function slackWithForge() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const slack = new FakeSlackPollSource();
  const forge = new FakeForge(slack);
  const log = recordingLog();
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "fine" } }),
    resolve: () => ({ output: { summary: "kept both gates", next_steps: "none" } }),
  });
  const sandbox = new FakeSandbox();
  const controller = new ControllerRole({ store, sources: [slack], forge, auth: new FakeAuth(), clock, config, log, scanner: cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox, runner, broker: new FakeBroker(), storage: new MemoryStorage(), clock, config, prompts,
    log: silent, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const item = async (): Promise<WorkItem> => (await store.getWorkItemBySource("slack_thread", slackRef(1).id))!;
  return { clock, store, slack, forge, log, sandbox, controller, step, item };
}

describe("a non-GitHub source alone with a forge (issue #273)", () => {
  it("takes one item from intake to a PR merged on the forge: CLOSED / completed, PR status and PR comments through the forge", async () => {
    const f = await slackWithForge();
    f.slack.queue.push({ kind: "item_requested", source: slackRef(1), requester: slackAlice, title: "t", body: "b" });
    await f.step();
    f.slack.queue.push({ kind: "spec_approved", source: slackRef(1), comment_id: "100", approver: slackAlice });
    await f.step();
    expect(await f.item()).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 42 });
    // The PR's checks were read from the forge, its status shown there; the item's own status stays on Slack.
    expect(f.forge.checkCalls).toEqual([42]);
    expect(f.forge.prStatus(42)).toBe("ready_to_merge");
    expect(f.slack.statusCalls.filter((c) => c.change_ref !== null)).toEqual([]);

    // The forge reports the PR cannot merge: the automatic resolve's note goes on the PR, through the forge.
    const id = (await f.item()).id;
    f.sandbox.ancestorExit = 1;
    f.sandbox.mergeExit = 1;
    f.sandbox.conflicts = ["src/gate.ts"];
    f.sandbox.files = { "src/gate.ts": CONFLICT };
    f.forge.queue.push({ kind: "change_unmergeable", change_ref: "42", head_branch: `factory/${id}`, head_sha: "h1", base_sha: "b1" });
    await f.step();
    expect(await f.item()).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect(f.forge.comments.filter((c) => c.marker.startsWith("<!-- factory:auto-resolved:")).map((c) => c.pr_number)).toEqual([42]);
    expect(f.slack.comments.some((c) => c.marker.startsWith("<!-- factory:auto-resolved:"))).toBe(false);

    f.forge.queue.push({ kind: "change_merged", change_ref: "42", head_branch: `factory/${id}`, merge_sha: "m42", merger: alice });
    await f.step();
    expect(await f.item()).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m42" });
    expect(f.forge.prStatus(42)).toBe("done");
    expect(f.slack.statusLabels(slackRef(1))).toEqual(["done"]);
  });

  it("a forge whose poll fails does not stop the source's intake in the same tick", async () => {
    const f = await slackWithForge();
    f.forge.pollError = new Error("forge down");
    f.slack.queue.push({ kind: "item_requested", source: slackRef(1), requester: slackAlice, title: "t", body: "b" });
    await f.controller.tickIntake();
    // Taken in, its triage run queued.
    expect((await f.store.listRuns((await f.item()).id)).map((r) => r.kind)).toEqual(["triage"]);
    expect(f.forge.polls).toEqual([null]);
    expect(f.log.lines.some((l) => l.msg === "loop step failed" && l.fields?.step === "forge")).toBe(true);
    // The forge's cursor did not move: the next tick asks from the same place.
    expect(await f.store.getCursor("forge:github_issue")).toBeNull();
  });

  it("a refused intake gets one reply on a source that does not refuse silently; the GitHub source refuses silently", async () => {
    const f = await slackWithForge();
    f.slack.queue.push({ kind: "item_requested", source: slackRef(2), requester: { provider: "slack", subject: "666" }, title: "t", body: "b" });
    const auth = new FakeAuth();
    auth.authorize = async () => ({ allow: false, reason: "no_role" });
    const refusing = new ControllerRole({ store: f.store, sources: [f.slack], forge: f.forge, auth, clock: f.clock, config, log: silent, scanner: cleanScanner });
    await refusing.tickIntake();
    expect(f.slack.comments.filter((c) => c.marker.startsWith("<!-- factory:refused-intake:"))).toHaveLength(1);
    expect(new GitHubIssueSource(new RecordingGitHubClient(), { owner: "o", name: "r" }, "factory", "factory/", "main").silent_intake_refusal).toBe(true);
  });
});

/** The GitHub source and, when `withForge`, the GitHub forge over one recording client, as build() makes them. */
async function github(o: { withForge: boolean }) {
  const clock = new FakeClock("2026-11-07T00:00:00Z");
  const { store } = await newStore(clock);
  const log = recordingLog();
  class Client extends RecordingGitHubClient {
    /** The closed-PR list, newest-updated first. */
    closed: unknown[] = [];
    override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (method === "GET" && path.startsWith("/repos/o/r/pulls?state=closed")) {
        this.calls.push({ method, path, body });
        return (path.includes("page=1") ? this.closed : []) as T;
      }
      if (method === "GET" && /^\/repos\/o\/r\/pulls\/\d+$/.test(path)) {
        this.calls.push({ method, path, body });
        return { merged_by: null } as T;
      }
      return super.request<T>(method, path, body);
    }
  }
  const client = new Client();
  const ctx = { clock, history_since: null, log };
  const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main", undefined, store);
  const forge = o.withForge ? new GitHubForge(client, { owner: "o", name: "r" }, "factory/", "main", source, ctx) : null;
  const controller = new ControllerRole({ store, source, forge, auth: new FakeAuth(), clock, config, log, scanner: cleanScanner });
  /** An item whose PR 42 waits for a human merge. */
  const waiting = async () => {
    const { item } = await store.createWorkItem(
      { source: issueRef(7), title: "t", requester_id: "github:1" as never, project: config.project.key, problem: "p", resources: [] },
      { kind: "system", id: "system:test" },
    );
    await store.transition({
      id: item.id, expected_version: item.version, actor: { kind: "system", id: "system:test" }, reason: "test",
      patch: { stage: "REVIEW", change_ref: "42", blocked_on: "human", blocked_reason: "merge_pending" },
    });
    return item.id;
  };
  return { clock, store, log, client, controller, waiting };
}

const mergedPr = (n: number, branch: string, at: string) => ({
  number: n, merged_at: at, merge_commit_sha: `m${n}`, updated_at: at,
  head: { ref: branch, sha: `h${n}`, repo: { full_name: "o/r" } }, base: { ref: "main", sha: "b" },
});

describe("GitHub with and without a forge (issue #273)", () => {
  it("with no forge, a poll tick makes no PR read and yields no PR event: a merged PR changes nothing", async () => {
    const f = await github({ withForge: false });
    const id = await f.waiting();
    f.client.responses["/repos/o/r/pulls"] = [mergedPr(42, `factory/${id}`, "2026-11-07T00:01:00Z")];
    f.clock.advance(120_000);
    await f.controller.tickIntake();
    expect(f.client.calls.filter((c) => c.path.startsWith("/repos/o/r/pulls"))).toEqual([]);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    // The issue reads still run.
    expect(f.client.calls.some((c) => c.path.startsWith("/repos/o/r/issues?state=open"))).toBe(true);
  });

  it("a cursor from before the forge is read without error, and a merge already applied is not applied twice", async () => {
    const T = "2026-11-06T00:00:00Z";
    const f = await github({ withForge: true });
    const id = await f.waiting();
    await f.controller.handleEvent({ kind: "change_merged", change_ref: "42", head_branch: `factory/${id}`, merge_sha: "m42", merger: alice });
    const applied = await f.store.listStateChanges(id);
    expect(applied.at(-1)).toMatchObject({ reason: "pr_merged" });
    // The GitHub source's cursor as the version before issue #273 wrote it: the PR position inside it.
    const old = JSON.stringify({ issues: null, comments: null, pulls: T, start: "2026-11-01T00:00:00Z", last_comment_id: null });
    expect(await f.store.advanceCursor("intake:github_issue", null, old)).toBe(true);

    // GitHub lists the merge already applied (at the old position, which is inclusive) and one after it.
    f.client.closed = [mergedPr(43, "feature/x", "2026-11-06T12:00:00Z"), mergedPr(42, `factory/${id}`, T)];
    await f.controller.tickIntake();

    expect(f.log.lines.filter((l) => l.msg === "loop step failed")).toEqual([]);
    expect(await f.store.listStateChanges(id)).toHaveLength(applied.length);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m42" });
    // Nothing between the old position and now is lost: the later merge with no item is recorded once.
    expect((await f.store.listUnreviewedMerges(10)).map((m) => m.pr_number)).toEqual([43]);
    // The forge now keeps its own cursor, from the old position on; the source's cursor still moved.
    expect(JSON.parse((await f.store.getCursor("forge:github_issue"))!)).toMatchObject({ start: "2026-11-01T00:00:00Z", pulls: "2026-11-06T12:00:00Z" });
    expect(await f.store.getCursor("intake:github_issue")).not.toBe(old);
  });
});
