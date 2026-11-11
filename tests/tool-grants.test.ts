import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, loadConfig } from "../src/compose.js";
import { type FactoryConfig, GRANT_RUN_KINDS, toolGrantsConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import type { LiveSettings } from "../src/core/settings.js";
import type { WorkerId, WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/worker/index.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { GitHubToolBroker } from "../src/impl/github/github-tool-broker.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ClaudeCodeRunner } from "../src/impl/runner/claude-code-runner.js";
import { type AgentRunner, TOOLS_NOT_EXPOSED } from "../src/interfaces/agent-runner.js";
import type { ToolBroker, ToolCallContext } from "../src/interfaces/tool-broker.js";
import { REGISTRY, type Registry, withPlugin } from "../src/plugins.js";
import {
  FakeAuth, FakeBroker, FakeForge, FakeNoteBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, cleanScanner, config, fakeRepoLookup,
  issueRef, prompts, silent, triageSpec,
} from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

// #164: `tool_grants` in factory.config.json grants read-only broker tools to a run kind. Checked at startup, when
// the broker is built (its tools come from its plugin); absent, every run gets an empty grant list.

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A throwaway repo root with its own config, prompts, state dir and secret file (as in plugins.test.ts). */
function root(over: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-grants-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, store: { type: "sqlite" }, ...over, state_dir: "state", worktrees_dir: "wt" }));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return dir;
}

/** The registry with the note broker selectable as `plugins.broker: "test-notes"`. */
const NOTES: Registry = withPlugin(REGISTRY, "broker", "test-notes", () => new FakeNoteBroker({ a: "note a" }));

/** Loads and builds a config with `tool_grants` (left out when undefined) on the given broker. */
async function startWith(tool_grants: unknown, broker = "test-notes") {
  const over: Record<string, unknown> = { plugins: { ...(REAL.plugins as object), broker } };
  if (tool_grants !== undefined) over.tool_grants = tool_grants;
  const loaded = await loadConfig(root(over), { registry: NOTES });
  return build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup });
}

/** The live config the worker pool reads each run's settings from. */
const workerConfig = (built: Awaited<ReturnType<typeof build>>): FactoryConfig =>
  (built.worker as unknown as { d: { settings: LiveSettings } }).d.settings.config();

describe("tool_grants at startup", () => {
  it("is a known top-level key: a config with it loads", async () => {
    const loaded = await loadConfig(root({ tool_grants: { triage: ["test.read_note"] } }), { registry: NOTES });
    expect(loaded.file.tool_grants).toEqual({ triage: ["test.read_note"] });
  });

  it("starts with a read-only tool granted to triage, and the worker's config carries the grant", async () => {
    const built = await startWith({ triage: ["test.read_note"] });
    try {
      expect(workerConfig(built).tool_grants).toEqual({ triage: ["test.read_note"] });
      // The broker is built before the runner, and the runner gets it with the scanner, so it can expose tools.
      const runner = (built.worker as unknown as { d: { runner: AgentRunner } }).d.runner;
      expect(runner).toBeInstanceOf(ClaudeCodeRunner);
      expect(runner.exposes_tools).toBe(true);
    } finally {
      await built.close();
    }
  });

  it("fails on a tool the broker does not list, naming it and the valid read-only tools", async () => {
    await expect(startWith({ triage: ["test.read_nope"] })).rejects.toThrow(
      /tool_grants\.triage grants "test\.read_nope", which the test-notes broker does not list; valid read-only tools of the test-notes broker: test\.read_note$/m,
    );
  });

  it("fails on a tool that is not read-only, saying so and listing the valid names", async () => {
    await expect(startWith({ review: ["test.write_note"] })).rejects.toThrow(/"test\.write_note", which is not read-only.*valid read-only tools of the test-notes broker: test\.read_note/);
  });

  for (const tool of ["git.store_branch"]) {
    it(`fails on ${tool} with the github broker: not read-only; the valid name is forge.preflight`, async () => {
      const err = await startWith({ implement: [tool] }, "github").then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toContain(`tool_grants.implement grants "${tool}", which is not read-only`);
      expect(err?.message).toContain("valid read-only tools of the github broker: forge.preflight");
    });
  }

  it("fails on github.preflight, the removed old name, naming forge.preflight", async () => {
    await expect(startWith({ implement: ["github.preflight"] }, "github")).rejects.toThrow(
      /tool_grants\.implement grants "github\.preflight", which the github broker does not list; valid read-only tools of the github broker: forge\.preflight/,
    );
  });

  it("fails on a key that is not a run kind, listing the run kinds", async () => {
    await expect(startWith({ triager: ["test.read_note"] })).rejects.toThrow(
      'tool_grants key "triager" is not a run kind; run kinds: triage, implement, review, update, resolve, manual',
    );
  });

  it("with no tool_grants key starts with no grants at all", async () => {
    const built = await startWith(undefined);
    try {
      expect(workerConfig(built).tool_grants).toBeUndefined();
    } finally {
      await built.close();
    }
  });

  it("reports every problem at once, one line each", () => {
    const broker = new FakeNoteBroker();
    expect(() => toolGrantsConfig({ triage: ["x", "test.write_note"], nope: [] }, broker, "test-notes")).toThrow(
      /does not list[\s\S]*\n.*not read-only[\s\S]*\n.*is not a run kind/,
    );
  });

  it("refuses a value that is not a map of lists", () => {
    const broker = new FakeNoteBroker();
    expect(() => toolGrantsConfig(["test.read_note"], broker)).toThrow(/must be an object mapping a run kind/);
    expect(() => toolGrantsConfig({ triage: "test.read_note" }, broker)).toThrow(/tool_grants\.triage must be a list of broker tool names/);
  });

  it("a broker that lists no tools at all can be granted nothing", () => {
    const bare: Pick<ToolBroker, "allTools"> = { allTools: () => [] };
    expect(() => toolGrantsConfig({ triage: ["test.read_note"] }, bare)).toThrow(/valid read-only tools of the configured broker: \(none\)/);
    expect(toolGrantsConfig({}, bare)).toEqual({});
  });

  it("the run kinds are every recorded kind but interactive", () => {
    expect([...GRANT_RUN_KINDS]).toEqual(["triage", "implement", "review", "update", "resolve", "manual"]);
  });
});

describe("the GitHub broker's read_only flags", () => {
  it("only forge.preflight is read-only", () => {
    const broker = new GitHubToolBroker({
      client: {} as never, store: {} as never, scanner: cleanScanner, clock: new FakeClock(), repo: { owner: "o", name: "r" }, branchPrefix: "factory/",
    });
    const flags = Object.fromEntries(broker.allTools().map((t) => [t.name, t.read_only]));
    expect(flags).toEqual({ "git.store_branch": false, "forge.preflight": true });
  });

  it("FakeBroker lists the same flags", () => {
    const flags = Object.fromEntries(new FakeBroker().allTools().map((t) => [t.name, t.read_only]));
    expect(flags).toEqual({ "git.store_branch": false, "forge.preflight": true });
    expect(new FakeBroker().listTools(["forge.preflight"]).map((t) => t.name)).toEqual(["forge.preflight"]);
  });
});

describe("the old github.* tool names", () => {
  /** A broker call context of a claimed run, so the lease check passes and the call reaches the tool switch. */
  async function claimed() {
    const { store } = await newStore(new FakeClock());
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
    const run = (await store.claimRun({ worker_id: "w" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
    const ctx: ToolCallContext = { run_id: run.id, work_item_id: item.id as WorkItemId, lease_token: run.lease!.token };
    return { store, ctx };
  }

  it("each broker answers a github.* name with unknown_tool and calls nothing", async () => {
    const { store, ctx } = await claimed();
    const requests: string[] = [];
    const client = { request: async (method: string, path: string) => requests.push(`${method} ${path}`) } as never;
    const github = new GitHubToolBroker({ client, store, scanner: cleanScanner, clock: new FakeClock(), repo: { owner: "o", name: "r" }, branchPrefix: "factory/" });
    const local = new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: "factory/", repoPath: tmpdir() });
    const args = { branch: "factory/wi_x", base_ref: "main" };
    for (const broker of [github, local]) {
      for (const name of ["github.preflight", "github.push", "github.comment"]) {
        expect(await broker.call(ctx, name, args)).toEqual({ ok: false, error_code: "unknown_tool", message: name });
      }
      expect(broker.allTools().map((t) => t.name).filter((n) => n.startsWith("github."))).toEqual([]);
    }
    expect(requests).toEqual([]);
  });
});

/** One issue through triage → approve → implement → review on fakes, with `cfg`; returns the runner and the store. */
async function flow(cfg: FactoryConfig, runner: AgentRunner & { specs?: unknown[] } = passRunner()) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  // A forge to push and open the PR through outbound (RFC 0015 M7).
  const controller = new ControllerRole({ store, source, forge: new FakeForge(), auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config: cfg, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const src = issueRef(7);
  source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "t", body: "b" });
  await step();
  source.queue.push({ kind: "spec_approved", source: src, comment_id: "100", approver: alice });
  await step();
  const item = (await store.getWorkItemBySource("github_issue", src.id))!;
  return { store, item, runs: await store.listRuns(item.id) };
}

function passRunner(): FakeRunner {
  return new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "ok" } }),
  });
}

/** FakeRunner that says it exposes tools. */
class ExposingRunner extends FakeRunner {
  readonly exposes_tools = true;
}

describe("the worker passes each run kind's grants", () => {
  it("a triage run gets the triage grant; kinds with no entry get an empty list", async () => {
    const runner = new ExposingRunner(passRunner().script);
    await flow({ ...config, tool_grants: { triage: ["test.read_note"] } }, runner);
    const grants = Object.fromEntries(runner.specs.map((s) => [s.role, s.tool_grants]));
    expect(grants).toEqual({ triage: ["test.read_note"], implement: [], review: [] });
  });

  it("with no tool_grants every agent run gets an empty grant list", async () => {
    const runner = passRunner();
    await flow(config, runner);
    expect(runner.specs.map((s) => s.role)).toEqual(["triage", "implement", "review"]);
    for (const s of runner.specs) expect(s.tool_grants, s.role).toEqual([]);
  });

  it("refuses a run with grants when the runner cannot expose tools, naming the tools; the runner is never called", async () => {
    const runner = passRunner(); // no exposes_tools: absent means false
    const { runs } = await flow({ ...config, tool_grants: { triage: ["test.read_note"] } }, runner);
    expect(runner.specs).toEqual([]);
    const triage = runs.find((r) => r.kind === "triage");
    expect(triage?.outcome?.status).toBe("failed");
    if (triage?.outcome?.status !== "failed") throw new Error("expected a failed outcome");
    expect(triage.outcome.error_code).toBe(TOOLS_NOT_EXPOSED);
    expect(triage.outcome.detail).toContain("test.read_note");
  });
});
