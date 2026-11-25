// The no-skill baseline run (`eval run --baseline`, design 07-self-improvement): the skill's suite replayed with no
// skill text and no skill folder, stored as `baseline:<folder hash>` beside the skill's runs, and never read as a
// measured run by self-improve. Its sandbox gets the clean checkout and the case's seed folder but no skill; its system
// prompt is empty; it gets no tools from front matter, and a case's MCP servers as a skill run gets them. The sandbox
// runs over a temporary folder (its clean-up commands run there); the runner and the judge are fakes: no model is called.

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SKILL_IMPROVE_DEFAULTS } from "../src/core/skill-improve-config.js";
import { skillTrigger } from "../src/core/skill-improve.js";
import type { UserId } from "../src/core/types.js";
import type { LLMProvider } from "../src/interfaces/llm-provider.js";
import type { ExecOptions, ExecResult, SandboxHandle, SandboxSpec } from "../src/interfaces/sandbox.js";
import { skillVersion } from "../src/runtime/capabilities/capabilities.js";
import { type SkillEvalWiring, runSkillEvalFor } from "../src/skill-evals.js";
import { cleanScanner } from "./helpers/fakes/config.js";
import { FakeRunner } from "./helpers/fakes/runner.js";
import { newStore } from "./helpers/store.js";

const OWNER = "local:owner" as UserId;
const SKILL = "skills/tests-first";
const SKILL_TEXT = "---\nname: tests-first\ntools: test.read_note\n---\nWrite the test first.\n";
const signal = () => new AbortController().signal;

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "skill-eval-baseline-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Every file under `dir`, relative and sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
}

/** A sandbox whose run folders are copies of `repo` in the temporary folder: its commands and copies run there. */
class FolderSandbox {
  created: SandboxSpec[] = [];
  copies: { from: string; to: string }[] = [];
  constructor(private readonly repo: string) {}
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec);
    const workdir = join(tmp, "runs", `sbx${this.created.length}`);
    await cp(this.repo, workdir, { recursive: true });
    return { id: `sbx${this.created.length}`, workdir };
  }
  async exec(h: SandboxHandle, cmd: readonly string[], o: ExecOptions): Promise<ExecResult> {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: h.workdir, env: { ...o.env }, input: o.stdin ?? "", encoding: "utf8" });
    return { exit_code: r.status, signal: null, stdout: r.stdout, stderr: r.stderr, timed_out: false };
  }
  async copyIn(h: SandboxHandle, hostPath: string, sandboxPath: string): Promise<void> {
    this.copies.push({ from: hostPath, to: sandboxPath });
    await cp(hostPath, join(h.workdir, sandboxPath), { recursive: true });
  }
  async copyOut(): Promise<void> {}
  async updateBase(): Promise<string> {
    return "base";
  }
  async destroy(): Promise<void> {}
}

const yes: LLMProvider = {
  complete: async () => ({ text: "", parsed: { answers: [{ answer: "yes", reason: "ok" }] }, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } }),
};

/**
 * A suite of SKILL with a seeded case (c1) and a case naming MCP server `files` (c2); the skill folder (naming a tool in
 * its front matter) and the seed folder on the host; a checkout with agent rules; and the wiring over them.
 */
async function setup(o: { sandbox_plugin?: string } = {}) {
  const { store } = await newStore();
  await store.createSkillEvalSuite({ id: "s1", skill_ref: SKILL, title: "Tests first", created_by: OWNER });
  await store.addSkillEvalCase({ id: "c1", suite_id: "s1", input: "seeded", expected: ["a"], seed: "seeds/one" });
  await store.addSkillEvalCase({ id: "c2", suite_id: "s1", input: "with mcp", expected: ["a"], mcp: ["files"] });
  const repo = join(tmp, "repo");
  for (const [f, text] of Object.entries({ "CLAUDE.md": "rules", "src/keep.ts": "export {};" })) {
    await mkdir(join(repo, f, ".."), { recursive: true });
    await writeFile(join(repo, f), text);
  }
  const folder = join(tmp, SKILL);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), SKILL_TEXT);
  await writeFile(join(folder, "reference.md"), "ref");
  await mkdir(join(tmp, "seeds", "one"), { recursive: true });
  await writeFile(join(tmp, "seeds", "one", "data.txt"), "seeded");

  const sandbox = new FolderSandbox(repo);
  const seen = new Map<string, string[]>();
  const runner = new FakeRunner({ implement: async (spec) => (seen.set(spec.prompt, await filesUnder(spec.sandbox.workdir)), { output: "done" }) });
  const plugins = vi.fn(async () => ({ sandbox, runner, llm: yes, scanner: cleanScanner }));
  const asked: string[][] = [];
  let n = 0;
  const d: SkillEvalWiring = {
    store, root: tmp, judgePrompt: async () => "JUDGE", plugins, repo: { path: repo, base_branch: "main" }, deny_paths: [], timeout_ms: 1000,
    newId: () => `run${++n}`, sandbox_plugin: o.sandbox_plugin ?? "local",
    mcpServers: async (names) => (asked.push([...names]), names.map((name) => ({ name, command: "serve", args: [] }))),
  };
  return { store, d, folder, sandbox, runner, plugins, seen, asked };
}

describe("eval run --baseline", () => {
  it("replays the suite with no skill text and no skill folder, stored as baseline:<folder hash> beside the skill's runs", async () => {
    const { store, d, folder } = await setup();
    const skill = await runSkillEvalFor(d, { skill: SKILL, created_by: OWNER, signal: signal() });
    const baseline = await runSkillEvalFor(d, { skill: SKILL, created_by: OWNER, signal: signal(), baseline: true });

    const hash = await skillVersion(folder);
    expect(skill).toEqual({ run: expect.objectContaining({ skill_version: hash }) });
    expect(baseline).toEqual({ run: expect.objectContaining({ skill_version: `baseline:${hash}`, status: "passed", pass_rate: 1, replays: 2 }) });
    const runs = await store.listSkillEvalRuns(SKILL);
    expect(runs.map((r) => r.skill_version)).toEqual(expect.arrayContaining([hash, `baseline:${hash}`]));
  });

  it("is not read as a measured run by self-improve: a baseline below the target triggers nothing", async () => {
    const { store, d } = await setup();
    await runSkillEvalFor(d, { skill: SKILL, created_by: OWNER, signal: signal(), baseline: true });
    const runs = await store.listSkillEvalRuns(SKILL);
    expect(runs[0]!.skill_version).toMatch(/^baseline:/);
    const low = runs.map((r) => ({ ...r, pass_rate: 0.1 }));
    expect(skillTrigger(low, SKILL_IMPROVE_DEFAULTS)).toBeNull();
  });

  it("copies no skill folder and writes no SKILL.md into the sandbox; the case's seed folder still applies", async () => {
    const { d, sandbox, seen } = await setup();
    await runSkillEvalFor(d, { skill: SKILL, created_by: OWNER, signal: signal(), baseline: true });

    expect(sandbox.copies).toEqual([{ from: join(tmp, "seeds", "one"), to: "." }]);
    for (const files of seen.values()) {
      expect(files.filter((f) => f.endsWith("SKILL.md") || f.includes("tests-first") || f.endsWith("CLAUDE.md"))).toEqual([]);
      expect(files).toContain("src/keep.ts");
    }
    expect(seen.get("seeded")).toContain("data.txt");
    expect(seen.get("with mcp")).not.toContain("data.txt");
  });

  it("has an empty system prompt, no tools from front matter, and the case's MCP servers as a skill run gets them", async () => {
    const { d, runner, plugins, asked } = await setup();
    await runSkillEvalFor(d, { skill: SKILL, created_by: OWNER, signal: signal(), baseline: true });

    expect(plugins).toHaveBeenCalledWith({ tools: false });
    for (const spec of runner.specs) expect(spec).toMatchObject({ system_prompt: "", tools: [], tool_grants: [] });
    const byPrompt = new Map(runner.specs.map((s) => [s.prompt, s]));
    expect(byPrompt.get("seeded")).not.toHaveProperty("mcp_servers");
    expect(byPrompt.get("with mcp")!.mcp_servers).toEqual([{ name: "files", command: "serve", args: [] }]);
    expect(asked).toEqual([["files"]]);
  });

  it("under the noop sandbox a case with MCP servers is refused noop_tools_refused; a case without runs", async () => {
    const { store, d, sandbox } = await setup({ sandbox_plugin: "noop" });
    const r = await runSkillEvalFor(d, { skill: SKILL, created_by: OWNER, signal: signal(), baseline: true });
    const id = "run" in r ? r.run.id : "";
    const replays = await store.listSkillEvalReplays(id);
    expect(replays.find((x) => x.case_id === "c2")).toMatchObject({ verdict: "errored", detail: { error: "noop_tools_refused" } });
    expect(replays.find((x) => x.case_id === "c1")).toMatchObject({ verdict: "pass" });
    expect(sandbox.created).toHaveLength(1);
  });

  it("refuses a baseline of a stored version, and a skill whose folder cannot be read, writing no run", async () => {
    const { store, d } = await setup();
    expect(await runSkillEvalFor(d, { skill: SKILL, created_by: OWNER, signal: signal(), baseline: true, version: "v1" })).toEqual({ refused: expect.stringContaining("baseline") });
    await store.createSkillEvalSuite({ id: "s2", skill_ref: "skills/missing", title: "Missing", created_by: OWNER });
    expect(await runSkillEvalFor(d, { skill: "skills/missing", created_by: OWNER, signal: signal(), baseline: true })).toEqual({ refused: expect.stringContaining("skills/missing") });
    expect(await store.listSkillEvalRuns(SKILL)).toEqual([]);
  });
});
