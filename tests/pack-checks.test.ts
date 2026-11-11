import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEnabledHooks } from "../src/compose.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { MAX_TOOL_CALL_CHECK_MS, type Pack, type PackLayer, packChecks } from "../src/packs/packs.js";
import { type CheckSandbox, PackCheckRunner, type PackCheckSpec } from "../src/runtime/hooks/pack-checks.js";
import { SqlHookAudit } from "../src/runtime/index.js";

// Pack checks (design 04-pre-push-gates.md, 11-packs.md, issue #494): `checks/<name>.json` in a pack layer, on when
// `hooks` names it, checked at startup, run as argv in the run's sandbox. A fixture pack in a temp folder per test.

const ON = { sharedStore: false, toolHooks: true };

/** A fixture pack: one folder per layer, each with the check files given (name → JSON value or raw text). */
function fixture(layers: Partial<Record<PackLayer, Record<string, unknown> | null>>): Pack[] {
  const root = mkdtempSync(join(tmpdir(), "sf-pack-checks-"));
  return (["base", "org", "project", "learned"] as const).flatMap((layer) => {
    const checks = layers[layer];
    if (checks === undefined) return [];
    const dir = join(root, layer);
    mkdirSync(dir, { recursive: true });
    if (checks !== null) {
      mkdirSync(join(dir, "checks"));
      for (const [name, body] of Object.entries(checks)) {
        writeFileSync(join(dir, "checks", `${name}.json`), typeof body === "string" ? body : JSON.stringify(body));
      }
    }
    return [{ layer, dir }];
  });
}

const at = (point: string, extra: Record<string, unknown> = {}) => ({ point, argv: ["node", "check.mjs"], ...extra });

describe("pack checks: discovery", () => {
  it("reads a listed check with its defaults; order, then layer order, then name", () => {
    const packs = fixture({
      base: { "b-late": at("before_finish", { order: 200 }), "a-same": at("before_agent") },
      org: { "a-org": at("after_agent"), "z-first": at("before_finish", { order: 1, timeout_ms: 5000, retries: 0 }) },
      project: { "a-project": at("on_tool_call") },
    });
    const checks = packChecks(packs, ["b-late", "a-same", "a-org", "z-first", "a-project"], ON);
    expect(checks.map((c) => [c.name, c.layer])).toEqual([
      ["z-first", "org"], ["a-same", "base"], ["a-org", "org"], ["a-project", "project"], ["b-late", "base"],
    ]);
    expect(checks[1]).toMatchObject({ point: "before_agent", argv: ["node", "check.mjs"], order: 100, timeout_ms: 20_000, retries: 3 });
    expect(checks[0]).toMatchObject({ order: 1, timeout_ms: 5000, retries: 0 });
    expect(checks[0]!.file).toBe(join(packs[1]!.dir, "checks", "z-first.json"));
  });

  it("a pack with no checks/ folder, or whose checks `hooks` does not list, runs none and starts normally", async () => {
    expect(packChecks(fixture({ base: null, org: null }), ["anything"], ON)).toEqual([]);
    // Not listed: not even read, so a broken file there does not fail startup.
    expect(packChecks(fixture({ base: { off: "{ not json", other: at("before_merge") } }), [], ON)).toEqual([]);
    await expect(checkEnabledHooks([], [])).resolves.toBeUndefined();
  });

  it("a listed name no layer has is left to the hook check, which fails startup naming it", async () => {
    expect(packChecks(fixture({ base: {} }), ["no-such-check"], ON)).toEqual([]);
    await expect(checkEnabledHooks(["no-such-check"], [])).rejects.toThrow("no-such-check");
  });

  it("a name two layers both have fails startup, naming the check", () => {
    const packs = fixture({ base: { twice: at("before_agent") }, org: { twice: at("before_agent") } });
    expect(() => packChecks(packs, ["twice"], ON)).toThrow(/pack check twice is in more than one layer/);
  });
});

describe("pack checks: startup refusals", () => {
  it("a point other than the four pack check points, naming the check and the point", () => {
    for (const point of ["before_merge", "before_run", "after_merge"]) {
      expect(() => packChecks(fixture({ base: { bad: at(point) } }), ["bad"], ON)).toThrow(new RegExp(`pack check bad .*point "${point}" is not a pack check point`));
    }
  });

  it("an on_tool_call check when the runner has no tool hooks, naming the check and the point", () => {
    const packs = fixture({ org: { "tool-check": at("on_tool_call") } });
    expect(() => packChecks(packs, ["tool-check"], { sharedStore: false, toolHooks: false })).toThrow(/tool-check runs at on_tool_call.*supports_tool_hooks/);
    expect(packChecks(packs, ["tool-check"], ON)).toHaveLength(1);
  });

  it("a project-layer check on a shared store, naming the file; org and base checks still run there", () => {
    const packs = fixture({ base: { b: at("before_agent") }, org: { o: at("before_agent") }, project: { p: at("before_agent") } });
    const shared = { sharedStore: true, toolHooks: true };
    expect(() => packChecks(packs, ["p"], shared)).toThrow(join(packs[2]!.dir, "checks", "p.json"));
    expect(packChecks(packs, ["b", "o"], shared).map((c) => c.name)).toEqual(["b", "o"]);
    expect(packChecks(packs, ["p"], ON).map((c) => c.layer)).toEqual(["project"]);
  });

  it("a bad check file: not JSON, no argv, a shell string, an on_tool_call timeout over the PreToolUse limit, bad retries", () => {
    const bad: Record<string, unknown> = {
      json: "{",
      noargv: { point: "before_agent" },
      shell: { point: "before_agent", argv: "npm test && rm -rf /" },
      slow: at("on_tool_call", { timeout_ms: MAX_TOOL_CALL_CHECK_MS + 1 }),
      retries: at("before_finish", { retries: -1 }),
      order: at("before_finish", { order: 1.5 }),
    };
    const packs = fixture({ base: bad });
    for (const name of Object.keys(bad)) expect(() => packChecks(packs, [name], ON), name).toThrow(`pack check ${name} (`);
    expect(MAX_TOOL_CALL_CHECK_MS).toBeLessThan(30_000);
  });
});

/** A sandbox whose exec answers from `answer`, recording each argv and env. */
function fakeSandbox(answer: (argv: readonly string[]) => Awaited<ReturnType<CheckSandbox["exec"]>> | Error) {
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>>; timeout_ms?: number }[] = [];
  const sandbox: CheckSandbox = {
    exec: async (_h, argv, o) => {
      calls.push({ argv, env: o.env, ...(o.timeout_ms !== undefined ? { timeout_ms: o.timeout_ms } : {}) });
      const r = answer(argv);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { sandbox, calls };
}
const exit = (code: number | null, extra: Partial<{ stderr: string; timed_out: boolean; signal: string }> = {}) =>
  ({ exit_code: code, signal: extra.signal ?? null, stdout: "", stderr: extra.stderr ?? "", timed_out: extra.timed_out ?? false });
const spec = (name: string, point: PackCheckSpec["point"] = "before_finish", retries = 3): PackCheckSpec => ({ name, point, argv: [name], timeout_ms: 1000, retries });
const CTX = { subject: "run_1", project_id: "p1", sandbox: { workdir: "/w" }, env: { PATH: "/bin" } };
const NOW = () => "2026-11-11T00:00:00.000Z";
const signal = new AbortController().signal;

async function audit(): Promise<SqlHookAudit> {
  const d = new SqliteDriver(":memory:");
  await d.migrate();
  return new SqlHookAudit(d);
}

describe("pack checks: the runner", () => {
  it("runs each check of the point in order as argv with the given env; exit 0 is no objection and is not audited", async () => {
    const { sandbox, calls } = fakeSandbox(() => exit(0));
    const a = await audit();
    const r = new PackCheckRunner([spec("one"), spec("two"), spec("other", "before_agent")], { sandbox, audit: a, now: NOW });
    const gate = r.at("before_finish", CTX)!;
    expect(gate.checks).toEqual(["one", "two"]);
    expect(await gate.run(["x"], signal)).toBeNull();
    expect(calls).toEqual([{ argv: ["one", "x"], env: { PATH: "/bin" }, timeout_ms: 1000 }, { argv: ["two", "x"], env: { PATH: "/bin" }, timeout_ms: 1000 }]);
    expect(await a.forSubject("run_1")).toEqual([]);
    expect(r.at("on_tool_call", CTX)).toBeNull();
  });

  it("a non-zero exit, a kill, a timeout, an exec error and an abort each refuse, stop the rest and are audited", async () => {
    const cases: [ReturnType<typeof exit> | Error, string, string][] = [
      [exit(2, { stderr: "first\nnot formatted\n" }), "veto", "exited 2: not formatted"],
      [exit(null, { signal: "SIGKILL" }), "error", "pack_check_error: killed by SIGKILL"],
      [exit(null, { timed_out: true }), "timeout", "pack_check_timeout: over its 1000 ms timeout"],
      [new Error("spawn ENOENT"), "error", "pack_check_error: spawn ENOENT"],
    ];
    for (const [answer, outcome, text] of cases) {
      const { sandbox, calls } = fakeSandbox((argv) => (argv[0] === "first" ? answer : exit(0)));
      const a = await audit();
      const r = await new PackCheckRunner([spec("first"), spec("second")], { sandbox, audit: a, now: NOW }).at("before_finish", CTX)!.run([], signal);
      expect(r).toEqual({ check: "first", reason: text, retries: 3 });
      expect(calls.map((c) => c.argv[0])).toEqual(["first"]);
      expect((await a.forSubject("run_1")).map((d) => [d.hook, d.point, d.outcome, d.text, d.project_id, d.at])).toEqual([
        ["first", "before_finish", outcome, text, "p1", NOW()],
      ]);
    }
    const aborted = new AbortController();
    aborted.abort();
    const { sandbox, calls } = fakeSandbox(() => exit(0));
    expect(await new PackCheckRunner([spec("one")], { sandbox, now: NOW }).at("before_finish", CTX)!.run([], aborted.signal)).toMatchObject({ check: "one" });
    expect(calls).toEqual([]);
  });

  it("untilPassed sends the agent back for each refusal up to the check's retries, then returns the refusal", async () => {
    let refusals = 2;
    const { sandbox } = fakeSandbox(() => (refusals-- > 0 ? exit(1) : exit(0)));
    const gate = new PackCheckRunner([spec("fmt", "before_finish", 2)], { sandbox, now: NOW }).at("before_finish", CTX)!;
    const fixes: string[] = [];
    expect(await gate.untilPassed(async (r) => void fixes.push(r.check), signal)).toBeNull();
    expect(fixes).toEqual(["fmt", "fmt"]);

    const never = fakeSandbox(() => exit(1)).sandbox;
    const capped = new PackCheckRunner([spec("fmt", "before_finish", 1)], { sandbox: never, now: NOW }).at("before_finish", CTX)!;
    const sent: string[] = [];
    expect(await capped.untilPassed(async (r) => void sent.push(r.check), signal)).toMatchObject({ check: "fmt", retries: 1 });
    expect(sent).toEqual(["fmt"]);
  });
});
