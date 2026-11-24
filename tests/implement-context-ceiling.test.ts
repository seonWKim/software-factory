import { describe, expect, it } from "vitest";
import type { RunOutcome } from "../src/core/types.js";
import type { AgentRunResult, AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { CONTEXT_CEILING, CONTEXT_CEILING_TOKENS } from "../src/worker/runs/implement/implement-wip.js";
import { pipeline } from "./helpers/harness.js";

// Design §5 Restarts, the context ceiling: the implement main step's session stops once one model call's context
// reaches CONTEXT_CEILING_TOKENS, its work is kept as one WIP commit, and the run continues in a new session from that
// head in the same attempt. A new session that reaches it before it makes a commit fails the run as a stopped run.

type Harness = Awaited<ReturnType<typeof pipeline>>;
type Failed = Extract<RunOutcome, { status: "failed" }>;
type Session = (spec: AgentRunSpec, f: Harness) => Partial<AgentRunResult>;

const DONE = { output: { summary: "the summary", next_steps: "the next steps" } };
/** What the run's commits list as `git log --reverse --format=%h %s start..HEAD`. */
const LOG = "c0ffee1 Add the first part\nwipc0mm wip: context ceiling of run";

/** A session that reports `tokens` of context for one model call and, when the worker stopped it, ends aborted. */
function reach(spec: AgentRunSpec, tokens: number): Partial<AgentRunResult> | null {
  spec.on_context?.(tokens);
  return spec.signal.aborted ? { status: "aborted", output: null } : null;
}

/** A pipeline whose implement calls run `sessions` in turn (the last one for any later call); every call records the HEAD it started on. */
async function harness(sessions: Session[]) {
  let f: Harness | null = null;
  const startedOn: string[] = [];
  f = await pipeline({
    implement: (spec: AgentRunSpec) => {
      startedOn.push(f!.sandbox.head.trim());
      return sessions[Math.min(startedOn.length - 1, sessions.length - 1)]!(spec, f!);
    },
  });
  const exec = f.sandbox.exec.bind(f.sandbox);
  f.sandbox.exec = async (h, cmd, o) => {
    const r = await exec(h, cmd, o);
    return cmd[1] === "log" && cmd[2] === "--reverse" ? { ...r, stdout: `${LOG}\n` } : r;
  };
  return { f, startedOn };
}

async function firstRun(f: Harness) {
  const item = await f.submit();
  await f.step();
  const [run] = await f.runs(item, "implement");
  const specs = f.runner.specs.filter((s) => s.role === "implement" && s.run_id === run!.id);
  return { item, run: run!, specs };
}

const ceilingCommits = (f: Harness) => f.sandbox.gitCalls.filter((c) => /commit --quiet --no-verify -m wip: context ceiling/.test(c));

describe("implement: the context ceiling", () => {
  it("a session whose one model call reaches the ceiling is stopped, and the run continues in a new session from its WIP head", async () => {
    const { f, startedOn } = await harness([
      (spec, h) => {
        h.sandbox.head = "c0ffee1\n"; // the session committed
        h.sandbox.status = " M src/a.ts\0"; // and left changes
        h.sandbox.commitHead = "wipc0mm";
        return reach(spec, CONTEXT_CEILING_TOKENS) ?? DONE;
      },
      (spec, h) => {
        h.sandbox.status = "";
        reach(spec, 20_000);
        return DONE;
      },
    ]);
    const { run, specs } = await firstRun(f);
    expect(run.outcome?.status).toBe("succeeded");
    expect(specs.length).toBeGreaterThanOrEqual(2);
    const [first, second] = specs;
    expect(f.runner.aborted).toContain(first);
    expect(f.runner.aborted).not.toContain(second);
    // A new session, not a resume of the stopped one, in the same run (the same attempt).
    expect(second!.session).toMatchObject({ resume: false });
    expect(second!.session!.id).not.toBe(first!.session!.id);
    expect(second!.run_id).toBe(first!.run_id);
    expect(startedOn.slice(0, 2)).toEqual(["base", "wipc0mm"]);
    expect(second!.on_context).toBeTypeOf("function");
  });

  it("keeps the stopped session's commits and changes as one WIP commit, and the new prompt says what it committed", async () => {
    const { f } = await harness([
      (spec, h) => {
        h.sandbox.head = "c0ffee1\n";
        h.sandbox.status = " M src/a.ts\0";
        h.sandbox.commitHead = "wipc0mm";
        return reach(spec, CONTEXT_CEILING_TOKENS + 1) ?? DONE;
      },
      (_spec, h) => {
        h.sandbox.status = "";
        return DONE;
      },
    ]);
    const { specs } = await firstRun(f);
    expect(ceilingCommits(f)).toHaveLength(1);
    const prompt = specs[1]!.prompt;
    expect(prompt).toContain("## Continued in a new session");
    expect(prompt).toContain("`wipc0mm`");
    expect(prompt).toContain("- c0ffee1 Add the first part");
    expect(prompt).toContain("do not redo it");
    // The new session gets the whole work item again, not only the continue section.
    expect(prompt.indexOf("## Diff budget")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("## Diff budget")).toBeLessThan(prompt.indexOf("## Continued in a new session"));
    expect(specs[0]!.prompt).not.toContain("## Continued in a new session");
  });

  it("a new session that reaches the ceiling before it makes a commit fails the run as a stopped run, kept as WIP", async () => {
    const { f } = await harness([
      (spec, h) => {
        h.sandbox.head = "c0ffee1\n";
        return reach(spec, CONTEXT_CEILING_TOKENS) ?? DONE;
      },
      (spec, h) => {
        // Changes but no commit of its own.
        h.sandbox.status = " M src/b.ts\0";
        h.sandbox.commitHead = "wipc0mm";
        return reach(spec, CONTEXT_CEILING_TOKENS) ?? DONE;
      },
    ]);
    const { item, run, specs } = await firstRun(f);
    expect(specs).toHaveLength(2);
    const outcome = run.outcome as Failed;
    expect(outcome).toMatchObject({ status: "failed", error_code: CONTEXT_CEILING });
    expect(outcome.wip).toMatchObject({ branch: `factory/wip/${item.id}/${run.id}`, head: "wipc0mm", continue: true });
    // Not kept for a --resume: a session at the ceiling has no room left.
    expect((outcome.wip as { session?: unknown }).session).toBeUndefined();
    expect(f.broker.calls.some((c) => c.name === "forge.open_change")).toBe(false);
  });

  it("a session that never reaches the ceiling runs as today: one session, no context stop, no extra WIP commit", async () => {
    const { f } = await harness([
      (spec) => {
        reach(spec, CONTEXT_CEILING_TOKENS - 1);
        reach(spec, 1_000);
        return DONE;
      },
    ]);
    const { run, specs } = await firstRun(f);
    expect(run.outcome?.status).toBe("succeeded");
    expect(specs).toHaveLength(1);
    expect(f.runner.aborted).not.toContain(specs[0]);
    expect(ceilingCommits(f)).toEqual([]);
    expect(specs[0]!.prompt).not.toContain("## Continued in a new session");
  });
});
