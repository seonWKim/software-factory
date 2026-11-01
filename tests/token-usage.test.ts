import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { Read } from "../src/core/tools/index.js";
import type { RunId, RunKind, RunOutcome, RunUsage, WorkItemId, WorkerId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ClaudeCodeRunner } from "../src/impl/runner/claude-code-runner.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecResult, Sandbox } from "../src/interfaces/sandbox.js";
import type { ToolCallContext, ToolResult } from "../src/interfaces/tool-broker.js";
import { NO_FILTERS } from "../src/ui/filters.js";
import { HealthMonitor } from "../src/ui/health.js";
import { renderIndex } from "../src/ui/pages.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage,
  alice, cleanScanner, config as baseConfig, issueRef, prompts, silent, settingsWith, triageSpec,
} from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// Issue #136: every agent call's usage (input, output, cache read, cache write, cost, model) is recorded on
// the run's outcome, failed runs included, and counted in token_cost, the budget and the status page.

// ---------------------------------------------------------------------------------------------------------
// Runner

// A `claude -p --output-format json` result, in the CLI's shape (usage with cache counts, modelUsage per model).
const RECORDED = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 48_210,
  duration_api_ms: 45_002,
  num_turns: 7,
  result: "done",
  session_id: "00000000-0000-0000-0000-000000000000",
  total_cost_usd: 0.4217,
  usage: {
    input_tokens: 21,
    cache_creation_input_tokens: 12_345,
    cache_read_input_tokens: 98_765,
    output_tokens: 1_234,
    server_tool_use: { web_search_requests: 0 },
    service_tier: "standard",
  },
  modelUsage: {
    "claude-haiku-5-5": { inputTokens: 300, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0004 },
    "claude-opus-5-5": { inputTokens: 21, outputTokens: 1_234, cacheReadInputTokens: 98_765, cacheCreationInputTokens: 12_345, costUSD: 0.4213 },
  },
};

function runnerWith(out: Partial<ExecResult>) {
  const sandbox: Sandbox = {
    create: async () => ({ id: "s", workdir: "/w" }),
    updateBase: async () => "base",
    exec: async (): Promise<ExecResult> => ({ exit_code: 0, signal: null, stdout: "", stderr: "", timed_out: false, ...out }),
    copyIn: async () => {},
    copyOut: async () => {},
    destroy: async () => {},
  };
  const homes = `${process.env.TMPDIR ?? "/tmp"}/sf-runner-usage-test`;
  return new ClaudeCodeRunner({
    sandbox,
    secrets: { get: async () => ({ reveal: () => "x" }) as never, valuesForScan: async () => [] },
    claudeConfigDir: `${homes}/cfg`,
    homesDir: homes,
    models: { cheap: "claude-haiku-5-5", strong: "claude-opus-5-5" },
  });
}

const runSpec = (signal = new AbortController().signal): AgentRunSpec => ({
  run_id: "run_u" as RunId,
  work_item_id: "wi_u" as WorkItemId,
  role: "implement",
  sandbox: { id: "s", workdir: "/w" },
  system_prompt: "s",
  prompt: "p",
  tools: [Read],
  tool_grants: [],
  lease_token: 1,
  env_allowlist: {},
  deny_paths: [],
  writable_paths: [],
  model_class: "strong",
  timeout_ms: 1000,
  signal,
});

const RECORDED_USAGE = {
  input_tokens: 21,
  output_tokens: 1_234,
  cache_read_tokens: 98_765,
  cache_write_tokens: 12_345,
  cost_usd: 0.4217,
  model: "claude-opus-5-5",
};
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, model: null };

describe("ClaudeCodeRunner: usage from the CLI's JSON result", () => {
  it("fills the four token counts, the cost and the model from a recorded result", async () => {
    const r = await runnerWith({ stdout: JSON.stringify(RECORDED) }).run(runSpec());
    expect(r.status).toBe("completed");
    expect(r.usage).toEqual(RECORDED_USAGE);
  });

  it("cost is null when the CLI gives none; the model falls back to the only one in modelUsage", async () => {
    const { total_cost_usd: _c, ...noCost } = RECORDED;
    const r = await runnerWith({ stdout: JSON.stringify({ ...noCost, modelUsage: { "claude-opus-5-5": {} } }) }).run(runSpec());
    expect(r.usage).toMatchObject({ cost_usd: null, model: "claude-opus-5-5", cache_read_tokens: 98_765 });
  });

  it("a timed-out run with JSON on stdout still records its usage", async () => {
    const r = await runnerWith({ stdout: JSON.stringify(RECORDED), timed_out: true, exit_code: null, signal: "SIGTERM" }).run(runSpec());
    expect(r.status).toBe("timed_out");
    expect(r.usage).toEqual(RECORDED_USAGE);
  });

  it("an aborted run with JSON on stdout still records its usage", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runnerWith({ stdout: JSON.stringify(RECORDED), exit_code: null, signal: "SIGTERM" }).run(runSpec(ac.signal));
    expect(r.status).toBe("aborted");
    expect(r.usage).toEqual(RECORDED_USAGE);
  });

  it("a failed exit with JSON on stdout records its usage", async () => {
    const r = await runnerWith({ stdout: JSON.stringify({ ...RECORDED, is_error: true, subtype: "error_max_turns" }), exit_code: 1 }).run(runSpec());
    expect(r.status).toBe("failed");
    expect(r.usage).toEqual(RECORDED_USAGE);
  });

  it("no JSON on stdout: zero usage and a null cost, whatever the status", async () => {
    const ac = new AbortController();
    ac.abort();
    for (const [out, signal] of [
      [{ stdout: "partial out", timed_out: true, exit_code: null }, undefined],
      [{ stdout: "", exit_code: null }, ac.signal],
      [{ stdout: "not json", exit_code: 1 }, undefined],
    ] as const) {
      const r = await runnerWith(out).run(runSpec(signal));
      expect(r.status).not.toBe("completed");
      expect(r.usage).toEqual(ZERO_USAGE);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Worker and controller

const usage = (n: number, cost: number | null = null, model = "m"): AgentRunResult["usage"] => ({
  input_tokens: n,
  output_tokens: n,
  cache_read_tokens: n * 10,
  cache_write_tokens: n * 2,
  cost_usd: cost,
  model,
});
/** usage(n)'s full count. */
const full = (n: number) => n * 14;
const done = { summary: "s", next_steps: "n" };

class FailingPrBroker extends FakeBroker {
  override async call(ctx: ToolCallContext, name: string, args: unknown): Promise<ToolResult> {
    if (name === "github.open_pr") {
      this.calls.push({ ctx, name, args });
      return { ok: false, error_code: "forge_error", message: "open_pr failed" };
    }
    return super.call(ctx, name, args);
  }
}

async function factory(opts: {
  implement?: (spec: AgentRunSpec) => Partial<AgentRunResult>;
  broker?: FakeBroker;
  budgets?: Record<number, number>;
  config?: Partial<FactoryConfig>;
}) {
  const config: FactoryConfig = {
    ...baseConfig,
    dials: { spec_gate_min_tier: 3, auto_merge_max_tier: 0 },
    ...(opts.budgets ? { settings: settingsWith({ budgets: opts.budgets }) } : {}),
    ...opts.config,
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec, usage: usage(10, 0.01) }),
    implement: opts.implement ?? (() => ({ output: done, usage: usage(100, 0.5) })),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" }, usage: usage(1) }),
  });
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: opts.broker ?? new FakeBroker(), storage: new MemoryStorage(),
    clock, config, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  const src = issueRef(1);
  const submit = async () => {
    source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
    return (await store.getWorkItemBySource("github_issue", src.id))!;
  };
  return { clock, store, controller, worker, source, submit };
}

describe("worker: usage on every outcome", () => {
  it("a succeeded run stores its usage and data.tokens as the full count", async () => {
    const f = await factory({});
    const it0 = await f.submit();
    const runs = await f.store.listRuns(it0.id);
    const impl = runs.find((r) => r.kind === "implement")!;
    expect(impl.outcome).toMatchObject({ status: "succeeded", data: { tokens: full(100), usage: { ...usage(100, 0.5) } } });
    const triage = runs.find((r) => r.kind === "triage")!;
    expect(triage.outcome).toMatchObject({ status: "succeeded", data: { tokens: full(10) } });
    // token_cost: triage + implement + review, each at its full count.
    expect((await f.store.getWorkItem(it0.id))!.token_cost).toBe(full(10) + full(100) + full(1));
  });

  it("a run that fails after an agent call (opening the PR fails) still stores that call's usage", async () => {
    const f = await factory({ broker: new FailingPrBroker() });
    const it0 = await f.submit();
    const impl = (await f.store.listRuns(it0.id)).filter((r) => r.kind === "implement" && r.outcome !== null);
    expect(impl.length).toBeGreaterThan(0);
    for (const r of impl) {
      expect(r.outcome).toMatchObject({ status: "failed", error_code: "forge_error", usage: { ...usage(100, 0.5) } });
    }
    // Every failed implement attempt is in token_cost.
    expect((await f.store.getWorkItem(it0.id))!.token_cost).toBe(full(10) + impl.length * full(100));
  });

  it("a rate-limited run stores its usage and adds it to token_cost", async () => {
    let first = true;
    const f = await factory({
      implement: () => {
        if (!first) return { output: done, usage: usage(100) };
        first = false;
        return { status: "rate_limited", error: "rate_limited", usage: usage(7, 0.07) };
      },
    });
    const it0 = await f.submit();
    const [limited] = (await f.store.listRuns(it0.id)).filter((r) => r.kind === "implement");
    expect(limited!.outcome).toMatchObject({ status: "failed", error_code: "rate_limited", usage: { ...usage(7, 0.07) } });
    expect((await f.store.getWorkItem(it0.id))!.token_cost).toBe(full(10) + full(7));
  });

  it("a timed-out agent call still records the usage the runner returned", async () => {
    const f = await factory({ implement: () => ({ status: "timed_out", usage: usage(3) }) });
    const it0 = await f.submit();
    const [r] = (await f.store.listRuns(it0.id)).filter((r) => r.kind === "implement");
    expect(r!.outcome).toMatchObject({ status: "failed", error_code: "agent_timed_out", infra: true, usage: { ...usage(3) } });
  });
});

describe("controller: failed runs add their usage once, in the ack transaction", () => {
  it("applying the same failed outcome twice adds it once, and the add lands with the ack", async () => {
    const f = await factory({ broker: new FailingPrBroker() });
    f.source.queue.push({ kind: "item_requested", source: issueRef(1), requester: alice, title: "t", body: "b" });
    await f.controller.tickIntake();
    await f.worker.tick(); // triage
    await f.controller.tickRuns();
    await f.worker.tick(); // implement fails at open_pr
    const [run] = await f.store.listUnacknowledgedRuns(1);
    expect(run).toMatchObject({ kind: "implement", status: "failed" });
    const before = (await f.store.getWorkItem(run!.work_item_id))!.token_cost;

    await f.controller.applyRun(run!);
    await f.controller.applyRun(run!);
    const it1 = (await f.store.getWorkItem(run!.work_item_id))!;
    expect(it1.token_cost).toBe(before + full(100));
    // One state change carries both the ack and the token_cost change.
    const rows = (await f.store.listStateChanges(it1.id)).filter((c) => c.changes.token_cost !== undefined);
    expect(rows.at(-1)!.changes.token_cost).toEqual({ from: before, to: before + full(100) });
    expect((await f.store.listRuns(it1.id)).find((r) => r.id === run!.id)!.acknowledged_at).not.toBeNull();
  });

  it("a failed run's usage is checked against the token budget: its retry is held at a checkpoint", async () => {
    // Triage 140 + the failed implement 1400 is over a 1000 budget: the retry is not queued.
    const f = await factory({ broker: new FailingPrBroker(), budgets: { 2: 1000 } });
    const it0 = await f.submit();
    const it1 = (await f.store.getWorkItem(it0.id))!;
    expect(it1).toMatchObject({ token_cost: full(10) + full(100), blocked_on: "budget", blocked_reason: "budget_checkpoint" });
    expect((await f.store.listRuns(it0.id)).filter((r) => r.kind === "implement")).toHaveLength(1);
    expect((await f.store.listBudgetCheckpoints(it0.id))[0]).toMatchObject({ tokens_spent: full(10) + full(100), held_run_kind: "implement" });
  });
});

// ---------------------------------------------------------------------------------------------------------
// Several agent calls in one run: the sync step's conflict resolution (real git, NoOpSandbox).

const GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "agent", GIT_AUTHOR_EMAIL: "agent@example.com", GIT_COMMITTER_NAME: "agent", GIT_COMMITTER_EMAIL: "agent@example.com",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
function commitFile(repo: string, path: string, content: string, msg: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
  git(repo, "add", "--", path);
  git(repo, "commit", "--quiet", "-m", msg);
}

describe("worker: a run with several agent calls stores the sum", () => {
  it("implement + conflict step: usage is summed, cost summed, model from the last call", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sf-usage-")));
    const origin = join(root, "origin.git");
    const dev = join(root, "dev");
    const repo = join(root, "repo");
    git(root, "init", "--quiet", "--bare", "-b", "main", origin);
    git(root, "clone", "--quiet", origin, dev);
    commitFile(dev, "src/a.txt", "a\n", "add a");
    git(dev, "push", "--quiet", "origin", "main");
    git(root, "clone", "--quiet", origin, repo);
    const cfg: FactoryConfig = {
      ...baseConfig,
      dials: { spec_gate_min_tier: 3, auto_merge_max_tier: 0 },
      repo: { ...baseConfig.repo, path: repo, test_command: ["sh", "-c", "! grep -rq '<<<<<<<' src"] },
    };
    // Not `src/`: the test settings' floor (src/impl/broker/) would raise the tier to 4 and hold the spec.
    const spec = { ...triageSpec, allowed_paths: ["src/a.txt"], files_to_change: ["src/a.txt"], tier: 2 };
    const runner = new FakeRunner({
      triage: () => ({ output: spec, usage: usage(1) }),
      implement: (s) => {
        if (s.prompt.includes("## Merge conflicts")) {
          writeFileSync(join(s.sandbox.workdir, "src/a.txt"), "a merged\n");
          git(s.sandbox.workdir, "add", "--", "src/a.txt");
          return { output: done, usage: { ...usage(20, null, "second"), cost_usd: 0.2 } };
        }
        commitFile(s.sandbox.workdir, "src/a.txt", "a from the implementer\n", "implementer edits a");
        git(dev, "pull", "--quiet", "--ff-only", "origin", "main");
        commitFile(dev, "src/a.txt", "a from main\n", "main edits a");
        git(dev, "push", "--quiet", "origin", "main");
        return { output: done, usage: usage(300, 3, "first") };
      },
      review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" }, usage: usage(1) }),
    });
    const source = new FakeSource();
    const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox: new NoOpSandbox(join(repo, ".worktrees")), runner, broker: new FakeBroker(),
      storage: new MemoryStorage(), clock, config: cfg, prompts: { ...prompts, resolve: "S" }, log: silent, scanner: cleanScanner,
      toolEnv: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" }, awake: new NoKeepAwake(),
    });
    source.queue.push({ kind: "item_requested", source: issueRef(9), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    const item = (await store.getWorkItemBySource("github_issue", issueRef(9).id))!;
    const runs = await store.listRuns(item.id);
    const impl = runs.find((r) => r.kind === "implement")!;
    const sum: RunUsage = {
      input_tokens: 320, output_tokens: 320, cache_read_tokens: 3200, cache_write_tokens: 640, cost_usd: 3.2, model: "second",
    };
    expect(impl.outcome?.status).toBe("succeeded");
    if (impl.outcome?.status !== "succeeded") return;
    expect(impl.outcome.data.usage).toEqual({ ...sum, cost_usd: expect.closeTo(3.2, 10) });
    expect(impl.outcome.data.tokens).toBe(full(320));
  });
});

// ---------------------------------------------------------------------------------------------------------
// Status page

const NOW = "2026-11-08T12:00:00.000Z";

async function seedRun(
  store: Awaited<ReturnType<typeof newStore>>["store"],
  clock: FakeClock,
  n: number,
  kind: RunKind,
  finishedAt: string,
  outcome: RunOutcome,
) {
  const it = (await store.createWorkItem(issue(n), system)).item;
  await store.transition({ id: it.id, expected_version: 1, patch: {}, actor: system, reason: "x", enqueue: { kind, idempotency_key: `k${n}` } });
  clock.set(finishedAt);
  const r = (await store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 }))!;
  await store.completeRun(r.id, r.lease!.token, outcome);
  return it;
}

const ok = (u: RunUsage | null, tokens?: number): RunOutcome => ({
  status: "succeeded",
  summary: "ok",
  data: { tokens: tokens ?? (u ? u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens : 0), ...(u ? { usage: u } : {}) },
});
const failed = (u: RunUsage | undefined): RunOutcome => ({ status: "failed", error_code: "agent_failed", detail: "", infra: false, ...(u ? { usage: u } : {}) });
const u = (n: number, cost: number | null): RunUsage => ({
  input_tokens: n, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: cost, model: "m",
});

function section(body: string, id: string): string {
  const start = body.indexOf(`<section id="${id}">`);
  if (start < 0) throw new Error(`no section ${id}`);
  return body.slice(start, body.indexOf("</section>", start));
}

/** The cost table as rows of cell texts (tags stripped), header row first. */
function costRows(html: string): string[][] {
  return [...section(html, "cost").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => c[1]!.replace(/<[^>]+>/g, "").trim()),
  );
}

async function page(seed: (store: Awaited<ReturnType<typeof newStore>>["store"], clock: FakeClock) => Promise<void>) {
  const clock = new FakeClock("2026-11-01T00:00:00.000Z");
  const { store } = await newStore(clock);
  await seed(store, clock);
  clock.set(NOW);
  const html = await renderIndex(
    { store, scanner: cleanScanner, clock, lease_ms: 60_000, prUrl: () => "", health: new HealthMonitor(async () => [], clock) },
    NO_FILTERS,
  );
  return { html, store };
}

describe("status page: tokens and cost", () => {
  it("24-hour totals count the full tokens of every finished run, failed runs included; old succeeded rows keep data.tokens", async () => {
    const { html } = await page(async (store, clock) => {
      await seedRun(store, clock, 1, "implement", "2026-11-08T10:00:00.000Z", failed({ ...u(1000, 0.1), cache_read_tokens: 500 }));
      await seedRun(store, clock, 2, "triage", "2026-11-08T11:00:00.000Z", ok(u(30, 0.01)));
      // A row from before this change: only data.tokens.
      await seedRun(store, clock, 3, "review", "2026-11-08T11:30:00.000Z", { status: "succeeded", summary: "ok", data: { tokens: 7 } });
      // A failed row from before: no usage, counts 0.
      await seedRun(store, clock, 4, "implement", "2026-11-08T11:40:00.000Z", failed(undefined));
    });
    expect(section(html, "totals")).toMatch(/tokens<\/th><td>1537</);
  });

  it("the cost section: USD per UTC day of finished_at for the last 7 days, one column per run kind, unknown cost not added as zero", async () => {
    const { html } = await page(async (store, clock) => {
      await seedRun(store, clock, 7, "triage", "2026-11-01T23:00:00.000Z", ok(u(1, 9))); // 8th day back: left out
      await seedRun(store, clock, 6, "triage", "2026-11-02T00:00:00.000Z", ok(u(1, 0.125)));
      await seedRun(store, clock, 5, "review", "2026-11-07T10:00:00.000Z", ok(null, 50)); // old row: unknown cost
      await seedRun(store, clock, 4, "review", "2026-11-07T23:59:00.000Z", ok(u(1, 1)));
      await seedRun(store, clock, 1, "implement", "2026-11-08T01:00:00.000Z", ok(u(1, 0.5)));
      await seedRun(store, clock, 2, "implement", "2026-11-08T02:00:00.000Z", failed(u(1, 0.25)));
      await seedRun(store, clock, 3, "triage", "2026-11-08T03:00:00.000Z", ok(u(1, null)));
    });
    const rows = costRows(html);
    expect(rows[0]).toEqual(["day (UTC)", "triage", "implement", "review", "resolve", "update", "total"]);
    const byDay = new Map(rows.slice(1).map((r) => [r[0], r.slice(1)]));
    expect([...byDay.keys()]).toEqual(["2026-11-08", "2026-11-07", "2026-11-06", "2026-11-05", "2026-11-04", "2026-11-03", "2026-11-02"]);
    expect(byDay.get("2026-11-08")).toEqual(["unknown (1 run)", "$0.7500", "", "", "", "$0.7500 + 1 unknown"]);
    expect(byDay.get("2026-11-07")).toEqual(["", "", "$1.0000 + 1 unknown", "", "", "$1.0000 + 1 unknown"]);
    expect(byDay.get("2026-11-02")).toEqual(["$0.1250", "", "", "", "", "$0.1250"]);
    expect(byDay.get("2026-11-05")).toEqual(["", "", "", "", "", ""]);
    expect(section(html, "cost")).not.toContain("9.0000");
  });
});
