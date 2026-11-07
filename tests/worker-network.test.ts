import { describe, expect, it } from "vitest";
import { GitHubToolBroker } from "../src/impl/broker/github-tool-broker.js";
import type { GitHubClient } from "../src/impl/github/github-client.js";
import { GitHubError } from "../src/impl/github/github-client.js";
import { NETWORK_UNAVAILABLE, classifyNetwork, unreachableHost } from "../src/core/policy.js";
import type { WorkItemId, WorkerId } from "../src/core/types.js";
import { NETWORK_PAUSED_BY } from "../src/core/worker.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import type { ToolCallContext } from "../src/interfaces/tool-broker.js";
import { FakeNetworkProbe, cleanScanner, pipeline } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// Design §5 Restarts, network pause: a git call, push, preflight or model request that cannot reach its host is
// `network_unavailable`. The run goes back to the queue with its attempt unchanged and every claim pauses
// (`network`) until a probe passes; nothing counts toward max_restart or max_attempts.

const TOKEN = "ghs_s3cr3tT0kenValue";
const DNS = `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/o/r.git/': Could not resolve host: github.com`;

/** A pipeline whose next implement run fails its base fetch on DNS, after the item's triage has run. */
async function offline(opts: Parameters<typeof pipeline>[0] = {}) {
  const f = await pipeline(opts);
  const a = await f.submit();
  await f.w1.tick(); // triage
  await f.controller.tickRuns();
  f.sandbox.failGit = ["fetch"];
  f.sandbox.failGitStderr = DNS;
  return { ...f, a };
}

const pauseLines = (f: Awaited<ReturnType<typeof pipeline>>) => f.log.lines.filter((l) => l.msg.startsWith("network unavailable"));

describe("a run that cannot reach its host", () => {
  it("a git fetch failing with 'Could not resolve host' ends queued again, same attempt, and sets the network pause", async () => {
    const f = await offline();
    const startedAt = f.clock.now().getTime();
    expect(await f.w1.tick()).toBe(true);
    const [run, ...more] = await f.runs(f.a, "implement");
    expect(more).toEqual([]);
    expect(run).toMatchObject({ status: "queued", attempt: 1, outcome: null, paused_by: NETWORK_PAUSED_BY, resume: null });
    expect(await f.store.getClaimPause("network")).toBe(new Date(startedAt + 30_000).toISOString());
    expect(await f.store.getClaimPause("network_since")).not.toBeNull();
    // No other pause is set.
    for (const p of ["rate_limit", "forge_auth", "preflight_access", "model_stall"] as const) expect(await f.store.getClaimPause(p)).toBeNull();
    // Nothing for the controller: no outcome, no retry, no restart.
    await f.controller.tickRuns();
    expect(await f.item(f.a)).toMatchObject({ stage: "RUNNING", blocked_on: "none", restart_count: 0 });
    expect(await f.runs(f.a, "implement")).toHaveLength(1);

    // Claimed again once the network is back: the same attempt number, then it completes.
    f.sandbox.failGit = [];
    f.clock.advance(30_000);
    await f.controller.tickModelProbe();
    await f.step();
    const [done] = await f.runs(f.a, "implement");
    expect(done).toMatchObject({ status: "succeeded", attempt: 1 });
  });

  it("an HTTP call (the forge preflight) failing on DNS does the same", async () => {
    const f = await pipeline();
    f.broker.responses["github.preflight"] = [{ ok: false, error_code: NETWORK_UNAVAILABLE, message: "could not reach api.github.com" }];
    const a = await f.submit();
    await f.step();
    const [run] = await f.runs(a, "implement");
    expect(run).toMatchObject({ status: "queued", attempt: 1, outcome: null });
    expect(await f.store.getClaimPause("network")).not.toBeNull();
    expect(pauseLines(f)).toEqual([expect.objectContaining({ level: "warn", fields: expect.objectContaining({ host: "api.github.com" }) })]);
  });

  it("a model request failing on DNS (the runner's network_unavailable error) does the same", async () => {
    let first = true;
    const f = await pipeline({
      implement: () => {
        if (!first) return { output: { summary: "s", next_steps: "n" } };
        first = false;
        return { status: "failed", output: null, error: "network_unavailable: could not reach api.example.com" };
      },
    });
    const a = await f.submit();
    await f.step();
    expect((await f.runs(a, "implement"))[0]).toMatchObject({ status: "queued", attempt: 1, outcome: null });
    expect(pauseLines(f)[0]?.fields).toMatchObject({ host: "api.example.com" });
  });

  it("logs one warn line when the pause starts and one info line when claims resume, naming the host only", async () => {
    const probe = new FakeNetworkProbe([{ ok: false, host: "github.com" }]);
    const f = await offline({ network_probe: probe });
    await f.w1.tick();
    const warn = pauseLines(f);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ level: "warn", fields: { host: "github.com" } });

    f.clock.advance(30_000);
    await f.controller.tickModelProbe(); // fails
    f.clock.advance(30_000);
    await f.controller.tickModelProbe(); // passes
    expect(probe.probes).toBe(2);
    expect(f.log.lines.filter((l) => l.msg === "network reachable again: claims resume")).toEqual([
      expect.objectContaining({ level: "info" }),
    ]);
    expect(f.log.lines.filter((l) => l.level === "warn")).toHaveLength(1);

    // No log line, outcome or stored row carries the credential or git's text.
    const text = JSON.stringify([f.log.lines, await f.store.listRuns(f.a.id), await f.store.listStateChanges(f.a.id)]);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("unable to access");
    expect(text).toContain("github.com");
  });

  it("ten queued runs in one outage: restart_count, attempts and blocked state unchanged for every run afterwards", async () => {
    const probe = new FakeNetworkProbe([{ ok: false, host: "github.com" }, { ok: false, host: "github.com" }]);
    const f = await pipeline({ network_probe: probe });
    const items = [];
    f.sandbox.failGit = ["fetch"];
    f.sandbox.failGitStderr = "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443: Connection refused";
    for (let i = 0; i < 10; i++) items.push(await f.submit());
    // Triage runs first (claim order) and fetches nothing; the first implement run's base fetch then pauses every
    // claim, so the ten implement runs wait in the queue through the outage.
    await f.step();
    for (const it of items) expect((await f.runs(it, "implement")).map((r) => [r.status, r.attempt])).toEqual([["queued", expect.any(Number)]]);
    expect(await f.store.getClaimPause("network")).not.toBeNull();
    // Two failed probes: still paused, nothing claimed.
    for (let i = 0; i < 2; i++) {
      f.clock.advance(300_000);
      await f.controller.tickModelProbe();
      await f.step();
      expect(await f.store.getClaimPause("network")).not.toBeNull();
    }
    f.sandbox.failGit = [];
    f.clock.advance(300_000);
    await f.controller.tickModelProbe();
    expect(probe.probes).toBe(3);
    expect(await f.store.getClaimPause("network")).toBeNull();
    await f.step();

    for (const it of items) {
      expect(await f.item(it)).toMatchObject({ restart_count: 0, blocked_on: "human", blocked_reason: "merge_pending" });
      const runs = await f.runs(it, "implement");
      expect(runs.map((r) => [r.status, r.attempt])).toEqual([["succeeded", 1]]);
    }
    expect(pauseLines(f)).toHaveLength(1);
    // Never a limit, a repeated failure or a last-attempt comment.
    const reasons = (await Promise.all(items.map((it) => f.store.listStateChanges(it.id)))).flat().map((c) => c.reason);
    for (const r of ["max_attempts", "max_restart", "repeated_failure", "run_retry_scheduled"]) expect(reasons).not.toContain(r);
  });
});

describe("network_unavailable classification", () => {
  const cases: [string, string, string, string][] = [
    ["git fetch DNS", "git_failed", "git fetch: fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com", "github.com"],
    ["git fetch connect", "git_failed", "git fetch: fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443 after 3 ms: Couldn't connect to server", "github.com"],
    ["ssh DNS", "git_failed", "ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known", "github.com"],
    ["base fetch DNS", "preflight_failed", `base_fetch: ${DNS}`, "github.com"],
    ["git push DNS", "push_failed", DNS, "github.com"],
    ["git push connect", "push_failed", "fatal: unable to access 'https://github.com/o/r.git/': Connection refused", "github.com"],
    ["preflight getaddrinfo", "preflight_access", "push_access: fetch failed: getaddrinfo ENOTFOUND api.github.com", "api.github.com"],
    ["sandbox step", "exception", "git fetch origin failed: Could not resolve host: github.com", "github.com"],
    ["connect refused", "git_failed", "connect ECONNREFUSED 10.0.0.1:443", "10.0.0.1:443"],
  ];
  it.each(cases)("%s maps to network_unavailable with the host only", (_name, code, detail, host) => {
    expect(classifyNetwork(code, detail)).toEqual({ code: NETWORK_UNAVAILABLE, detail: `could not reach ${host}` });
  });

  const kept: [string, string, string][] = [
    ["a non-fast-forward push", "push_failed", "! [rejected] HEAD -> factory/x (non-fast-forward)"],
    ["a protected branch", "push_failed", "remote: error: GH006: Protected branch update failed"],
    ["a bad ref", "git_failed", "git rev-parse: fatal: ambiguous argument 'nope'"],
    ["a merge failure", "git_failed", "git merge: error: Your local changes would be overwritten"],
    ["a preflight 404", "preflight_access", "push_access: GitHub answered 404"],
    ["a DNS text under another code", "agent_failed", "Could not resolve host: github.com"],
  ];
  it.each(kept)("%s keeps its code", (_name, code, detail) => {
    expect(classifyNetwork(code, detail)).toEqual({ code, detail });
  });

  it("unreachableHost returns the host and never the URL or its credential", () => {
    expect(unreachableHost(DNS)).toBe("github.com");
    expect(unreachableHost("fatal: unable to access 'https://user:pw@git.example.com/r.git/': Connection timed out")).toBe("git.example.com");
    expect(unreachableHost("Temporary failure in name resolution")).toBe("unknown host");
    expect(unreachableHost("fatal: the remote end hung up unexpectedly")).toBeNull();
  });
});

describe("the GitHub preflight in the broker", () => {
  async function brokerThrowing(err: unknown) {
    const { store } = await newStore();
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
    const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
    const client = { request: async () => { throw err; } } as unknown as GitHubClient;
    const broker = new GitHubToolBroker({
      client, credentials: { token: async () => null } as unknown as GitHubCredentials, store, scanner: cleanScanner,
      clock: { now: () => new Date() } as never, repo: { owner: "o", name: "r" }, branchPrefix: "factory/",
    });
    const ctx: ToolCallContext = { run_id: run.id, work_item_id: item.id as WorkItemId, lease_token: run.lease!.token };
    return broker.call(ctx, "github.preflight", { branch: `factory/${item.id}`, base_ref: "main" });
  }

  it("a DNS or connect error from fetch is network_unavailable with the host only", async () => {
    const dns = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" }) });
    expect(await brokerThrowing(dns)).toEqual({ ok: false, error_code: NETWORK_UNAVAILABLE, message: "could not reach api.github.com" });
    const refused = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 140.82.112.6:443") });
    expect(await brokerThrowing(refused)).toMatchObject({ ok: false, error_code: NETWORK_UNAVAILABLE });
  });

  it("any other failure keeps preflight_access", async () => {
    expect(await brokerThrowing(new GitHubError(502, "bad gateway"))).toMatchObject({ ok: false, error_code: "preflight_access" });
    expect(await brokerThrowing(new Error("something else"))).toMatchObject({ ok: false, error_code: "preflight_access" });
  });
});
