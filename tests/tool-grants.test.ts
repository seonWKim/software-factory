import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, checkToolGrants, loadConfig } from "../src/compose.js";
import { RUN_KINDS, toolGrantsProblems } from "../src/core/config.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { WorkerDeps } from "../src/core/worker.js";
import { ConfigKeyError } from "../src/config-keys.js";
import { GitHubToolBroker } from "../src/impl/broker/github-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { ClaudeCodeRunner } from "../src/impl/runner/claude-code-runner.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { RunId, WorkItemId } from "../src/core/types.js";
import type { SecretStore } from "../src/interfaces/secret-store.js";
import { FAKE_BROKER_TOOLS, FakeBroker, cleanScanner, fakeRepoLookup, pipeline } from "./helpers/fakes.js";

// Granted read-only broker tools (issue #164): the `tool_grants` key, its startup check against the broker's
// tools, the worker passing each role's grants, and runners that cannot expose tools refusing them.

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const WRITE_TOOLS = ["github.push_branch", "github.open_pr", "github.comment"];

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A throwaway repo root with its own config, prompts, state dir and secret file. */
function root(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-grants-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...config, store: { type: "sqlite" }, state_dir: "state", worktrees_dir: "wt" }));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return dir;
}

/** Loads and builds `config` (the checked-in one plus `over`); returns the error if startup fails. */
async function start(over: Record<string, unknown>) {
  const loaded = await loadConfig(root({ ...REAL, ...over }));
  const built = await build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup });
  return built;
}

async function startError(over: Record<string, unknown>): Promise<Error> {
  try {
    const built = await start(over);
    await built.close();
  } catch (err) {
    return err as Error;
  }
  throw new Error("startup did not fail");
}

describe("tool_grants at startup", () => {
  it("the checked-in config grants nothing", () => {
    expect(REAL.tool_grants).toBeUndefined();
  });

  it("is a known top-level key: a config that grants a read-only tool to triage starts", async () => {
    const built = await start({ tool_grants: { triage: ["github.preflight"] } });
    try {
      const w = (built.worker as unknown as { d: WorkerDeps }).d;
      expect(w.config.tool_grants).toEqual({ triage: ["github.preflight"] });
      // The broker is built before the runner, and the runner gets it and the scanner: it exposes tools.
      expect(w.runner.exposes_tools).toBe(true);
      expect((w.runner as unknown as { opts: { broker: unknown; scanner: unknown } }).opts.broker).toBe(w.broker);
      expect((w.runner as unknown as { opts: { broker: unknown; scanner: unknown } }).opts.scanner).toBe(w.scanner);
    } finally {
      await built.close();
    }
  });

  it("no tool_grants key: no grants in the worker's config", async () => {
    const built = await start({});
    try {
      expect((built.worker as unknown as { d: WorkerDeps }).d.config.tool_grants).toBeUndefined();
    } finally {
      await built.close();
    }
  });

  it("a tool the broker does not list fails startup, naming it and listing the valid read-only tools", async () => {
    const err = await startError({ tool_grants: { triage: ["github.read_everything"] } });
    expect(err).toBeInstanceOf(ConfigKeyError);
    expect(err.message).toContain('"github.read_everything"');
    expect(err.message).toContain("valid read-only tools: github.preflight");
  });

  for (const tool of WRITE_TOOLS) {
    it(`granting ${tool} fails startup: it is not read-only`, async () => {
      const err = await startError({ tool_grants: { implement: [tool] } });
      expect(err.message).toContain(`"${tool}" is not read-only`);
      expect(err.message).toContain("valid read-only tools: github.preflight");
    });
  }

  it("a role that is not a run kind fails startup, listing the run kinds", async () => {
    const err = await startError({ tool_grants: { planner: ["github.preflight"] } });
    expect(err.message).toContain('"planner" is not a run kind');
    expect(err.message).toContain("run kinds: triage, implement, review, update, resolve, manual");
  });

  it("every problem is reported, one line each", () => {
    const problems = toolGrantsProblems({ triage: ["nope", "github.comment"], bogus: [] }, FAKE_BROKER_TOOLS);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain("valid read-only tools: github.preflight, test.read_note");
  });

  it("a value that is not a map of lists fails", () => {
    expect(toolGrantsProblems(["github.preflight"], FAKE_BROKER_TOOLS)[0]).toMatch(/must be an object/);
    expect(toolGrantsProblems({ triage: "github.preflight" }, FAKE_BROKER_TOOLS)[0]).toMatch(/must be a list/);
  });

  it("the run kinds are exactly the RunKind values", () => {
    expect(RUN_KINDS).toEqual(["triage", "implement", "review", "update", "resolve", "manual"]);
  });

  it("a broker without a catalog is checked by what it lists for the granted names", () => {
    const inner = new FakeBroker();
    const listOnly = { listTools: (g: readonly string[]) => inner.listTools(g), call: inner.call.bind(inner) };
    expect(checkToolGrants({ review: ["test.read_note"] }, listOnly)).toEqual({ review: ["test.read_note"] });
    expect(() => checkToolGrants({ review: ["nope"] }, listOnly)).toThrow(/no tool "nope"/);
  });
});

describe("the GitHub broker's read_only flags", () => {
  const broker = new GitHubToolBroker({} as ConstructorParameters<typeof GitHubToolBroker>[0]);
  it("marks push_branch, open_pr and comment as not read-only, preflight as read-only", () => {
    const flags = Object.fromEntries(broker.catalog().map((t) => [t.name, t.read_only]));
    expect(flags).toEqual({ "github.push_branch": false, "github.open_pr": false, "github.comment": false, "github.preflight": true });
  });
});

describe("the worker passes each role's grants", () => {
  const grants: Partial<FactoryConfig> = { tool_grants: { triage: ["test.read_note"] } };

  it("a triage run receives its role's tools; other roles get an empty list", async () => {
    const p = await pipeline({ config: grants });
    p.runner.exposes_tools = true;
    await p.submit();
    await p.step();
    const byRole = Object.fromEntries(p.runner.specs.map((s) => [s.role, s.tool_grants]));
    expect(byRole.triage).toEqual(["test.read_note"]);
    expect(byRole.implement).toEqual([]);
    expect(byRole.review).toEqual([]);
  });

  it("no tool_grants: every agent run gets an empty grant list", async () => {
    const p = await pipeline();
    await p.submit();
    await p.step();
    expect(p.runner.specs.length).toBeGreaterThan(0);
    for (const s of p.runner.specs) expect(s.tool_grants).toEqual([]);
  });

  it("a runner that cannot expose tools never gets a run with grants: the run fails naming the tools", async () => {
    const p = await pipeline({ config: grants });
    const it = await p.submit();
    await p.step();
    expect(p.runner.specs.filter((s) => s.role === "triage")).toHaveLength(0);
    const triage = (await p.runs(it, "triage"))[0]!;
    expect(triage.status).toBe("failed");
    expect(JSON.stringify(triage)).toContain("tools_not_exposed");
    expect(JSON.stringify(triage)).toContain("test.read_note");
  });
});

describe("the Claude Code runner without a broker", () => {
  it("refuses a run with grants, naming them, and starts nothing", async () => {
    const exec = vi.fn();
    const sandbox = Object.assign(new NoOpSandbox(join(tmpdir(), "sf-grants-unused")), { exec });
    const runner = new ClaudeCodeRunner({
      sandbox,
      secrets: {} as SecretStore,
      claudeConfigDir: join(tmpdir(), "sf-grants-cfg"),
      homesDir: join(tmpdir(), "sf-grants-homes"),
      models: { cheap: "c", standard: "s", strong: "x" },
    });
    expect(runner.exposes_tools).toBe(false);
    const spec = {
      run_id: "run_g" as RunId,
      work_item_id: "wi_g" as WorkItemId,
      tool_grants: ["github.preflight", "test.read_note"],
    } as unknown as AgentRunSpec;
    const res = await runner.run(spec);
    expect(res.status).toBe("failed");
    expect(res.error).toContain("github.preflight, test.read_note");
    expect(exec).not.toHaveBeenCalled();
  });

  it("with a broker and a scanner it exposes tools", () => {
    const runner = new ClaudeCodeRunner({
      sandbox: new NoOpSandbox(join(tmpdir(), "sf-grants-unused")),
      secrets: {} as SecretStore,
      claudeConfigDir: "/x",
      homesDir: "/y",
      models: { cheap: "c", standard: "s", strong: "x" },
      broker: new FakeBroker(),
      scanner: cleanScanner,
    });
    expect(runner.exposes_tools).toBe(true);
  });
});
