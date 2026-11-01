import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunId, WorkItemId } from "../src/core/types.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { AgentRunSpec, AgentRunner } from "../src/interfaces/agent-runner.js";
import type { SandboxHandle } from "../src/interfaces/sandbox.js";
import type { Contexts } from "../src/plugin-api.js";
import { REGISTRY, createPlugin, withPlugin } from "../src/plugins.js";
import { ScriptedLLM, type ScriptStep, ScriptedRunner } from "./helpers/scripted-runner.js";

// #90 (part 3 of 3 for #58): a runner with no harness of its own gets the file guards for free by calling
// the shared tools in src/core/tools. The runner is test-only, selected through withPlugin, never REGISTRY.

const SECRET = "DENIED-CONTENT-c41d9e";
const RUNNER = "scripted-test";

let root: string;
let workdir: string;
let handle: SandboxHandle;
const sandbox = new NoOpSandbox(join(tmpdir(), "sf-scripted-unused"));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sf-scripted-"));
  // Read-only tools need no git clone: a plain folder as the run folder, exec'd through NoOpSandbox.
  workdir = join(root, "run");
  mkdirSync(join(workdir, "docs"), { recursive: true });
  writeFileSync(join(workdir, "docs", "notes.txt"), "alpha\nthe answer is 42\n");
  writeFileSync(join(workdir, "docs", "other.txt"), "nothing here\n");
  mkdirSync(join(workdir, "vault"));
  writeFileSync(join(workdir, "vault", "key.txt"), `${SECRET}\n`);
  handle = { id: "sbx_scripted", workdir };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function spec(): AgentRunSpec {
  return {
    run_id: "run_scripted" as RunId,
    work_item_id: "wi_scripted" as WorkItemId,
    role: "review",
    sandbox: handle,
    system_prompt: "",
    prompt: "",
    harness_tools: ["Read", "Grep"],
    tool_grants: [],
    lease_token: 1,
    env_allowlist: {},
    deny_paths: [join(workdir, "vault")],
    writable_paths: [],
    model_class: "cheap",
    timeout_ms: 60_000,
    signal: new AbortController().signal,
  };
}

/** Builds the runner the way the factory would: by name, from a registry the test extended with withPlugin. */
async function runner(steps: readonly ScriptStep[]): Promise<{ runner: AgentRunner; llm: ScriptedLLM }> {
  const llm = new ScriptedLLM(steps);
  const registry = withPlugin(REGISTRY, "runner", RUNNER, (c) => new ScriptedRunner(c.sandbox, llm));
  // The runner reads only `sandbox` from its context.
  const ctx = { sandbox } as unknown as Contexts["runner"];
  return { runner: await createPlugin(registry, "runner", RUNNER, ctx), llm };
}

describe("scripted test-only runner", () => {
  it("is not in REGISTRY: only withPlugin adds it", () => {
    expect(Object.keys(REGISTRY.runner.plugins)).not.toContain(RUNNER);
  });

  it("completes a read-only task: Grep finds the file, Read reads it", async () => {
    const { runner: r, llm } = await runner([
      { tool: "Grep", input: { pattern: "answer is", output_mode: "files_with_matches" } },
      { tool: "Read", input: { file_path: "docs/notes.txt" } },
      { final: { answer: "42" } },
    ]);
    const res = await r.run(spec());
    expect(res.status).toBe("completed");
    expect(res.output).toEqual({ answer: "42" });

    const [grep, read] = llm.observations;
    expect(grep?.result.ok).toBe(true);
    if (!grep?.result.ok) throw new Error("grep failed");
    expect(grep.result.content).toContain("notes.txt");
    expect(grep.result.content).not.toContain("other.txt");
    expect(read?.result).toEqual({ ok: true, content: expect.stringContaining("the answer is 42") });
    expect(res.transcript).toContain("the answer is 42");
  });

  it("returns a Read of a denied path to the LLM as a refusal, and leaks nothing", async () => {
    const { runner: r, llm } = await runner([
      { tool: "Read", input: { file_path: join(realpathSync(workdir), "vault", "key.txt") } },
      { tool: "Grep", input: { pattern: "DENIED" } },
      { final: { answer: "refused" } },
    ]);
    const res = await r.run(spec());
    expect(res.status).toBe("completed");
    expect(res.output).toEqual({ answer: "refused" });

    const [read, grep] = llm.observations;
    expect(read?.result.ok).toBe(false);
    if (read?.result.ok !== false) throw new Error("expected a refusal");
    expect(read.result.error).toMatch(/den/i);
    // Grep drops denied files: the search finds nothing, so it cannot leak them either.
    expect(grep?.result).toEqual({ ok: true, content: "" });

    expect(JSON.stringify(res.output)).not.toContain(SECRET);
    expect(res.transcript).not.toContain(SECRET);
    expect(JSON.stringify(llm.observations)).not.toContain(SECRET);
  });
});
