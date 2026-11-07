import { describe, expect, it } from "vitest";
import { issueNumber } from "../src/core/change-ref.js";
import type { SourceRef, WorkItem, WorkItemId, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { GitHubToolBroker } from "../src/impl/github/github-tool-broker.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../src/interfaces/sandbox.js";
import type { ToolCallContext } from "../src/interfaces/tool-broker.js";
import { FakeGitHubClient, FakeSandbox, MemoryStorage, alice, cleanScanner, issueRef, pipeline, prompts } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// A local item with GitHub selected (design 05-sources): its gate comments stay in its item thread, so the
// implement run makes no forge comment. A GitHub item keeps its comments on its issue.

/** The GitHub fake: throws on any path with `NaN`, answers the preflight, records every request. */
class NanGuardClient extends FakeGitHubClient {
  requests: string[] = [];
  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.requests.push(`${method} ${path}`);
    if (path.includes("NaN")) throw new Error(`request with NaN: ${method} ${path}`);
    if (method === "GET" && path === "/repos/o/r") return { permissions: { push: true } } as T;
    if (method === "GET" && path.startsWith("/repos/o/r/pulls?")) return [] as T;
    return super.request<T>(method, path, body);
  }
  /** Requests other than the preflight's two reads, which stay with #333 for a local item. */
  forgeWrites(): string[] {
    return this.requests.filter((r) => r !== "GET /repos/o/r" && !r.startsWith("GET /repos/o/r/pulls?"));
  }
}

/** The check commands fail and name a test file, so the base rerun fails it too: `checks_env`. */
class FailingTestsSandbox extends FakeSandbox {
  override async exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "npm" && cmd[1] === "test") {
      this.commands.push(cmd.join(" "));
      return { exit_code: 1, signal: null, stdout: " FAIL  tests/flaky.test.ts > breaks\n", stderr: "", timed_out: false };
    }
    return super.exec(h, cmd, o);
  }
}

/** The sync's merge (hooks off: `-c core.hooksPath=…`) conflicts, as do both resolution steps' retries. */
class ConflictingSandbox extends FakeSandbox {
  override ancestorExit = 1;
  override conflicts = ["src/a.ts"];
  override async exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "git" && /^-c \S+ merge --no-ff /.test(cmd.slice(1).join(" "))) {
      this.gitCalls.push(cmd.slice(1).join(" "));
      return { exit_code: 1, signal: null, stdout: "", stderr: "CONFLICT", timed_out: false };
    }
    return super.exec(h, cmd, o);
  }
}

const LOCAL: SourceRef = { type: "local", id: "task-1", link: "local:task-1" };

/** The pipeline's controller and store, with one worker whose broker is the real GitHub broker over the fake. */
async function withGitHub(source: SourceRef, sandbox: FakeSandbox = new FakeSandbox()) {
  const f = await pipeline();
  const client = new NanGuardClient();
  const broker = new GitHubToolBroker({
    client, credentials: { token: async () => null } as unknown as GitHubCredentials, store: f.store, scanner: cleanScanner,
    clock: f.clock, repo: { owner: "o", name: "r" }, branchPrefix: "factory/",
  });
  const worker = new Worker({
    id: "w-gh" as WorkerId, store: f.store, sandbox, runner: f.runner, broker, storage: new MemoryStorage(),
    clock: f.clock, config: f.config, prompts, log: f.log, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  f.source.queue.push({ kind: "item_requested", source, requester: alice, title: "t", body: "b" });
  await f.controller.tickIntake();
  const item = (await f.store.getWorkItemBySource(source.type, source.id))!;
  const step = async () => {
    while (await worker.tick()) await f.controller.tickRuns();
    await f.controller.tickRuns();
  };
  const implement = async () => {
    await step();
    return (await f.runs(item, "implement"))[0]!;
  };
  return { f, client, sandbox, item, implement };
}

describe("issueNumber", () => {
  const item = (source: SourceRef): Pick<WorkItem, "source"> => ({ source });
  it("is the number of a GitHub issue item's `#<digits>` source id", () => {
    expect(issueNumber(item(issueRef(12)))).toBe(12);
  });
  it("is null for a local item, another source, or an id without a positive number", () => {
    expect(issueNumber(item(LOCAL))).toBeNull();
    expect(issueNumber(item({ type: "local", id: "o/r#3", link: "" }))).toBeNull();
    expect(issueNumber(item({ type: "slack", id: "slack:T1:C1:1700000000.1", link: "" }))).toBeNull();
    for (const id of ["o/r", "o/r#", "o/r#x", "o/r#0", "o/r#1#2", "o/r#12a", "#5", "r#5", "a/b/c#5", `o/r#${"9".repeat(20)}`]) {
      expect(issueNumber(item({ type: "github_issue", id, link: "" }))).toBeNull();
    }
  });
});

describe("a local item's implement run with the GitHub broker selected", () => {
  it("scope violation: the run fails with its own code and makes no GitHub comment request", async () => {
    const g = await withGitHub(LOCAL);
    g.sandbox.changedFiles = ["src/outside.ts"];
    const run = await g.implement();
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "scope_violation" });
    expect(g.client.requests.some((r) => r.includes("NaN"))).toBe(false);
    expect(g.client.forgeWrites()).toEqual([]);
  });

  it("failed checks: checks_failed, and no GitHub comment request", async () => {
    const g = await withGitHub(LOCAL);
    g.sandbox.exits["npm test"] = 1;
    const run = await g.implement();
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "checks_failed" });
    expect(g.client.forgeWrites()).toEqual([]);
  });

  it("checks failing on the base too: checks_env, and no GitHub comment request", async () => {
    const g = await withGitHub(LOCAL, new FailingTestsSandbox());
    const run = await g.implement();
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "checks_env" });
    expect(g.client.forgeWrites()).toEqual([]);
  });

  it("merge conflict: merge_conflict, and no GitHub comment request", async () => {
    const g = await withGitHub(LOCAL, new ConflictingSandbox());
    g.f.runner.script.resolve = () => ({ output: { summary: "resolved", next_steps: "n" } });
    const run = await g.implement();
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "merge_conflict" });
    expect(g.client.forgeWrites()).toEqual([]);
  });
});

describe("a GitHub item's implement run", () => {
  it("still posts its gate comment to its issue, with the marker", async () => {
    const g = await withGitHub(issueRef(7));
    g.sandbox.changedFiles = ["src/outside.ts"];
    const run = await g.implement();
    expect(run.outcome).toMatchObject({ status: "failed", error_code: "scope_violation" });
    const posted = g.client.comments.get(7) ?? [];
    expect(posted.map((c) => c.body)).toEqual([expect.stringContaining(`<!-- factory:scope:${run.id} -->`)]);
    expect(posted[0]!.body).toContain("## Factory scope check: push blocked");
  });
});

describe("github.comment in the broker", () => {
  it("returns a failed result and makes no request when its number is not a positive integer", async () => {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
    const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
    const client = new NanGuardClient();
    const broker = new GitHubToolBroker({
      client, credentials: { token: async () => null } as unknown as GitHubCredentials, store, scanner: cleanScanner,
      clock: { now: () => new Date() } as never, repo: { owner: "o", name: "r" }, branchPrefix: "factory/",
    });
    const ctx: ToolCallContext = { run_id: run.id, work_item_id: item.id as WorkItemId, lease_token: run.lease!.token };
    for (const number of [Number.NaN, null, undefined, 0, -1, 1.5, "3", Number.POSITIVE_INFINITY]) {
      const r = await broker.call(ctx, "github.comment", { number, body: "b", marker: "<!-- m -->" });
      expect(r).toMatchObject({ ok: false, error_code: "invalid_args" });
    }
    expect(client.requests).toEqual([]);
    expect(await broker.call(ctx, "github.comment", { number: 1, body: "b", marker: "<!-- m -->" })).toMatchObject({ ok: true });
    expect(client.requests.some((r) => r.includes("/issues/1/comments"))).toBe(true);
  });
});
