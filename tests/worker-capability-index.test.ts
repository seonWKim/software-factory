import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import { Worker } from "../src/core/worker.js";
import type { WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { ListAllCapabilitySearch } from "../src/impl/capability/list-all-capability-search.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { buildClaudeArgs, buildHarnessSettings } from "../src/impl/runner/claude-code-runner.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { Capability, CapabilitySearch } from "../src/interfaces/capability-search.js";
import { newStore } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, config, issueRef, prompts, silent, triageSpec,
} from "./helpers/fakes.js";

const RESULTS: Capability[] = [
  { id: "docs/plugins.md", kind: "doc", name: "Plugins", summary: "Every interface has named plugins." },
  { id: "skills/tdd/SKILL.md", kind: "skill", name: "TDD", summary: "Write the failing test first." },
];

class FakeSearch implements CapabilitySearch {
  queries: { query: string; limit: number }[] = [];
  constructor(private readonly results: Capability[]) {}
  async search(query: string, limit: number): Promise<Capability[]> {
    this.queries.push({ query, limit });
    return this.results.slice(0, limit);
  }
}

/** Drives one issue through triage → approve → implement → review (pass) and returns every agent spec. */
async function flow(capability?: CapabilitySearch): Promise<AgentRunSpec[]> {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "ok" } }),
  });
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config, prompts, log: silent, scanner: new PatternEgressScanner(async () => []), toolEnv: {}, awake: new NoKeepAwake(),
    ...(capability ? { capability } : {}),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  const src = issueRef(5);
  source.queue.push({ kind: "item_requested", source: src, requester: alice, title: "CI gate", body: "please" });
  await step();
  source.queue.push({ kind: "spec_approved", source: src, comment_id: "100", approver: alice });
  await step();
  expect(runner.specs.map((s) => s.role)).toEqual(["triage", "implement", "review"]);
  // Work item ids are random per run; everything else in a prompt is deterministic.
  return runner.specs.map((s) => ({ ...s, prompt: s.prompt.replace(/wi_[0-9a-f]+/g, "wi_X") }));
}

const HEADING = "## Available docs (index)";

describe("worker: capability index in the agent prompt", () => {
  it("appends the index section with every result's path, name and snippet to triage, implement and review", async () => {
    const search = new FakeSearch(RESULTS);
    const specs = await flow(search);
    for (const s of specs) {
      expect(s.prompt, s.role).toContain(HEADING);
      expect(s.prompt).toContain("- `docs/plugins.md`: Plugins. Every interface has named plugins.");
      expect(s.prompt).toContain("- `skills/tdd/SKILL.md`: TDD. Write the failing test first.");
      expect(s.prompt).toMatch(/Read a path for its full text/);
      expect(s.prompt).toMatch(/grants no permission/);
      // Appended: the section is the end of the prompt.
      expect(s.prompt.indexOf(HEADING)).toBeGreaterThan(s.prompt.indexOf("# Work item"));
      expect(s.prompt.trimEnd().endsWith("Write the failing test first.")).toBe(true);
    }
    const review = specs.find((s) => s.role === "review")!;
    expect(review.prompt.indexOf(HEADING)).toBeGreaterThan(review.prompt.indexOf("## Diff"));
  });

  it("queries with the problem for triage, and problem plus done criteria for implement and review, top 8", async () => {
    const search = new FakeSearch(RESULTS);
    await flow(search);
    expect(search.queries.map((q) => q.limit)).toEqual([8, 8, 8]);
    const [triage, implement, review] = search.queries.map((q) => q.query);
    expect(triage).toContain("CI gate");
    expect(triage).not.toContain(triageSpec.done_criteria[0]);
    for (const q of [implement!, review!]) {
      expect(q).toContain(triageSpec.problem);
      expect(q).toContain(triageSpec.done_criteria[0]);
    }
  });

  it("no search injected, list-all (empty) and a search with no results all give today's prompt byte for byte", async () => {
    const today = await flow();
    for (const s of today) expect(s.prompt).not.toContain(HEADING);
    for (const capability of [new ListAllCapabilitySearch([]), new FakeSearch([])]) {
      const specs = await flow(capability);
      expect(specs.map((s) => s.prompt)).toEqual(today.map((s) => s.prompt));
    }
  });

  it("a failing search is logged and leaves the prompt unchanged; the run still succeeds", async () => {
    const today = await flow();
    const broken: CapabilitySearch = {
      search: async () => {
        throw new Error("index broke");
      },
    };
    const specs = await flow(broken);
    expect(specs.map((s) => s.prompt)).toEqual(today.map((s) => s.prompt));
  });

  it("finding a doc changes no permission: tools, harness settings, claude args and grants are the same per role", async () => {
    const without = await flow();
    const withIndex = await flow(new FakeSearch(RESULTS));
    const perms = (s: AgentRunSpec) => ({
      harness_tools: s.harness_tools,
      tool_grants: s.tool_grants,
      deny_paths: s.deny_paths,
      writable_paths: s.writable_paths,
      env_allowlist: s.env_allowlist,
      settings: buildHarnessSettings(s),
      args: buildClaudeArgs(s, "m"),
    });
    expect(withIndex.map(perms)).toEqual(without.map(perms));
    const read = ["Read", "Glob", "Grep"];
    const write = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];
    expect(withIndex.map((s) => s.harness_tools)).toEqual([read, write, write]);
    for (const s of withIndex) expect(s.deny_paths).toEqual(config.deny_paths);
  });
});
