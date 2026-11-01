import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { RunOutcome, WorkItem } from "../src/core/types.js";
import { GitHubToolBroker } from "../src/impl/broker/github-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubClient } from "../src/impl/github/github-client.js";
import { GitHubIssueSource } from "../src/impl/source/github-issue-source.js";
import type { SecretStore } from "../src/interfaces/secret-store.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, issueRef, silent, triageSpec } from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// The spec and failure comment URLs land on the item in the transition that blocks it (design §9).

// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  const intake = async (n = 7): Promise<WorkItem> => {
    source.queue.push({ kind: "item_requested", source: issueRef(n), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    return (await store.getWorkItemBySource("github_issue", issueRef(n).id))!;
  };
  /** Claims the next run of `kind` (waiting out any backoff), completes it with `outcome`, applies it. */
  const finish = async (kind: "triage" | "implement" | "update", outcome: RunOutcome) => {
    clock.advance(DAY);
    const run = await store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 });
    expect(run?.kind).toBe(kind);
    await store.completeRun(run!.id, run!.lease!.token, outcome);
    await controller.tickRuns();
    return run!;
  };
  const get = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  const urlOf = (prefix: string) => source.comments.find((c) => c.marker.startsWith(`<!-- factory:${prefix}`))?.url;
  const change = async (it: WorkItem, reason: string) => (await store.listStateChanges(it.id)).find((c) => c.reason === reason);
  return { clock, store, source, controller, intake, finish, get, urlOf, change };
}

type F = Awaited<ReturnType<typeof setup>>;

const failed = (error_code: string, detail = "it broke"): RunOutcome => ({ status: "failed", error_code, detail, infra: false });

/** Puts an item straight into a state, for runs the controller would not otherwise reach quickly. */
async function seed(f: F, it: WorkItem, patch: Parameters<F["store"]["transition"]>[0]["patch"], enqueue?: { kind: "implement" | "update"; idempotency_key: string }) {
  const cur = await f.get(it);
  const r = await f.store.transition({ id: it.id, expected_version: cur.version, patch, actor: system, reason: "seed", ...(enqueue && { enqueue }) });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

describe("controller: comment links", () => {
  it("stores the spec comment URL in the transition that sets READY with spec_pending", async () => {
    const f = await setup();
    const item = await f.intake();
    await f.finish("triage", { status: "succeeded", summary: "s", data: { spec: triageSpec } });
    const url = f.urlOf("spec:");
    expect(url).toMatch(/^https:\/\/github\.com\/o\/r\/issues\/7#issuecomment-\d+$/);
    expect(await f.get(item)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending", spec_comment_url: url, failure_comment_url: null });
    const triaged = await f.change(item, "triaged");
    expect(triaged!.changes).toMatchObject({
      blocked_reason: { from: null, to: "spec_pending" },
      spec_comment_url: { from: null, to: url },
    });
  });

  it("stores the failure comment URL in the transition that blocks at max_attempts", async () => {
    const f = await setup();
    const item = await f.intake();
    for (let i = 0; i < config.max_attempts; i++) await f.finish("triage", failed("agent_failed"));
    const url = f.urlOf("run-failed:");
    expect(url).toBeDefined();
    expect(await f.get(item)).toMatchObject({ blocked_on: "human", blocked_reason: "max_attempts", failure_comment_url: url });
    expect((await f.change(item, "max_attempts"))!.changes).toMatchObject({ failure_comment_url: { from: null, to: url } });
  });

  it("stores null when the egress scan withholds the failure comment, replacing an older link", async () => {
    const f = await setup();
    const item = await f.intake();
    await seed(f, item, { failure_comment_url: "https://github.com/o/r/issues/7#issuecomment-1" });
    for (let i = 0; i < config.max_attempts; i++) await f.finish("triage", failed("agent_failed", `token ${SECRET} rejected`));
    expect(f.source.comments.filter((c) => c.marker.includes("run-failed"))).toHaveLength(0);
    expect(await f.get(item)).toMatchObject({ blocked_reason: "max_attempts", failure_comment_url: null });
    expect((await f.change(item, "max_attempts"))!.changes).toMatchObject({ failure_comment_url: { to: null } });
  });

  it("stores the failure comment URL of a diff_too_large block", async () => {
    const f = await setup();
    const item = await f.intake();
    await seed(f, item, { stage: "RUNNING" }, { kind: "implement", idempotency_key: "impl" });
    await f.finish("implement", failed("diff_too_large", "3000 lines"));
    const url = f.urlOf("run-failed:");
    expect(url).toBeDefined();
    expect(await f.get(item)).toMatchObject({ blocked_reason: "run_failed:implement:diff_too_large", failure_comment_url: url });
  });

  it("stores the failure comment URL of a failed update run", async () => {
    const f = await setup();
    const item = await f.intake();
    await seed(f, item, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 5 }, { kind: "update", idempotency_key: "upd" });
    await f.finish("update", failed("git_failed"));
    const url = f.urlOf("run-failed:");
    expect(url).toBeDefined();
    expect(await f.get(item)).toMatchObject({ blocked_reason: "run_failed:update:git_failed", failure_comment_url: url });
    expect((await f.change(item, "run_failed"))!.changes).toMatchObject({ failure_comment_url: { from: null, to: url } });
  });

  it("a re-applied decision gets the URL of the comment already posted", async () => {
    const f = await setup();
    const item = await f.intake();
    // The spec comment exists already (e.g. a crash after posting, before the transition).
    const run = await f.store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 });
    await f.source.postComment(item.source, "earlier", `<!-- factory:spec:${run!.id} -->`);
    const earlier = f.source.comments[0]!.url;
    await f.store.completeRun(run!.id, run!.lease!.token, { status: "succeeded", summary: "s", data: { spec: triageSpec } });
    await f.controller.tickRuns();
    expect(f.source.comments).toHaveLength(1);
    expect((await f.get(item)).spec_comment_url).toBe(earlier);
  });
});

/** Answers GETs from `comments`, POSTs with a new comment at `postedUrl`. Records every request. */
class FakeClient extends GitHubClient {
  calls: { method: string; path: string; body: unknown }[] = [];
  comments: { body: string; html_url: string }[] = [];
  postedUrl = "https://github.com/o/r/issues/7#issuecomment-900";

  constructor() {
    super({} as SecretStore, "http://unused");
  }
  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    if (method === "POST") return { id: 900, html_url: this.postedUrl } as T;
    return (path.includes("page=1") ? this.comments : []) as T;
  }
}

describe("GitHub comments return their URL", () => {
  it("commentOnce returns the new comment's URL, and the existing one's when the marker is there", async () => {
    const client = new FakeClient();
    const repo = { owner: "o", name: "r" };
    expect(await client.commentOnce(repo, 7, "hello", "<!-- m -->")).toEqual({ created: true, url: client.postedUrl });
    client.comments = [
      { body: "other", html_url: "https://github.com/o/r/issues/7#issuecomment-1" },
      { body: "hello\n\n<!-- m -->", html_url: "https://github.com/o/r/issues/7#issuecomment-2" },
    ];
    expect(await client.commentOnce(repo, 7, "hello", "<!-- m -->")).toEqual({
      created: false,
      url: "https://github.com/o/r/issues/7#issuecomment-2",
    });
    expect(client.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("GitHubIssueSource.postComment returns the URL, posted or already there", async () => {
    const client = new FakeClient();
    const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main");
    expect(await source.postComment(issueRef(7), "spec", "<!-- factory:spec:1 -->")).toEqual({ url: client.postedUrl });
    client.comments = [{ body: "spec\n\n<!-- factory:spec:1 -->", html_url: "https://github.com/o/r/issues/7#issuecomment-5" }];
    expect(await source.postComment(issueRef(7), "spec", "<!-- factory:spec:1 -->")).toEqual({
      url: "https://github.com/o/r/issues/7#issuecomment-5",
    });
  });

  it("the tool broker's github.comment result carries the url unchanged", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
    const run = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 }))!;
    const client = new FakeClient();
    const broker = new GitHubToolBroker({
      client, store, clock, repo: { owner: "o", name: "r" }, branchPrefix: "factory/",
      secrets: { get: async () => null, valuesForScan: async () => [] },
      scanner: cleanScanner,
    });
    const r = await broker.call({ run_id: run.id, work_item_id: item.id, lease_token: run.lease!.token }, "github.comment", {
      number: 1, body: "x", marker: "m",
    });
    expect(r).toEqual({ ok: true, content: { created: true, url: client.postedUrl } });
  });
});
