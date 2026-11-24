// Clean skill-eval replays (design 06-measurement): each replay runs in a new sandbox cleaned of every CLAUDE.md,
// AGENTS.md, `.claude/` and other skill folder, with the skill under test in `.claude/skills/<name>/` and the case's
// seed folder; it gets the tools its skill's `tools:` front matter names and the MCP servers its case names; under the
// noop sandbox a replay with tools is refused before any sandbox is made; and its transcript, answer, usage, cost and
// wall time are stored, a flagged transcript or answer as null with the rule names only. The sandbox is a fake over a
// temporary folder (its clean-up commands run there) and the runner a fake: no test calls a model.

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import type { AgentRunResult } from "../src/interfaces/agent-runner.js";
import type { ExecOptions, ExecResult, SandboxHandle, SandboxSpec } from "../src/interfaces/sandbox.js";
import { frontMatterTools } from "../src/runtime/capabilities/capabilities.js";
import { type SkillJudgeFn, runSkillEval, skillEvalReplay } from "../src/runtime/index.js";
import type { SkillReplayOptions } from "../src/runtime/skill-evals/engine.js";
import type { ToolSpec } from "../src/core/tools/types.js";
import { FakeRunner } from "./helpers/fakes/runner.js";
import { newStore } from "./helpers/store.js";

const OWNER = "local:owner" as UserId;
const SKILL_TEXT = "---\nname: tests-first\n---\nWrite the test first.\n";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "skill-eval-clean-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Every file under `dir`, relative and sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
}

/**
 * A fake sandbox whose run folders are copies of the repo in temporary folders: its commands and copies run there.
 * It records what was created, copied and destroyed, as FakeSandbox does.
 */
class FolderSandbox {
  created: SandboxSpec[] = [];
  copies: { from: string; to: string }[] = [];
  destroyedIds: string[] = [];
  constructor(private readonly repo: string) {}
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec);
    const id = `sbx${this.created.length}`;
    const workdir = join(tmp, "runs", id);
    await cp(this.repo, workdir, { recursive: true });
    return { id, workdir };
  }
  async exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: h.workdir, env: { ...o.env }, input: o.stdin ?? "", encoding: "utf8" });
    return { exit_code: r.status, signal: null, stdout: r.stdout, stderr: r.stderr, timed_out: false };
  }
  async copyIn(h: SandboxHandle, hostPath: string, sandboxPath: string): Promise<void> {
    this.copies.push({ from: hostPath, to: sandboxPath });
    await cp(hostPath, join(h.workdir, sandboxPath), { recursive: true });
  }
  async destroy(h: SandboxHandle): Promise<void> {
    this.destroyedIds.push(h.id);
  }
}

/** A checkout with agent instructions, a `.claude/` folder and other skills, a skill folder and a seed folder on the host. */
async function fixture() {
  const repo = join(tmp, "repo");
  const files: Record<string, string> = {
    "CLAUDE.md": "root rules", "AGENTS.md": "root agents", "src/keep.ts": "export {};", "src/CLAUDE.md": "nested rules",
    "docs/deep/AGENTS.md": "deep agents", ".claude/settings.json": "{}", ".claude/skills/other/SKILL.md": "other",
    "skills/another/SKILL.md": "another", "skills/another/helper.md": "x", ".agents/skills/third/SKILL.md": "third",
  };
  for (const [f, text] of Object.entries(files)) {
    await mkdir(join(repo, f, ".."), { recursive: true });
    await writeFile(join(repo, f), text);
  }
  const skill = join(tmp, "host", "skills", "tests-first");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "the folder's own text");
  await writeFile(join(skill, "reference.md"), "ref");
  await mkdir(join(tmp, "seeds", "one", "fixtures"), { recursive: true });
  await writeFile(join(tmp, "seeds", "one", "fixtures", "data.txt"), "seeded");
  return { repo, skill };
}

/** The replay options over the fixture: the skill under test, the sandbox plugin, the broker's tools and MCP servers. */
function options(skill: string, o: Partial<SkillReplayOptions<ToolSpec>> = {}): SkillReplayOptions<ToolSpec> {
  return {
    repo: { path: join(tmp, "repo"), base_branch: "main" }, role: "implement", system_prompt: SKILL_TEXT, env_allowlist: {}, deny_paths: [],
    model_class: "standard", timeout_ms: 1000, skill: { folder: skill, name: "tests-first" }, sandbox_plugin: "local", root: tmp, ...o,
  };
}

/** A runner that lists the run folder's files when the agent starts. */
function listingRunner(seen: string[][], result: Partial<AgentRunResult> = {}) {
  return new FakeRunner({
    implement: async (spec) => {
      seen.push(await filesUnder(spec.sandbox.workdir));
      return { output: "the answer", transcript: "the transcript", ...result };
    },
  });
}

const signal = () => new AbortController().signal;

describe("the clean sandbox of a skill-eval replay", () => {
  it("removes every CLAUDE.md and AGENTS.md, .claude/ and other skill folders, in a new sandbox per replay, before the agent starts", async () => {
    const { repo, skill } = await fixture();
    const sandbox = new FolderSandbox(repo);
    const seen: string[][] = [];
    const replay = skillEvalReplay({ sandbox, runner: listingRunner(seen) }, options(skill));

    await replay({ run_id: "r1", case_id: "c1", input: "one" }, signal());
    await replay({ run_id: "r1", case_id: "c2", input: "two" }, signal());

    expect(sandbox.created).toHaveLength(2);
    expect(sandbox.destroyedIds).toEqual(["sbx1", "sbx2"]);
    for (const files of seen) {
      expect(files.filter((f) => /(^|\/)(CLAUDE|AGENTS)\.md$/.test(f))).toEqual([]);
      expect(files.filter((f) => f.startsWith(".agents/") || f.startsWith("skills/"))).toEqual([]);
      expect(files.filter((f) => f.startsWith(".claude/"))).toEqual([".claude/skills/tests-first/SKILL.md", ".claude/skills/tests-first/reference.md"]);
      expect(files).toContain("src/keep.ts");
    }
  });

  it("copies the skill under test to .claude/skills/<name>/ with the SKILL.md text under test, and the case's seed folder when it names one", async () => {
    const { repo, skill } = await fixture();
    const sandbox = new FolderSandbox(repo);
    const seen: string[][] = [];
    let skillText = "";
    const runner = new FakeRunner({
      implement: async (spec) => {
        seen.push(await filesUnder(spec.sandbox.workdir));
        skillText = await readFile(join(spec.sandbox.workdir, ".claude/skills/tests-first/SKILL.md"), "utf8");
        return { output: "ok" };
      },
    });
    const replay = skillEvalReplay({ sandbox, runner }, options(skill));

    await replay({ run_id: "r1", case_id: "c1", input: "x", seed: "seeds/one" }, signal());
    await replay({ run_id: "r1", case_id: "c2", input: "x" }, signal());

    expect(skillText).toBe(SKILL_TEXT);
    expect(sandbox.copies).toEqual([
      { from: skill, to: ".claude/skills/tests-first" }, { from: join(tmp, "seeds", "one"), to: "." },
      { from: skill, to: ".claude/skills/tests-first" },
    ]);
    expect(seen[0]).toContain("fixtures/data.txt");
    expect(seen[1]).not.toContain("fixtures/data.txt");
  });
});

describe("the tools and MCP servers of a skill-eval replay", () => {
  it("reads the tools: front matter as a comma, flow or block list; none when absent", () => {
    expect(frontMatterTools("---\nname: x\ntools: a.b, c\n---\nbody")).toEqual(["a.b", "c"]);
    expect(frontMatterTools('---\ntools: [a, "b"]\n---\n')).toEqual(["a", "b"]);
    expect(frontMatterTools("---\ntools:\n  - a\n  - b\nname: x\n---\n")).toEqual(["a", "b"]);
    expect(frontMatterTools("---\nname: x\n---\ntools: a\n")).toEqual([]);
    expect(frontMatterTools("no front matter")).toEqual([]);
  });

  it("grants the tools the skill names and gives MCP servers only when the case names them", async () => {
    const { repo, skill } = await fixture();
    const runner = listingRunner([]);
    const asked: string[][] = [];
    const replay = skillEvalReplay({ sandbox: new FolderSandbox(repo), runner }, options(skill, {
      system_prompt: "---\nname: tests-first\ntools: forge.preflight\n---\nGo.\n",
      broker_tools: [{ name: "forge.preflight", read_only: true }, { name: "git.store_branch", read_only: false }],
      mcpServers: async (names) => {
        asked.push([...names]);
        return names.map((name) => ({ name, command: "serve", args: [] }));
      },
    }));

    await replay({ run_id: "r1", case_id: "c1", input: "x" }, signal());
    await replay({ run_id: "r1", case_id: "c2", input: "x", mcp: ["files"] }, signal());

    expect(runner.specs[0]).toMatchObject({ tool_grants: ["forge.preflight"], tools: [] });
    expect(runner.specs[0]).not.toHaveProperty("mcp_servers");
    expect(runner.specs[1]!.mcp_servers).toEqual([{ name: "files", command: "serve", args: [] }]);
    expect(asked).toEqual([["files"]]);
  });

  it("grants no tool when the skill names none", async () => {
    const { repo, skill } = await fixture();
    const runner = listingRunner([]);
    await skillEvalReplay({ sandbox: new FolderSandbox(repo), runner }, options(skill))({ run_id: "r1", case_id: "c1", input: "x" }, signal());
    expect(runner.specs[0]).toMatchObject({ tool_grants: [], tools: [] });
    expect(runner.specs[0]).not.toHaveProperty("mcp_servers");
  });
});

describe("refusals before any sandbox is made", () => {
  const judge: SkillJudgeFn = async () => [{ answer: "yes", reason: "ok" }];

  async function suite(cases: Record<string, { mcp?: string[] }>) {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/tests-first", title: "T", created_by: OWNER });
    for (const [id, c] of Object.entries(cases)) await store.addSkillEvalCase({ id, suite_id: "s1", input: "x", expected: ["a"], ...c });
    return store;
  }

  it("under the noop sandbox a replay with tools or MCP servers is errored noop_tools_refused and no sandbox is created", async () => {
    const { repo, skill } = await fixture();
    const store = await suite({ c1: {} });
    const sandbox = new FolderSandbox(repo);
    const withTools = skillEvalReplay({ sandbox, runner: listingRunner([]) }, options(skill, {
      sandbox_plugin: "noop", system_prompt: "---\ntools: forge.preflight\n---\n", broker_tools: [{ name: "forge.preflight", read_only: true }],
    }));
    await runSkillEval({ store, replay: withTools, judge, scan: async () => [] }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());
    expect(await store.listSkillEvalReplays("r1")).toEqual([expect.objectContaining({ case_id: "c1", verdict: "errored", detail: { error: "noop_tools_refused" } })]);

    const mcpStore = await suite({ c1: { mcp: ["files"] } });
    const withMcp = skillEvalReplay({ sandbox, runner: listingRunner([]) }, options(skill, { sandbox_plugin: "noop", mcpServers: async () => [] }));
    await runSkillEval({ store: mcpStore, replay: withMcp, judge, scan: async () => [] }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());
    expect(await mcpStore.listSkillEvalReplays("r1")).toEqual([expect.objectContaining({ verdict: "errored", detail: { error: "noop_tools_refused" } })]);
    expect(sandbox.created).toEqual([]);
  });

  it("a tool the broker does not serve read-only, or an MCP server not served, errors the case before any sandbox", async () => {
    const { repo, skill } = await fixture();
    const sandbox = new FolderSandbox(repo);
    const store = await suite({ c1: {} });
    const unserved = skillEvalReplay({ sandbox, runner: listingRunner([]) }, options(skill, { system_prompt: "---\ntools: git.store_branch\n---\n", broker_tools: [{ name: "git.store_branch", read_only: false }] }));
    await runSkillEval({ store, replay: unserved, judge, scan: async () => [] }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());
    expect((await store.listSkillEvalReplays("r1"))[0]).toMatchObject({ verdict: "errored", detail: { error: "tool_not_served" } });

    const mcpStore = await suite({ c1: { mcp: ["files"] } });
    const noServer = skillEvalReplay({ sandbox, runner: listingRunner([]) }, options(skill, { mcpServers: async () => null }));
    await runSkillEval({ store: mcpStore, replay: noServer, judge, scan: async () => [] }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());
    expect((await mcpStore.listSkillEvalReplays("r1"))[0]).toMatchObject({ verdict: "errored", detail: { error: "mcp_not_served" } });
    expect(sandbox.created).toEqual([]);
  });
});

describe("what a replay stores", () => {
  const judge: SkillJudgeFn = async () => [{ answer: "yes", reason: "ok" }];

  async function oneCase() {
    const { store } = await newStore();
    await store.createSkillEvalSuite({ id: "s1", skill_ref: "skills/tests-first", title: "T", created_by: OWNER });
    await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "x", expected: ["a"] });
    return store;
  }

  it("stores the transcript, final answer, input and output tokens, the cost the runner reports, and the wall time", async () => {
    const { repo, skill } = await fixture();
    const store = await oneCase();
    let ms = 1000;
    const runner = new FakeRunner({
      implement: () => {
        ms += 250;
        return { output: { done: true }, transcript: "step 1\nstep 2", usage: { input_tokens: 120, output_tokens: 30, cost_usd: 0.02 } };
      },
    });
    const replay = skillEvalReplay({ sandbox: new FolderSandbox(repo), runner }, options(skill, { now: () => ms }));
    await runSkillEval({ store, replay, judge, scan: async () => [] }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());

    expect((await store.listSkillEvalReplays("r1"))[0]).toMatchObject({
      verdict: "pass", transcript: "step 1\nstep 2", answer: '{"done":true}', input_tokens: 120, output_tokens: 30, cost_usd: 0.02, wall_ms: 250,
    });
  });

  it("stores a null cost when the runner reports none", async () => {
    const { repo, skill } = await fixture();
    const store = await oneCase();
    const runner = new FakeRunner({ implement: () => ({ output: "a", usage: { input_tokens: 1, output_tokens: 2, cost_usd: null } }) });
    const replay = skillEvalReplay({ sandbox: new FolderSandbox(repo), runner }, options(skill, { now: () => 5 }));
    await runSkillEval({ store, replay, judge, scan: async () => [] }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());
    expect((await store.listSkillEvalReplays("r1"))[0]).toMatchObject({ answer: "a", input_tokens: 1, output_tokens: 2, cost_usd: null, wall_ms: 0 });
  });

  it("stores a transcript or answer the egress scan flags as null, with the rule names only", async () => {
    const { repo, skill } = await fixture();
    const store = await oneCase();
    const runner = new FakeRunner({ implement: () => ({ output: "the answer holds SECRET", transcript: "the transcript holds SECRET too" }) });
    const replay = skillEvalReplay({ sandbox: new FolderSandbox(repo), runner }, options(skill));
    const scan = async (text: string) => (text.includes("SECRET") ? ["known_secret", "known_secret"] : []);
    await runSkillEval({ store, replay, judge, scan }, { id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" }, signal());

    const [stored] = await store.listSkillEvalReplays("r1");
    expect(stored).toMatchObject({ transcript: null, answer: null, detail: { withheld: { transcript: ["known_secret"], answer: ["known_secret"] } } });
    expect(JSON.stringify(stored)).not.toContain("SECRET");
  });

  it("a replay stored without these values keeps null in each", async () => {
    const store = await oneCase();
    await store.startSkillEvalRun({ id: "r1", suite_id: "s1", created_by: OWNER, skill_version: "v" });
    await store.recordSkillEvalReplay({ run_id: "r1", case_id: "c1", verdict: "pass", detail: {} });
    expect((await store.listSkillEvalReplays("r1"))[0]).toMatchObject({ transcript: null, answer: null, input_tokens: null, output_tokens: null, cost_usd: null, wall_ms: null });
  });
});
