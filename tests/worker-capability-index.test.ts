import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { WRITE_TOOLS, Worker } from "../src/worker/index.js";
import type { WorkerId } from "../src/core/types.js";
import type { WorkerDeps } from "../src/core/worker-deps.js";
import type { Logger } from "../src/core/log.js";
import { Bm25CapabilitySearch } from "../src/impl/capability/bm25-capability-search.js";
import { PackGuidance } from "../src/impl/capability/project-guidance.js";
import { packSkillDirs, type Pack } from "../src/packs/packs.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { ListAllCapabilitySearch } from "../src/impl/capability/list-all-capability-search.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { buildClaudeArgs, buildHarnessSettings } from "../src/impl/runner/claude-code-runner.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { Capability, CapabilitySearch } from "../src/interfaces/capability-search.js";
import { newStore } from "./helpers/store.js";
import {
  FakeForge, FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, config, issueRef, prompts, silent, triageSpec, cleanScanner,
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
async function flow(capability?: CapabilitySearch, extra: Partial<WorkerDeps> = {}): Promise<AgentRunSpec[]> {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "s", next_steps: "n" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "ok" } }),
  });
  const controller = new ControllerRole({ store, source, forge: new FakeForge(), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config, prompts, log: silent, scanner: new PatternEgressScanner(async () => []), toolEnv: {}, awake: new NoKeepAwake(),
    ...(capability ? { capability } : {}),
    ...extra,
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
      tools: s.tools.map((t) => t.name),
      tool_grants: s.tool_grants,
      deny_paths: s.deny_paths,
      writable_paths: s.writable_paths,
      env_allowlist: s.env_allowlist,
      settings: buildHarnessSettings(s),
      // Each run gets its own session id (design §5 Pause); only its place in the arguments is compared.
      args: buildClaudeArgs(s, "m").map((a) => (a === s.session?.id ? "<session>" : a)),
    });
    expect(withIndex.map(perms)).toEqual(without.map(perms));
    const read = ["Read", "Glob", "Grep"];
    const write = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];
    expect(withIndex.map((s) => s.tools.map((t) => t.name))).toEqual([read, write, write]);
    // The triage (read role) spec carries no tool the shared module marks write or exec.
    expect(withIndex[0]!.role).toBe("triage");
    expect(withIndex[0]!.tools.filter((t) => t.capability !== "read")).toEqual([]);
    // The implement spec carries the write set.
    const implement = withIndex.find((s) => s.role === "implement")!;
    expect(implement.tools).toEqual(WRITE_TOOLS);
    for (const s of withIndex) expect(s.deny_paths).toEqual(config.deny_paths);
  });
});

/** A throwaway folder holding `files` (relative path → content). */
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-layer-"));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  return dir;
}

/** A logger that keeps its warnings. */
function recording(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, info: () => {}, warn: (msg) => warnings.push(msg), error: () => {} };
}

/**
 * The resolve run builds its prompt with the same Worker.withIndex as the other three roles
 * (src/worker/runs/resolve/resolve.run.ts); this gives that prompt for a fixed body.
 */
async function resolvePrompt(deps: Partial<WorkerDeps>): Promise<string> {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(), storage: new MemoryStorage(),
    clock, config, prompts, log: silent, scanner: new PatternEgressScanner(async () => []), toolEnv: {}, awake: new NoKeepAwake(), ...deps,
  });
  return worker.withIndex("# Work item\n\nresolve the merge", "CI gate changelog");
}

const SKILL = "---\nname: release-notes\ndescription: Drafts changelog entries for the CI gate.\n---\n\n# Release notes\n\nSteps.\n";
const LEARNINGS = "# Learnings\n\n## Keep gates green\nstatus: active\nRun the CI gate before pushing.\n\n## Old tip\nstatus: retired\nSkip the gate on Fridays.\n";
const GUIDANCE = "## Rules and learnings";

/** A base layer and a fake project layer: a rule and learnings in base, a skill and a rule in the project layer. */
function layers(): { codeRoot: string; packs: Pack[] } {
  const codeRoot = folder({ "rules/style.md": "# Style\n\nShort sentences.\n", "learnings.md": LEARNINGS, "docs/learnings.md": LEARNINGS });
  const project = folder({ "skills/release-notes/SKILL.md": SKILL, "rules/team.md": "# Team rule\n\nOne commit per step.\n" });
  return { codeRoot, packs: [{ layer: "base", dir: codeRoot }, { layer: "project", dir: project }] };
}

describe("worker: pack rules, learnings and skills in the agent prompt", () => {
  it("a pack layer's skill, every rule and unretired learnings reach triage, implement, review and resolve; guidance before the index", async () => {
    const { codeRoot, packs } = layers();
    const deps = { capability: new Bm25CapabilitySearch(codeRoot, packSkillDirs(packs)), guidance: new PackGuidance(packs) };
    const specs = await flow(deps.capability, { guidance: deps.guidance });
    const all = [...specs.map((s) => ({ role: s.role, prompt: s.prompt })), { role: "resolve", prompt: await resolvePrompt(deps) }];
    expect(all.map((p) => p.role)).toEqual(["triage", "implement", "review", "resolve"]);
    const skillLine = `- \`${join(packs[1]!.dir, "skills", "release-notes", "SKILL.md")}\`: release-notes. Drafts changelog entries for the CI gate.`;
    for (const { role, prompt } of all) {
      expect(prompt, role).toContain(skillLine);
      expect(prompt, role).toContain("# Style\n\nShort sentences.");
      expect(prompt, role).toContain("# Team rule\n\nOne commit per step.");
      expect(prompt, role).toContain("Run the CI gate before pushing.");
      // A retired learning is in no prompt and no index result (docs/learnings.md is not indexed).
      expect(prompt, role).not.toContain("Fridays");
      expect(prompt, role).not.toContain("learnings.md`");
      expect(prompt.indexOf(GUIDANCE), role).toBeGreaterThan(prompt.indexOf("# Work item"));
      expect(prompt.indexOf(GUIDANCE), role).toBeLessThan(prompt.indexOf(HEADING));
    }
  });

  it("no skills, rules or learnings in any layer: every prompt is byte-identical to one without guidance", async () => {
    const empty: Pack[] = [{ layer: "base", dir: folder({ "README.md": "x" }) }, { layer: "project", dir: folder({}) }];
    const today = await flow();
    const specs = await flow(new Bm25CapabilitySearch(empty[0]!.dir, packSkillDirs(empty)), { guidance: new PackGuidance(empty) });
    expect(specs.map((s) => s.prompt)).toEqual(today.map((s) => s.prompt));
    expect(await resolvePrompt({ guidance: new PackGuidance(empty) })).toBe(await resolvePrompt({}));
  });

  it("a failed read of rules or learnings logs a warning; the prompt is as without them and the run goes on", async () => {
    const log = recording();
    const today = await flow(new FakeSearch(RESULTS));
    const broken = { read: async () => Promise.reject(new Error("EACCES")) };
    const specs = await flow(new FakeSearch(RESULTS), { guidance: broken, log });
    expect(specs.map((s) => s.prompt)).toEqual(today.map((s) => s.prompt));
    expect(log.warnings.filter((w) => w.includes("rules and learnings could not be read"))).toHaveLength(3);
  });

  it("text past the cap is dropped with a warning", async () => {
    const log = recording();
    const dir = folder({ "rules/big.md": "x".repeat(9000) });
    const specs = await flow(undefined, { guidance: new PackGuidance([{ layer: "base", dir }]), log });
    for (const s of specs) {
      expect(s.prompt).toContain("x".repeat(8000));
      expect(s.prompt).not.toContain("x".repeat(8001));
    }
    expect(log.warnings.some((w) => w.includes("over their cap"))).toBe(true);
  });
});
