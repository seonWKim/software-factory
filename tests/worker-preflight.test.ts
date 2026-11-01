import { describe, expect, it } from "vitest";
import type { WorkItemId, WorkerId } from "../src/core/types.js";
import { GitHubToolBroker } from "../src/impl/broker/github-tool-broker.js";
import { GitHubError, type GitHubClient } from "../src/impl/github/github-client.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import type { ToolCallContext } from "../src/interfaces/tool-broker.js";
import { cleanScanner, pipeline } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// The implement preflight (design §5 Restarts): push access, the PR API and the base fetch are checked before
// the agent starts, so a run that cannot push spends no agent run.

describe("implement preflight in the worker", () => {
  it("no push permission: the run fails before the agent starts and the runner is never called", async () => {
    const f = await pipeline();
    f.broker.responses["github.preflight"] = [{ ok: false, error_code: "preflight_failed", message: "push_access: no push permission on o/r" }];
    const it0 = await f.submit();
    await f.step();
    const [run] = await f.runs(it0, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "preflight_failed", infra: false });
    expect(run!.outcome!.status === "failed" && run!.outcome!.detail).toContain("push_access");
    expect(f.agentCalls("implement")).toBe(0);
    expect(f.broker.calls.some((c) => c.name === "github.push_branch" || c.name === "github.open_pr")).toBe(false);
    expect(f.sandbox.destroyed).toBe(f.sandbox.created.length);
  });

  it("asks the broker about the item's branch and base before the agent, then fetches the base", async () => {
    const f = await pipeline();
    let atAgent: { broker: string[]; git: string[] } | null = null;
    f.runner.script.implement = () => {
      atAgent = { broker: [...f.broker.preflights, ...f.broker.calls].map((c) => c.name), git: [...f.sandbox.gitCalls] };
      return { output: { summary: "s", next_steps: "n" } };
    };
    const it0 = await f.submit();
    await f.step();
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW" });
    expect(atAgent!.broker).toEqual(["github.preflight"]);
    const pre = f.broker.preflights[0]!;
    expect(f.broker.preflights).toHaveLength(1);
    expect(pre.args).toEqual({ branch: `factory/${it0.id}`, base_ref: "main" });
    expect(atAgent!.git.some((c) => c.startsWith("fetch --quiet --no-tags /repo +refs/remotes/origin/main:refs/remotes/origin/main"))).toBe(true);
  });

  it("a failed PR API check names the check", async () => {
    const f = await pipeline();
    f.broker.responses["github.preflight"] = [{ ok: false, error_code: "preflight_failed", message: "pr_api: GitHub GET → 500" }];
    const it0 = await f.submit();
    await f.step();
    const [run] = await f.runs(it0, "implement");
    expect(run!.outcome).toMatchObject({ error_code: "preflight_failed", detail: expect.stringContaining("pr_api") });
    expect(f.agentCalls("implement")).toBe(0);
  });

  it("a failed base fetch names the check and makes no agent call", async () => {
    const f = await pipeline();
    const it0 = await f.submit();
    f.sandbox.failGit = ["fetch"];
    await f.step();
    const [run] = await f.runs(it0, "implement");
    expect(run!.outcome).toMatchObject({ status: "failed", error_code: "preflight_failed", detail: expect.stringContaining("base_fetch") });
    expect(f.agentCalls("implement")).toBe(0);
  });

  it("a preflight failure is a task failure: retried with backoff and bounded by max_attempts", async () => {
    const f = await pipeline();
    const fail = { ok: false as const, error_code: "preflight_failed", message: "push_access: no" };
    f.broker.responses["github.preflight"] = [fail, fail, fail, fail];
    const it0 = await f.submit();
    for (let i = 0; i < 4; i++) {
      await f.step();
      f.clock.advance(f.config.retry_max_ms);
    }
    expect(await f.item(it0)).toMatchObject({ blocked_on: "human", blocked_reason: "max_attempts", restart_count: 0 });
    expect(await f.runs(it0, "implement")).toHaveLength(3);
    expect(f.agentCalls("implement")).toBe(0);
  });
});

/** The broker over a fake GitHub client, with a real store so the lease check passes. */
async function brokerFor(answer: (method: string, path: string) => unknown) {
  const { store } = await newStore();
  const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
  const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
  const requests: string[] = [];
  const client = {
    async request(method: string, path: string) {
      requests.push(`${method} ${path}`);
      return answer(method, path);
    },
  } as unknown as GitHubClient;
  const credentials = { token: async () => null } as unknown as GitHubCredentials;
  const broker = new GitHubToolBroker({
    client, credentials, store, scanner: cleanScanner, clock: { now: () => new Date() } as never,
    repo: { owner: "o", name: "r" }, branchPrefix: "factory/",
  });
  const ctx: ToolCallContext = { run_id: run.id, work_item_id: item.id as WorkItemId, lease_token: run.lease!.token };
  const preflight = () => broker.call(ctx, "github.preflight", { branch: `factory/${item.id}`, base_ref: "main" });
  return { broker, ctx, requests, preflight, item };
}

describe("github.preflight in the broker", () => {
  it("is read-only: one GET of the repo and one GET of the PR list, nothing written", async () => {
    const b = await brokerFor((_m, path) => (path.includes("/pulls") ? [] : { permissions: { push: true } }));
    expect(await b.preflight()).toMatchObject({ ok: true });
    expect(b.requests).toEqual([
      "GET /repos/o/r",
      `GET /repos/o/r/pulls?state=open&head=${encodeURIComponent(`o:factory/${b.item.id}`)}&per_page=1`,
    ]);
  });

  it("is listed as a tool with a schema", async () => {
    const b = await brokerFor(() => ({}));
    expect(b.broker.listTools(["github.preflight"]).map((t) => t.name)).toEqual(["github.preflight"]);
  });

  it("no push permission fails push_access", async () => {
    const b = await brokerFor((_m, path) => (path.includes("/pulls") ? [] : { permissions: { push: false, pull: true } }));
    const r = await b.preflight();
    expect(r).toMatchObject({ ok: false, error_code: "preflight_failed" });
    expect(!r.ok && r.message).toMatch(/^push_access: /);
  });

  it("a failing PR list fails pr_api", async () => {
    const b = await brokerFor((_m, path) => {
      if (path.includes("/pulls")) throw new GitHubError(502, "GitHub GET /pulls → 502 bad gateway");
      return { permissions: { push: true } };
    });
    const r = await b.preflight();
    expect(r).toMatchObject({ ok: false, error_code: "preflight_failed" });
    expect(!r.ok && r.message).toMatch(/^pr_api: /);
  });

  it("a 401 or 403 is forge_auth and names the check", async () => {
    for (const status of [401, 403]) {
      const b = await brokerFor(() => {
        throw new GitHubError(status, `GitHub GET /repos/o/r → ${status} Bad credentials`);
      });
      const r = await b.preflight();
      expect(r).toMatchObject({ ok: false, error_code: "forge_auth" });
      expect(!r.ok && r.message).toMatch(/^push_access: /);
    }
  });

  it("only factory branches", async () => {
    const b = await brokerFor(() => []);
    expect(await b.broker.call(b.ctx, "github.preflight", { branch: "main", base_ref: "main" })).toMatchObject({
      ok: false, error_code: "branch_not_allowed",
    });
    expect(b.requests).toEqual([]);
  });
});
