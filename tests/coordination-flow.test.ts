import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DependencyLink, DependencySource } from "../src/core/coordination.js";
import { Controller } from "../src/core/controller.js";
import { statusOf } from "../src/core/status-label.js";
import type { DependencyState, RunKind, SourceRef, WorkItemId, WorkItemPatch } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubClient, GitHubError } from "../src/impl/github/github-client.js";
import { GitHubIssueSource } from "../src/impl/source/github-issue-source.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import type { SourceAdapter, SourceEvent } from "../src/interfaces/source-adapter.js";
import type { ExecResult } from "../src/interfaces/sandbox.js";
import { FakeAuth, type FakeSandbox, FakeSource, alice, cleanScanner, config, pipeline, silent, triageSpec } from "./helpers/fakes.js";
import { PROJECT_KEY, issue, newStore, system, w1 } from "./helpers/store.js";

const ALL: RunKind[] = ["triage", "implement", "review", "update", "resolve"];
const WORKER = "src/core/worker.ts";

/** FakeSource that also offers dependency links and states, as the GitHub source does. */
class DepSource extends FakeSource implements DependencySource {
  links = new Map<string, DependencyLink[]>();
  states = new Map<string, DependencyState>();
  async dependencyLinks(source: SourceRef): Promise<DependencyLink[]> {
    return this.links.get(source.id) ?? [];
  }
  async dependencyState(id: string): Promise<DependencyState> {
    return this.states.get(id) ?? "open";
  }
}

async function setup(source: SourceAdapter = new DepSource()) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  /** Issue `n` approved and implementing, with a queued implement run (or set up with `patch` and `kinds`). */
  const item = async (n: number, patch: WorkItemPatch = {}, kinds: RunKind[] = ["implement"]) => {
    const { item } = await store.createWorkItem(issue(n), system);
    let v = 1;
    await store.transition({
      id: item.id, expected_version: v++, actor: system, reason: "x",
      patch: { stage: "RUNNING", tier: 2, allowed_paths: ["lib/"], files_to_change: ["lib/x.ts"], ...patch },
    });
    for (const kind of kinds) {
      await store.transition({ id: item.id, expected_version: v++, patch: {}, actor: system, reason: "x", enqueue: { kind, idempotency_key: `${n}:${kind}` } });
    }
    // The poll's delivery of the issue, which reads its dependency links (design §5, 2026-11-07).
    await controller.handleEvent({ kind: "item_requested", source: issue(n).source, requester: alice, title: "t", body: "" });
    clock.advance(1_000);
    return item.id;
  };
  const claim = () => store.claimRun({ worker_id: w1, kinds: ALL, lease_ms: 60_000 });
  const get = async (id: WorkItemId) => (await store.getWorkItem(id))!;
  const queued = async (id: WorkItemId) => (await store.listRuns(id)).filter((r) => r.status === "queued");
  return { store, clock, controller, item, claim, get, queued };
}

describe("dependency holds (design §5, 2026-11-03)", () => {
  it("a dependency on an open item: blocked_on dependency, the reason names #N, the run is not claimed, the label stays implementing", async () => {
    const source = new DepSource();
    const f = await setup(source);
    source.links.set("o/r#1", [{ depends_on: "o/r#92", kind: "depends_on" }]);
    const a = await f.item(1);
    await f.controller.tickCoordination();
    expect(await f.get(a)).toMatchObject({ stage: "RUNNING", blocked_on: "dependency", blocked_reason: "waiting for #92 to merge" });
    expect(statusOf(await f.get(a))).toBe("implementing");
    expect(source.statusLabels(issue(1).source)).toEqual(["implementing"]);
    expect(await f.claim()).toBeNull();
    expect(await f.queued(a)).toHaveLength(1);
    expect(source.comments.find((c) => c.marker === `<!-- factory:dependency-hold:${a}:o/r#92 -->`)!.body)
      .toContain("waiting for #92 to merge");
    // A second tick changes nothing and posts nothing new.
    const version = (await f.get(a)).version;
    await f.controller.tickCoordination();
    expect((await f.get(a)).version).toBe(version);
    expect(source.comments).toHaveLength(1);
  });

  it("when the dependency's PR merges, the held run is claimable on the next claim with no other action", async () => {
    const source = new DepSource();
    const f = await setup(source);
    const dep = await f.item(92, { stage: "REVIEW", pr_number: 192 }, []);
    source.links.set("o/r#1", [{ depends_on: "o/r#92", kind: "sub_issue" }]);
    const a = await f.item(1);
    await f.controller.tickCoordination();
    expect(await f.claim()).toBeNull();
    // The merge lands on the base branch: the dependency closes with its merge sha, and its dependents move.
    const merged: SourceEvent = { kind: "pr_merged", pr_number: 192, head_branch: `factory/${dep}`, merge_sha: "m192", merger: alice };
    await f.controller.handleEvent(merged);
    expect(await f.get(dep)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m192" });
    expect(await f.get(a)).toMatchObject({ blocked_on: "none", blocked_reason: null });
    expect(await f.claim()).toMatchObject({ work_item_id: a, kind: "implement" });
    expect((await f.store.listStateChanges(a)).map((c) => c.reason).slice(-2)).toEqual(["dependency_hold", "dependency_released"]);
  });

  it("an item outside the factory: its state is read from the source on the next pass and written to the store", async () => {
    const source = new DepSource();
    const f = await setup(source);
    source.links.set("o/r#1", [{ depends_on: "other/repo#5", kind: "blocked_by" }]);
    const a = await f.item(1);
    await f.controller.tickCoordination();
    expect((await f.get(a)).blocked_reason).toBe("waiting for other/repo#5 to merge");
    source.states.set("other/repo#5", "merged");
    // Read again only once the last answer is 10 minutes old.
    await f.controller.tickCoordination();
    expect((await f.get(a)).blocked_on).toBe("dependency");
    f.clock.advance(10 * 60_000);
    await f.controller.tickCoordination();
    expect(await f.store.listDependencyEdges({ work_item_id: a })).toMatchObject([{ depends_on: "other/repo#5", state: "merged" }]);
    expect((await f.get(a)).blocked_on).toBe("none");
    expect(await f.claim()).toMatchObject({ work_item_id: a });
  });

  it("a dependency closed without a merge: blocked on a human, the reason names it, no run stays queued", async () => {
    const source = new DepSource();
    const f = await setup(source);
    const dep = await f.item(92, { stage: "REVIEW", pr_number: 192 }, []);
    source.links.set("o/r#1", [{ depends_on: "o/r#92", kind: "depends_on" }]);
    const a = await f.item(1);
    await f.controller.tickCoordination();
    await f.controller.handleEvent({ kind: "pr_closed", pr_number: 192, head_branch: `factory/${dep}` });
    expect(await f.get(a)).toMatchObject({ stage: "RUNNING", blocked_on: "human", blocked_reason: "dependency_closed:#92" });
    expect(await f.queued(a)).toEqual([]);
    expect(await f.claim()).toBeNull();
    const comment = source.comments.find((c) => c.marker === `<!-- factory:dependency-closed:${a}:o/r#92 -->`)!;
    expect(comment.body).toContain("#92, which this item depends on, was closed without a merge");

    // The same for an issue outside the factory closed as not planned.
    source.links.set("o/r#2", [{ depends_on: "o/r#94", kind: "depends_on" }]);
    source.states.set("o/r#94", "closed_unmerged");
    const b = await f.item(2);
    await f.controller.tickCoordination();
    expect(await f.get(b)).toMatchObject({ blocked_on: "human", blocked_reason: "dependency_closed:#94" });
    expect(await f.queued(b)).toEqual([]);
  });

  it("a dependency cycle is refused: blocked on a human, one comment naming the cycle (once, by marker), no run queued", async () => {
    const source = new DepSource();
    const f = await setup(source);
    source.links.set("o/r#10", [{ depends_on: "o/r#11", kind: "depends_on" }]);
    source.links.set("o/r#11", [{ depends_on: "o/r#10", kind: "blocked_by" }]);
    const a = await f.item(10);
    const b = await f.item(11);
    await f.controller.tickCoordination();
    await f.controller.tickCoordination();
    expect(await f.get(a)).toMatchObject({ blocked_on: "human", blocked_reason: "dependency_cycle: #10 → #11 → #10" });
    expect(await f.get(b)).toMatchObject({ blocked_on: "human", blocked_reason: "dependency_cycle: #11 → #10 → #11" });
    for (const id of [a, b]) {
      expect(await f.queued(id)).toEqual([]);
      const comments = source.comments.filter((c) => c.marker === `<!-- factory:dependency-cycle:${id} -->`);
      expect(comments).toHaveLength(1);
    }
    expect(source.comments.find((c) => c.marker === `<!-- factory:dependency-cycle:${a} -->`)!.body).toContain("#10 → #11 → #10");
    expect(await f.claim()).toBeNull();
  });

  it("/approve on a dependency hold does not lift it, and the reply says why", async () => {
    const source = new DepSource();
    const f = await setup(source);
    source.links.set("o/r#1", [{ depends_on: "o/r#92", kind: "depends_on" }]);
    const a = await f.item(1);
    await f.controller.tickCoordination();
    const before = await f.get(a);
    await f.controller.handleEvent({ kind: "spec_approved", source: issue(1).source, comment_id: "501", approver: alice, note: "" });
    expect(await f.get(a)).toEqual(before);
    const reply = source.comments.find((c) => c.marker === "<!-- factory:refused:501 -->")!;
    expect(reply.body).toContain("waiting for a dependency to merge (waiting for #92 to merge)");
    expect(reply.body).toContain("does not lift a dependency hold");
    expect(await f.claim()).toBeNull();
  });
});

describe("coordination-cost holds (design §5, 2026-11-03)", () => {
  async function held() {
    const source = new DepSource();
    const f = await setup(source);
    for (let i = 1; i <= 6; i++) await f.store.recordConflicts({ project: PROJECT_KEY, paths: [WORKER], event_key: `e${i}` });
    const running = await f.item(92, { files_to_change: [WORKER] });
    const waiting = await f.item(7, { files_to_change: [WORKER] });
    expect((await f.claim())?.work_item_id).toBe(running);
    expect(await f.claim()).toBeNull();
    return { ...f, source, running, waiting };
  }

  it("the item's comment shows the hold reason; the status stays implementing and blocked_on none", async () => {
    const f = await held();
    await f.controller.tickCoordination();
    await f.controller.tickCoordination();
    const [run] = await f.queued(f.waiting);
    const comments = f.source.comments.filter((c) => c.marker === `<!-- factory:coordination-hold:${run!.id}:#92 -->`);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(
      "waiting for #92 to merge: both change src/core/worker.ts (conflicted 6 times), cost 4.0 > 2.5",
    );
    expect(comments[0]!.body).toContain("`/approve`");
    const it0 = await f.get(f.waiting);
    expect(it0).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
    expect(statusOf(it0)).toBe("implementing");
  });

  it("/approve on an item held only by cost: recorded with the approver's user ID, and the run is claimed next", async () => {
    const f = await held();
    await f.controller.handleEvent({ kind: "spec_approved", source: issue(7).source, comment_id: "601", approver: alice, note: "" });
    expect(f.source.comments.some((c) => c.marker === "<!-- factory:refused:601 -->")).toBe(false);
    expect((await f.store.listStateChanges(f.waiting)).at(-1)).toMatchObject({
      reason: "coordination_approved",
      actor: { kind: "user", id: "github:1" },
    });
    expect(await f.claim()).toMatchObject({ work_item_id: f.waiting, kind: "implement" });
  });

  it("/approve on an implementing item whose run is not held is refused, naming the state", async () => {
    const source = new DepSource();
    const f = await setup(source);
    await f.item(3);
    await f.controller.handleEvent({ kind: "spec_approved", source: issue(3).source, comment_id: "701", approver: alice, note: "" });
    const reply = source.comments.find((c) => c.marker === "<!-- factory:refused:701 -->")!;
    expect(reply.body).toContain("no implement run is held by coordination cost (the item is implementing)");
  });
});

describe("the file lists the cost reads", () => {
  it("triage stores files_to_change; the implement run stores the PR's file list", async () => {
    const f = await pipeline();
    f.sandbox.changedFiles = [".github/workflows/scope.yml"];
    const a = await f.submit();
    await f.step();
    expect(await f.item(a)).toMatchObject({
      files_to_change: triageSpec.files_to_change,
      pr_files: [".github/workflows/scope.yml"],
      stage: "REVIEW",
    });
  });
});

/** GET answers by exact path (query and page dropped; only page 1 of a list has entries). Records every call. */
class FakeGitHub extends GitHubClient {
  calls: string[] = [];
  answers: Record<string, unknown> = {};
  /** Paths that answer with this HTTP status. */
  errors: Record<string, number> = {};
  constructor() {
    super({} as GitHubCredentials, "http://unused");
  }
  override async request<T>(method: string, path: string): Promise<T> {
    this.calls.push(`${method} ${path}`);
    if (method !== "GET") return {} as T;
    const [bare, query = ""] = path.split("?");
    const status = this.errors[bare!];
    if (status) throw new GitHubError(status, `GitHub GET ${bare} → ${status}`);
    const answer = this.answers[bare!];
    if (Array.isArray(answer) || answer === undefined) return (query.includes("page=1") || !query ? answer ?? [] : []) as T;
    return answer as T;
  }
}

describe("GitHub source: dependency links (fake GitHub client)", () => {
  const source = (client: FakeGitHub) => new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main");

  it("a sub-issue link and a blocked-by link each give the same edge as a Depends on line", async () => {
    const client = new FakeGitHub();
    client.answers["/repos/o/r/issues/1"] = { body: "Depends on: #93" };
    client.answers["/repos/o/r/issues/2"] = { body: "" };
    client.answers["/repos/o/r/issues/2/sub_issues"] = [{ number: 93, repository_url: "https://api.github.com/repos/o/r" }];
    client.answers["/repos/o/r/issues/3"] = { body: null };
    client.answers["/repos/o/r/issues/3/dependencies/blocked_by"] = [{ number: 93 }];
    const gh = source(client);
    const f = await setup(gh);
    const ids = [await f.item(1), await f.item(2), await f.item(3)];
    client.answers["/repos/o/r/issues/93"] = { number: 93, state: "open" };
    await f.controller.tickCoordination();
    const edges = await Promise.all(ids.map((id) => f.store.listDependencyEdges({ work_item_id: id })));
    expect(edges.map((e) => e.map((x) => [x.depends_on, x.kind, x.state]))).toEqual([
      [["o/r#93", "depends_on", "open"]],
      [["o/r#93", "sub_issue", "open"]],
      [["o/r#93", "blocked_by", "open"]],
    ]);
    for (const id of ids) expect(await f.get(id)).toMatchObject({ blocked_on: "dependency", blocked_reason: "waiting for #93 to merge" });
    expect(await f.claim()).toBeNull();
  });

  it("reads the issue, its sub-issues and its blocked-by links, each id once; a list that is off gives nothing", async () => {
    const client = new FakeGitHub();
    client.answers["/repos/o/r/issues/7"] = { body: "Depends on #8, other/repo#2\nDepends on: #7" };
    client.answers["/repos/o/r/issues/7/sub_issues"] = [{ number: 8 }, { number: 9, repository_url: "https://api.github.com/repos/x/y" }];
    client.answers["/repos/o/r/issues/7/dependencies/blocked_by"] = [{ number: 10 }];
    expect(await source(client).dependencyLinks(issue(7).source)).toEqual([
      { depends_on: "o/r#8", kind: "depends_on" },
      { depends_on: "other/repo#2", kind: "depends_on" },
      { depends_on: "x/y#9", kind: "sub_issue" },
      { depends_on: "o/r#10", kind: "blocked_by" },
    ]);
    expect(client.calls.every((c) => c.startsWith("GET "))).toBe(true);

    // Sub-issues or issue dependencies switched off for the repository (404): no links from that list.
    client.errors["/repos/o/r/issues/7/sub_issues"] = 404;
    client.errors["/repos/o/r/issues/7/dependencies/blocked_by"] = 410;
    expect((await source(client).dependencyLinks(issue(7).source)).map((l) => l.kind)).toEqual(["depends_on", "depends_on"]);
    // Any other error is not swallowed.
    client.errors["/repos/o/r/issues/7/sub_issues"] = 500;
    await expect(source(client).dependencyLinks(issue(7).source)).rejects.toThrow(/500/);
  });

  it("the state of an item outside the factory: open, merged (PR merged or issue completed), or closed unmerged", async () => {
    const client = new FakeGitHub();
    client.answers["/repos/o/r/issues/1"] = { number: 1, state: "open" };
    client.answers["/repos/o/r/issues/2"] = { number: 2, state: "closed", state_reason: "completed" };
    client.answers["/repos/o/r/issues/3"] = { number: 3, state: "closed", state_reason: "not_planned" };
    client.answers["/repos/x/y/issues/4"] = { number: 4, state: "closed", pull_request: { merged_at: "2026-11-01T00:00:00Z" } };
    client.answers["/repos/x/y/issues/5"] = { number: 5, state: "closed", pull_request: { merged_at: null } };
    const gh = source(client);
    expect(await Promise.all(["o/r#1", "o/r#2", "o/r#3", "x/y#4", "x/y#5"].map((d) => gh.dependencyState(d)))).toEqual([
      "open", "merged", "closed_unmerged", "merged", "closed_unmerged",
    ]);
  });
});

describe("dependency reads from the forge only when the source changed (design §5, 2026-11-07)", () => {
  const source = (client: FakeGitHub) => new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main");
  /** Ten queued implement items, each depending on #93, an issue outside the factory; delivered once by intake. */
  async function tenQueued() {
    const client = new FakeGitHub();
    for (let n = 1; n <= 10; n++) client.answers[`/repos/o/r/issues/${n}`] = { body: "Depends on: #93" };
    client.answers["/repos/o/r/issues/93"] = { number: 93, state: "open" };
    const f = await setup(source(client));
    const ids: WorkItemId[] = [];
    for (let n = 1; n <= 10; n++) ids.push(await f.item(n));
    return { ...f, client, ids };
  }
  const reads = (client: FakeGitHub) => client.calls.filter((c) => c.startsWith("GET "));

  it("with ten queued items and nothing changed, a second poll makes no forge read; the outside state is read once", async () => {
    const f = await tenQueued();
    // Intake read each issue's links once.
    expect(reads(f.client).filter((c) => /\/issues\/\d+$/.test(c))).toHaveLength(10);
    f.client.calls = [];
    await f.controller.tickCoordination();
    // The stored edges apply: no issue body, sub_issues or blocked_by read; #93's state once for all ten. (The
    // other reads are the hold comments' and status labels' own, made once when each item is held.)
    expect(reads(f.client).filter((c) => /\/issues\/\d+(\/sub_issues|\/dependencies\/blocked_by)?$/.test(c)))
      .toEqual(["GET /repos/o/r/issues/93"]);
    for (const id of f.ids) expect(await f.get(id)).toMatchObject({ blocked_on: "dependency", blocked_reason: "waiting for #93 to merge" });
    f.client.calls = [];
    f.clock.advance(30_000);
    await f.controller.tickCoordination();
    expect(reads(f.client)).toEqual([]);
  });

  it("an edited issue (a new Depends on line) is read on its next delivery, and the next pass applies it", async () => {
    const f = await tenQueued();
    await f.controller.tickCoordination();
    f.client.answers["/repos/o/r/issues/94"] = { number: 94, state: "open" };
    f.client.answers["/repos/o/r/issues/1"] = { body: "Depends on: #93\nDepends on: #94" };
    f.client.calls = [];
    await f.controller.handleEvent({ kind: "item_requested", source: issue(1).source, requester: alice, title: "t", body: "" });
    expect(reads(f.client).filter((c) => /\/issues\/1(\/|$)/.test(c))).toHaveLength(3);
    await f.controller.tickCoordination();
    expect((await f.get(f.ids[0]!)).blocked_reason).toBe("waiting for #93 and #94 to merge");
    expect(reads(f.client).filter((c) => /\/issues\/([2-9]|10)(\/|$)/.test(c))).toEqual([]);
  });

  it("links are read again once 30 minutes old, so a sub-issue added without an issue update is found", async () => {
    const f = await tenQueued();
    await f.controller.tickCoordination();
    f.client.answers["/repos/o/r/issues/1/sub_issues"] = [{ number: 95 }];
    f.client.answers["/repos/o/r/issues/95"] = { number: 95, state: "open" };
    f.clock.advance(29 * 60_000);
    await f.controller.tickCoordination();
    expect((await f.store.listDependencyEdges({ work_item_id: f.ids[0]! })).map((e) => e.depends_on)).toEqual(["o/r#93"]);
    f.clock.advance(2 * 60_000);
    await f.controller.tickCoordination();
    expect((await f.store.listDependencyEdges({ work_item_id: f.ids[0]! })).map((e) => e.depends_on)).toEqual(["o/r#93", "o/r#95"]);
  });

  it("a forge outage stops no coordination: stored edges apply, and the failed read is not retried every poll", async () => {
    const f = await tenQueued();
    for (let n = 1; n <= 95; n++) f.client.errors[`/repos/o/r/issues/${n}`] = 403;
    f.clock.advance(31 * 60_000);
    f.client.calls = [];
    await f.controller.tickCoordination();
    for (const id of f.ids) expect(await f.get(id)).toMatchObject({ blocked_on: "dependency", blocked_reason: "waiting for #93 to merge" });
    expect(reads(f.client).length).toBeGreaterThan(0);
    f.client.calls = [];
    f.clock.advance(30_000);
    await f.controller.tickCoordination();
    expect(reads(f.client)).toEqual([]);
  });
});

/** One conflicted file's index stages: the common ancestor, the work branch (HEAD) and the merged-in base. */
interface Stages {
  ancestor: string;
  branch: string;
  base: string;
}

/**
 * Makes the fake sandbox answer the index, blob and tree reads a mechanical merge or a migration renumbering
 * makes (`ls-files -s`, `cat-file`, `hash-object`, `update-index`, `ls-tree`, the added-steps diff, `mv`).
 * `log` has every command in order, git and not; `index` is the merged text each written path got.
 */
function gitIndex(sandbox: FakeSandbox, o: { stages?: Record<string, Stages>; baseSteps?: string[]; added?: string[]; changed?: string[]; tree?: Record<string, string> }) {
  const blobs = new Map<string, string>();
  const index: Record<string, string> = {};
  const tree: Record<string, string> = { ...o.tree };
  const log: string[] = [];
  const moves: string[] = [];
  const blob = (text: string) => {
    const sha = createHash("sha1").update(text).digest("hex");
    blobs.set(sha, text);
    return sha;
  };
  const ok = (stdout = ""): ExecResult => ({ exit_code: 0, signal: null, stdout, stderr: "", timed_out: false });
  const z = (xs: readonly string[]) => xs.map((x) => `${x}\0`).join("");
  const exec = sandbox.exec.bind(sandbox);
  sandbox.exec = async (h, cmd, opts) => {
    log.push(cmd.join(" "));
    if (cmd[0] !== "git") return exec(h, cmd, opts);
    const a = cmd.slice(1);
    const line = a.join(" ");
    // The sync's merge runs with hooks off (`-c core.hooksPath=…`); it conflicts like any other merge.
    if (/^-c \S+ merge --no-ff /.test(line) && sandbox.mergeExit) return { ...ok(), exit_code: sandbox.mergeExit };
    if (line.startsWith("ls-files -s -z -- ")) {
      const path = a.at(-1)!;
      if (path in index) return ok(`100644 ${blob(index[path]!)} 0\t${path}\0`);
      const st = o.stages?.[path];
      if (st) return ok([[1, st.ancestor], [2, st.branch], [3, st.base]].map(([n, t]) => `100644 ${blob(t as string)} ${n}\t${path}\0`).join(""));
      return ok(path in tree ? `100644 ${blob(tree[path]!)} 0\t${path}\0` : "");
    }
    if (a[0] === "cat-file") return ok(blobs.get(a[2]!) ?? "");
    if (a[0] === "hash-object") return ok(`${blob(opts.stdin ?? "")}\n`);
    if (a[0] === "update-index") {
      const [, sha, path] = a[2]!.split(",");
      index[path!] = blobs.get(sha!)!;
      return ok();
    }
    if (a[0] === "checkout-index") return ok();
    if (line.startsWith("diff --name-only -z --no-renames --diff-filter=A")) return ok(z(o.added ?? []));
    if (a[0] === "diff" && a.length === 6 && a[5] === "HEAD") return ok(z(o.changed ?? []));
    if (a[0] === "ls-tree") return ok(z(o.baseSteps ?? []));
    if (a[0] === "mv") {
      const [from, to] = [a.at(-2)!, a.at(-1)!];
      moves.push(`${from} → ${to}`);
      if (from in tree) {
        tree[to] = tree[from]!;
        delete tree[from];
      }
      return ok();
    }
    return exec(h, cmd, opts);
  };
  return { index, log, moves };
}

/** Only appended lines on both sides: the base adds one History line, the branch another, at the same place. */
const APPENDED: Stages = {
  ancestor: "# Design\n\n## History\n\n- one\n",
  base: "# Design\n\n## History\n\n- one\n- from the base\n",
  branch: "# Design\n\n## History\n\n- one\n- from the branch\n",
};
const MERGED = "# Design\n\n## History\n\n- one\n- from the base\n- from the branch\n";

describe("mechanical merges and migration renumbering (design §5, issue #297)", () => {
  /** An item through triage, implement and review: PR 42 waits for a human merge. */
  async function withPr() {
    const f = await pipeline();
    const it = await f.submit();
    await f.step();
    expect(await f.item(it)).toMatchObject({ stage: "REVIEW", pr_number: 42 });
    f.broker.calls = [];
    const unmergeable = async () => {
      f.source.queue.push({ kind: "pr_unmergeable", pr_number: 42, head_branch: `factory/${it.id}`, head_sha: "h1", base_sha: "b1" });
      await f.controller.tickIntake();
    };
    return { ...f, it, unmergeable };
  }
  const outcome = async (f: Awaited<ReturnType<typeof withPr>>, kind: RunKind) => {
    const o = (await f.runs(f.it, kind)).at(-1)?.outcome;
    return o?.status === "succeeded" ? o.data : o;
  };

  it("an update after a base that took the branch's migration number: the step is renumbered before the tests, they pass, no resolve run", async () => {
    const f = await withPr();
    f.sandbox.ancestorExit = 1; // the base moved on; the merge itself is clean (different step file names)
    const g = gitIndex(f.sandbox, {
      baseSteps: ["migrations/mysql/0024-item-thread.sql", "migrations/mysql/0025-from-base.sql", "migrations/mysql/README.md"],
      added: ["migrations/mysql/0025-mine.sql"],
      changed: ["migrations/mysql/0025-mine.sql", "docs/design/05-coordination.md"],
      tree: {
        "migrations/mysql/0025-mine.sql": "CREATE TABLE IF NOT EXISTS mine (id INT);\n",
        "docs/design/05-coordination.md": "MySQL step `migrations/mysql/0025-mine.sql` adds the table.\n",
      },
    });
    await f.unmergeable();
    await f.step();
    expect(g.moves).toEqual(["migrations/mysql/0025-mine.sql → migrations/mysql/0026-mine.sql"]);
    expect(g.index["docs/design/05-coordination.md"]).toBe("MySQL step `migrations/mysql/0026-mine.sql` adds the table.\n");
    // Renumbered and committed before the check list ran.
    const mv = g.log.findIndex((l) => l.startsWith("git mv "));
    const commit = g.log.findIndex((l, i) => i > mv && / commit --no-verify -m Renumber MySQL steps/.test(l));
    expect(mv).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(mv);
    expect(g.log.indexOf("npm test", commit)).toBeGreaterThan(commit);
    expect(await outcome(f, "update")).toMatchObject({ result: "pushed" });
    expect(f.broker.calls.map((c) => c.name)).toContain("github.push_branch");
    expect(await f.runs(f.it, "resolve")).toEqual([]);
    expect(f.agentCalls("resolve")).toBe(0);
  });

  it("no renumbering when the branch also changes a SQLite schema file", async () => {
    const f = await withPr();
    f.sandbox.ancestorExit = 1;
    const g = gitIndex(f.sandbox, {
      baseSteps: ["migrations/mysql/0025-from-base.sql"],
      added: ["migrations/mysql/0025-mine.sql"],
      changed: ["migrations/mysql/0025-mine.sql", "src/impl/store/sqlite/schema.ts"],
    });
    await f.unmergeable();
    await f.step();
    expect(g.moves).toEqual([]);
    expect(f.log.lines.some((l) => l.msg.startsWith("migration renumbering skipped"))).toBe(true);
  });

  it("an update whose conflict has only appended lines: merged in code, base lines first, no learned weight, no resolve run", async () => {
    const f = await withPr();
    f.sandbox.ancestorExit = 1;
    f.sandbox.mergeExit = 1;
    f.sandbox.conflicts = ["docs/design/05-coordination.md"];
    const g = gitIndex(f.sandbox, { stages: { "docs/design/05-coordination.md": APPENDED } });
    const record = vi.spyOn(f.store, "recordConflicts");
    await f.unmergeable();
    await f.step();
    expect(g.index["docs/design/05-coordination.md"]).toBe(MERGED);
    expect(record).not.toHaveBeenCalled();
    expect(await f.store.conflictCounts(PROJECT_KEY)).toEqual(new Map());
    expect(await outcome(f, "update")).toMatchObject({ result: "pushed" });
    expect(g.log.indexOf("npm test")).toBeGreaterThan(g.log.findIndex((l) => l.startsWith("git update-index")));
    expect(await f.runs(f.it, "resolve")).toEqual([]);
    expect(f.agentCalls("resolve")).toBe(0);
  });

  it("a conflict that changes a line on one side still records the conflict and starts the resolve run", async () => {
    const f = await withPr();
    f.sandbox.ancestorExit = 1;
    f.sandbox.mergeExit = 1;
    f.sandbox.conflicts = ["docs/design.md", "docs/design/05-coordination.md"];
    const g = gitIndex(f.sandbox, {
      stages: {
        "docs/design/05-coordination.md": APPENDED,
        // The branch rewrote a line the base kept: not appended lines only.
        "docs/design.md": { ancestor: "- a\n- b\n", base: "- a\n- b\n- c\n", branch: "- a\n- B\n" },
      },
    });
    await f.unmergeable();
    expect(await f.w1.tick()).toBe(true);
    await f.controller.tickRuns();
    // All or nothing: the appendable file was not written either.
    expect(g.index).toEqual({});
    expect(await outcome(f, "update")).toMatchObject({ result: "conflict" });
    expect((await f.runs(f.it, "resolve")).map((r) => r.status)).toEqual(["queued"]);
    expect((await f.store.conflictCounts(PROJECT_KEY)).get("docs/design.md")).toBe(1);
  });

  it("a resolve run whose conflicts are only appended lines merges them in code: no agent step, the gates run, then the push", async () => {
    const f = await withPr();
    f.sandbox.ancestorExit = 1;
    f.sandbox.mergeExit = 1;
    f.sandbox.conflicts = ["docs/design.md"];
    const stages: Record<string, Stages> = { "docs/design.md": { ancestor: "- a\n", base: "- a\n- b\n", branch: "- A\n" } };
    const g = gitIndex(f.sandbox, { stages });
    await f.unmergeable();
    expect(await f.w1.tick()).toBe(true);
    await f.controller.tickRuns();
    expect((await f.runs(f.it, "resolve")).map((r) => r.status)).toEqual(["queued"]);
    // By the time the resolve run merges, the branch's side only appends too.
    stages["docs/design.md"] = APPENDED;
    f.broker.calls = [];
    const record = vi.spyOn(f.store, "recordConflicts");
    expect(await f.w1.tick()).toBe(true);
    await f.controller.tickRuns();
    expect(g.index["docs/design.md"]).toBe(MERGED);
    expect(f.agentCalls("resolve")).toBe(0);
    expect(await outcome(f, "resolve")).toMatchObject({ result: "pushed", conflicts: ["docs/design.md"] });
    expect(g.log.indexOf("npm test")).toBeGreaterThan(g.log.findIndex((l) => l.startsWith("git update-index")));
    expect(f.broker.calls.map((c) => c.name)).toContain("github.push_branch");
    // Only the update's conflict was recorded; the mechanical resolve recorded none.
    expect(record).not.toHaveBeenCalled();
  });

  it("the implement sync merges appended lines in code; the scope gate and the check list still run before the push", async () => {
    const f = await pipeline();
    f.sandbox.ancestorExit = 1;
    f.sandbox.mergeExit = 1;
    f.sandbox.conflicts = ["docs/design.md"];
    f.sandbox.changedFiles = [".github/workflows/scope.yml", "docs/design.md"];
    const g = gitIndex(f.sandbox, { stages: { "docs/design.md": APPENDED } });
    const it = await f.submit();
    await f.step();
    expect(g.index["docs/design.md"]).toBe(MERGED);
    // One implement step: the conflict got no agent step of its own.
    expect(f.agentCalls("implement")).toBe(1);
    const written = g.log.findIndex((l) => l.startsWith("git update-index"));
    const scope = g.log.findIndex((l, i) => i > written && l.startsWith("git diff --name-only"));
    expect(scope).toBeGreaterThan(written);
    expect(g.log.indexOf("npm test", written)).toBeGreaterThan(written);
    expect(await f.item(it)).toMatchObject({ stage: "REVIEW", pr_number: 42 });
    expect(await f.store.conflictCounts(PROJECT_KEY)).toEqual(new Map());
  });

  it("a tree merged in code with a file outside allowed_paths is still stopped by the scope gate: nothing is pushed", async () => {
    const f = await pipeline();
    f.sandbox.ancestorExit = 1;
    f.sandbox.mergeExit = 1;
    f.sandbox.conflicts = ["docs/design.md"];
    f.sandbox.changedFiles = [".github/workflows/scope.yml", "docs/design.md", "src/outside.ts"];
    gitIndex(f.sandbox, { stages: { "docs/design.md": APPENDED } });
    const it = await f.submit();
    await f.step();
    expect(f.broker.calls.map((c) => c.name)).not.toContain("github.push_branch");
    const [run] = await f.runs(it, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed" });
    expect(JSON.stringify(run!.outcome)).toContain("scope");
  });
});
