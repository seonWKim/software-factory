// Filing an improve report (design §7, issue #308): each group of two or more failed runs becomes one item
// through the first source that can file (local solo, GitHub enterprise), or one comment on the open item filed
// for it before. No live model and no remote service: the worker has no LLM and GitHub is a recording client.

import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { IMPROVER, MAX_FILED_ISSUES, SYSTEM_ITEM, fileReport, issueMarker, patternKey, systemSource } from "../src/core/improver.js";
import { Worker } from "../src/core/worker.js";
import type { ImproveReport, ImproveWindow, RunId, SourceRef, Timestamp, UserId, WorkerId } from "../src/core/types.js";
import type { AgentRunner } from "../src/interfaces/agent-runner.js";
import type { EgressScanner, ScanResult } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SourceAdapter } from "../src/interfaces/source-adapter.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubIssueSource } from "../src/impl/github/github-issue-source.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { issue, newStore, system } from "./helpers/store.js";
import { FakeAuth, FakeBroker, FakeSandbox, MemoryStorage, PROJECT, config, prompts, silent } from "./helpers/fakes.js";
import { RecordingGitHubClient } from "./helpers/github.js";

const noRunner = { run: () => { throw new Error("the improve run called the agent runner"); } } as unknown as AgentRunner;

/** Flags any text with `LEAK` in it as rule `test_leak`; records every scan. */
class RecordingScanner implements EgressScanner {
  scans: { channel: string; content: string }[] = [];
  async scan(channel: Parameters<EgressScanner["scan"]>[0], content: string): Promise<ScanResult> {
    this.scans.push({ channel, content });
    return content.includes("LEAK") ? { clean: false, findings: [{ rule: "test_leak", channel }] } : { clean: true };
  }
}

/** Answers POST /issues with a new issue it then lists; the next POST can be made to fail after filing. */
class IssuesClient extends RecordingGitHubClient {
  issues: { id: number; number: number; body: string }[] = [];
  failAfterFiling = false;
  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (method === "POST" && path === "/repos/o/r/issues") {
      this.calls.push({ method, path, body });
      const n = 100 + this.issues.length;
      const issue = { id: 9000 + n, number: n, body: (body as { body: string }).body };
      this.issues.unshift(issue);
      if (this.failAfterFiling) {
        this.failAfterFiling = false;
        throw new Error("connection reset after the issue was created");
      }
      return issue as T;
    }
    if (method === "GET" && path.startsWith("/repos/o/r/issues?")) {
      this.calls.push({ method, path, body });
      return (path.includes("page=1") ? this.issues : []) as T;
    }
    return super.request<T>(method, path, body);
  }
  posts(): number {
    return this.calls.filter((c) => c.method === "POST" && c.path === "/repos/o/r/issues").length;
  }
}

/** The day the daily window covers: [2026-03-04, 2026-03-05). */
const DAY: ImproveWindow = { window_start: "2026-03-04T00:00:00.000Z" as Timestamp, window_end: "2026-03-05T00:00:00.000Z" as Timestamp };

async function setup(sourcesOf: (store: FactoryStore) => SourceAdapter[]) {
  const clock = new FakeClock("2026-03-04T01:00:00.000Z");
  const { store } = await newStore(clock);
  const storage = new MemoryStorage();
  const scanner = new RecordingScanner();
  const sources = sourcesOf(store);
  const controller = new ControllerRole({ store, sources, auth: new FakeAuth(), clock, config, log: silent, scanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: noRunner, broker: new FakeBroker(), storage,
    clock, config, prompts, log: silent, scanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  let n = 0;
  /** A failed triage run of a new item, finished now (then the clock moves a second). */
  const fail = async (code: string, detail = "same detail"): Promise<RunId> => {
    n++;
    await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
    const run = (await store.claimRun({ worker_id: "seed" as WorkerId, kinds: ["triage"], lease_ms: 60_000 }))!;
    await store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: code, detail, infra: false });
    clock.advance(1_000);
    return run.id;
  };
  const { item: sys } = await store.createWorkItem({
    source: systemSource(PROJECT.key), title: "Factory improve runs", requester_id: IMPROVER.id as UserId, project: PROJECT.key,
    problem: "", resources: [], hold: { blocked_on: "upstream", blocked_reason: SYSTEM_ITEM },
  }, IMPROVER);
  let k = 0;
  /** One improve run over `window`, worked and applied (only it: the failed runs stay unacknowledged). */
  const improve = async (window: ImproveWindow = DAY): Promise<ImproveReport> => {
    const { run } = await store.enqueueRun({ work_item_id: sys.id, kind: "improve", idempotency_key: `improve-test-${++k}`, input: { improve: window } });
    expect(await worker.tick()).toBe(true);
    await controller.applyRun((await store.getRun(run.id))!);
    expect((await store.getRun(run.id))!.acknowledged_at).not.toBeNull();
    return (await store.getImproveReport(run.id))!;
  };
  return { clock, store, scanner, sources, controller, fail, improve };
}

const local = () => setup((store) => [new LocalSource(store)]);
async function github() {
  const client = new IssuesClient();
  return { client, ...(await setup((store) => [new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main", undefined, store)])) };
}

/** The local work items the improver filed. */
async function filedItems(store: FactoryStore) {
  return (await store.listWorkItems(100)).filter((i) => i.source.id.startsWith("local-filed-"));
}

describe("improve filing: solo, the local source", () => {
  it("3 runs of one pattern and 1 unique run file exactly one local item; it links the 3 runs; the unique run is in the report only", async () => {
    const w = await local();
    const group = [await w.fail("checks_failed"), await w.fail("checks_failed"), await w.fail("checks_failed")];
    const unique = await w.fail("agent_timed_out", "once");
    w.clock.set("2026-03-05T06:00:00.000Z");
    const report = await w.improve();

    const items = await filedItems(w.store);
    expect(items).toHaveLength(1);
    const [item] = items;
    for (const id of group) expect(item!.problem).toContain(id);
    expect(item!.problem).not.toContain(unique);
    expect(item!.problem).toContain(issueMarker(patternKey(report.groups[0]!), report.id));
    expect(item).toMatchObject({ stage: "NEW", blocked_on: "none", project: PROJECT.key, requester_id: "system:improver" });
    // A person starts it: no triage run is queued.
    expect(await w.store.listRuns(item!.id)).toEqual([]);

    expect(report.patterns.map((p) => p.run_ids)).toEqual([[unique]]);
    expect(report.patterns[0]!.filing).toBeUndefined();
    expect(report.groups.map((g) => g.filing)).toEqual([{ status: "filed", ref: item!.source }]);
    expect(await w.store.getFiledPattern(PROJECT.key, patternKey(report.groups[0]!))).toMatchObject({ report_id: report.id, filed_ref: item!.source });
  });

  it("a second improve run over the same window files no new item and posts no comment", async () => {
    const w = await local();
    for (let i = 0; i < 3; i++) await w.fail("checks_failed");
    w.clock.set("2026-03-05T06:00:00.000Z");
    const first = await w.improve();
    const second = await w.improve();
    const items = await filedItems(w.store);
    expect(items).toHaveLength(1);
    expect(await w.store.listItemMessages(items[0]!.id)).toEqual([]);
    expect(second.groups.map((g) => g.filing)).toEqual([{ status: "linked", ref: items[0]!.source }]);
    expect(first.groups[0]!.filing).toEqual({ status: "filed", ref: items[0]!.source });
  });

  it("an open filed item gets one comment with the new run IDs only; a run already linked there is not named again", async () => {
    const w = await local();
    const a = await w.fail("checks_failed");
    const b = await w.fail("checks_failed");
    w.clock.set("2026-03-04T12:00:00.000Z");
    const half: ImproveWindow = { window_start: DAY.window_start, window_end: "2026-03-04T12:00:00.000Z" as Timestamp };
    await w.improve(half);
    const c = await w.fail("checks_failed");
    const d = await w.fail("checks_failed");
    w.clock.set("2026-03-05T06:00:00.000Z");
    const report = await w.improve();
    const second = await w.improve();

    const [item] = await filedItems(w.store);
    expect(report.groups[0]!.run_ids).toEqual([a, b, c, d]);
    expect(report.groups[0]!.filing).toEqual({ status: "commented", ref: item!.source, run_ids: [c, d] });
    const messages = await w.store.listItemMessages(item!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toContain(c);
    expect(messages[0]!.body).toContain(d);
    expect(messages[0]!.body).not.toContain(a);
    // The next run over the same window: every run is linked now, so nothing more is posted.
    expect(second.groups[0]!.filing).toEqual({ status: "linked", ref: item!.source });
    expect(await w.store.listItemMessages(item!.id)).toHaveLength(1);
  });

  it(`files at most MAX_FILED_ISSUES (${MAX_FILED_ISSUES}) items per run; the rest are skipped with the cap as reason`, async () => {
    const w = await local();
    const groups = MAX_FILED_ISSUES + 2;
    for (let g = 0; g < groups; g++) for (let i = 0; i < 2; i++) await w.fail(`code_${g}`);
    w.clock.set("2026-03-05T06:00:00.000Z");
    const report = await w.improve();
    expect(await filedItems(w.store)).toHaveLength(MAX_FILED_ISSUES);
    const statuses = report.groups.map((g) => g.filing!.status);
    expect(statuses.slice(0, MAX_FILED_ISSUES).every((s) => s === "filed")).toBe(true);
    expect(report.groups.slice(MAX_FILED_ISSUES).map((g) => g.filing)).toEqual([
      { status: "skipped", reason: "issue_cap" }, { status: "skipped", reason: "issue_cap" },
    ]);
  });

  it("every body passes the egress scan first; a flagged one is not sent and the report keeps only its rules", async () => {
    const w = await local();
    for (let i = 0; i < 2; i++) await w.fail("LEAK_code");
    for (let i = 0; i < 2; i++) await w.fail("checks_failed");
    w.clock.set("2026-03-05T06:00:00.000Z");
    const report = await w.improve();
    const items = await filedItems(w.store);
    expect(items).toHaveLength(1);
    expect(items[0]!.problem).not.toContain("LEAK");
    const leak = report.groups.find((g) => g.error_code === "LEAK_code")!;
    expect(leak.filing).toEqual({ status: "withheld", rules: ["test_leak"] });
    expect(await w.store.getFiledPattern(PROJECT.key, patternKey(leak))).toBeNull();
    // The filed body was scanned on the comment channel before it was sent.
    const sent = report.groups.find((g) => g.error_code === "checks_failed")!;
    expect(w.scanner.scans.some((s) => s.channel === "comment" && s.content.includes(sent.run_ids[0]!))).toBe(true);
  });

  it("a filed item closed in the last 30 days matches: no new item, no comment; closed longer ago, the pattern is filed again", async () => {
    const w = await local();
    for (let i = 0; i < 2; i++) await w.fail("checks_failed");
    w.clock.set("2026-03-05T06:00:00.000Z");
    await w.improve();
    const [item] = await filedItems(w.store);
    await w.store.transition({ id: item!.id, expected_version: item!.version, actor: system, reason: "x", patch: { stage: "CLOSED", close_reason: "completed" } });
    w.clock.set("2026-03-20T06:00:00.000Z");
    expect((await w.improve()).groups[0]!.filing).toEqual({ status: "skipped", reason: "recently_closed" });
    w.clock.set("2026-04-10T06:00:00.000Z");
    const later = await w.improve();
    const items = await filedItems(w.store);
    expect(items).toHaveLength(2);
    const fresh = items.find((i) => i.id !== item!.id)!;
    expect(later.groups[0]!.filing).toEqual({ status: "filed", ref: fresh.source });
    expect(await w.store.getFiledPattern(PROJECT.key, patternKey(later.groups[0]!))).toMatchObject({ report_id: later.id, filed_ref: fresh.source });
  });

  it("with no source that can file, every group is skipped and nothing is claimed", async () => {
    const w = await setup(() => []);
    for (let i = 0; i < 2; i++) await w.fail("checks_failed");
    w.clock.set("2026-03-05T06:00:00.000Z");
    const report = await w.improve();
    expect(report.groups.map((g) => g.filing)).toEqual([{ status: "skipped", reason: "no_source" }]);
    expect((await w.store.listTables()).find((t) => t.name === "controller_filed_patterns")!.rows).toBe(0);
  });
});

describe("improve filing: enterprise, the GitHub source", () => {
  it("files one issue through the source adapter, without the intake label, its marker in the body", async () => {
    const { client, ...w } = await github();
    for (let i = 0; i < 3; i++) await w.fail("checks_failed");
    w.clock.set("2026-03-05T06:00:00.000Z");
    const report = await w.improve();
    expect(client.posts()).toBe(1);
    const post = client.calls.find((c) => c.method === "POST")!.body as { labels?: string[]; body: string };
    expect(post.labels).toBeUndefined();
    expect(post.body).toContain(issueMarker(patternKey(report.groups[0]!), report.id));
    const ref: SourceRef = { type: "github_issue", id: "o/r#100", link: "https://github.com/o/r/issues/100" };
    expect(report.groups[0]!.filing).toEqual({ status: "filed", ref });
  });

  it("a filing that failed part way is retried by the next run: the marker is found and no second issue is filed", async () => {
    const { client, ...w } = await github();
    for (let i = 0; i < 2; i++) await w.fail("checks_failed");
    w.clock.set("2026-03-05T06:00:00.000Z");
    client.failAfterFiling = true;
    const first = await w.improve();
    expect(first.groups[0]!.filing).toEqual({ status: "failed", reason: "error" });
    expect(await w.store.getFiledPattern(PROJECT.key, patternKey(first.groups[0]!))).toMatchObject({ report_id: first.id, filed_ref: null });

    const second = await w.improve();
    expect(client.posts()).toBe(1);
    expect(second.groups[0]!.filing).toMatchObject({ status: "filed", ref: { id: "o/r#100" } });
    expect(await w.store.getFiledPattern(PROJECT.key, patternKey(first.groups[0]!))).toMatchObject({ report_id: first.id, filed_ref: { id: "o/r#100" } });
  });

  it("fileReport run twice on one report files once: the claim is found, then the marker", async () => {
    const { client, ...w } = await github();
    for (let i = 0; i < 2; i++) await w.fail("checks_failed");
    w.clock.set("2026-03-05T06:00:00.000Z");
    const report = await w.improve();
    const source = w.sources[0]!;
    const d = { store: w.store, scanner: w.scanner, clock: w.clock, file: source.fileIssue!.bind(source), comment: async () => {} };
    expect((await fileReport(d, report)).groups).toEqual(report.groups);
    expect(client.posts()).toBe(1);
  });

  it("an open filed issue nobody started gets one comment through the source, once per run", async () => {
    const { client, ...w } = await github();
    await w.fail("checks_failed");
    await w.fail("checks_failed");
    w.clock.set("2026-03-04T12:00:00.000Z");
    await w.improve({ window_start: DAY.window_start, window_end: "2026-03-04T12:00:00.000Z" as Timestamp });
    const c = await w.fail("checks_failed");
    w.clock.set("2026-03-05T06:00:00.000Z");
    const report = await w.improve();
    await w.improve();
    const comments = client.calls.filter((x) => x.method === "POST" && x.path === "/repos/o/r/issues/100/comments");
    expect(comments).toHaveLength(1);
    expect((comments[0]!.body as { body: string }).body).toContain(c);
    expect(report.groups[0]!.filing).toMatchObject({ status: "commented", run_ids: [c] });
    expect(client.posts()).toBe(1);
  });
});