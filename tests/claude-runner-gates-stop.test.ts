import { describe, expect, it } from "vitest";
import { STOP_HOOK_SLACK_MS, runDeadline } from "../src/impl/runner/gate-hooks.js";
import { STOP_CHECK_TIMED_OUT, type StopSelection } from "../src/interfaces/agent-runner.js";
import agentStopCheck from "../src/worker/settings/agent-stop-check-ms.setting.js";
import { GATES, MODES, after, answerer, canListen, drive, hookSettings, setup, stopper } from "./helpers/gate-hooks-fixture.js";

// The Stop check's test selection (design §4): the check before push's own rule (selectedChecks) narrows the test
// command in enforce mode; shadow runs it whole; without a selection the check list runs as it is.
for (const mode of MODES) describe(`gate hooks: Stop test selection (${mode})`, () => {
  const selection = (m: StopSelection["mode"]): StopSelection => ({
    mode: m, test_command: ["npm", "test"], test_selection: { hubs: ["src/hub.ts"], always: ["tests/always.test.ts"] },
  });
  /** A one-file change to src/a.ts, which tests/a.test.ts imports. */
  const oneFile = (f: ReturnType<typeof setup>) => {
    f.sandbox.changed = ["src/a.ts"];
    f.sandbox.tracked = ["src/a.ts", "src/hub.ts", "tests/a.test.ts", "tests/b.test.ts", "tests/always.test.ts"];
    f.sandbox.imports = ['tests/a.test.ts\0import { a } from "../src/a.js";', 'tests/b.test.ts\0import { h } from "../src/hub.js";'];
  };
  const npm = (f: ReturnType<typeof setup>) => f.sandbox.commands.filter((c) => c.startsWith("npm"));

  it("in enforce mode a one-file change runs only the selected test files, and the result names the selection", async () => {
    const f = setup("implement", { ...GATES, selection: selection("enforce") });
    oneFile(f);
    const reasons: string[] = [];
    f.sandbox.agent = stopper(reasons);
    const result = await drive(f, mode);
    expect(reasons).toEqual([]);
    expect(npm(f)).toEqual(["npm run typecheck", "npm test -- tests/a.test.ts tests/always.test.ts"]);
    expect(result.stop_selections).toEqual([
      "test selection (enforce): 2 files, 1 reaching the 1 changed source and test files, plus 1 always-run: tests/a.test.ts tests/always.test.ts",
    ]);
  });

  it("a failing selected test command is the block's check, named as it ran", async () => {
    const f = setup("implement", { ...GATES, selection: selection("enforce") });
    oneFile(f);
    f.sandbox.checks["npm test -- tests/a.test.ts tests/always.test.ts"] = { exit: 1, out: "FAIL tests/a.test.ts" };
    const reasons: string[] = [];
    f.sandbox.agent = async (a) => void reasons.push((await a.stop())!);
    const result = await drive(f, mode);
    expect(reasons[0]).toContain("`npm test -- tests/a.test.ts tests/always.test.ts` failed (exited 1)");
    expect(result.gate_blocks).toEqual([{ hook: "stop", check: "npm test -- tests/a.test.ts tests/always.test.ts", attempt: 1 }]);
  });

  for (const [file, why] of [["src/hub.ts", "full: hub file src/hub.ts changed"], ["package.json", "full: package file package.json changed"]] as const) {
    it(`a change to ${file} runs the full test command, with the reason`, async () => {
      const f = setup("implement", { ...GATES, selection: selection("enforce") });
      oneFile(f);
      f.sandbox.changed = ["src/a.ts", file];
      f.sandbox.agent = stopper([]);
      const result = await drive(f, mode);
      expect(npm(f)).toEqual(["npm run typecheck", "npm test"]);
      expect(result.stop_selections).toEqual([`test selection (enforce): ${why}`]);
    });
  }

  it("in shadow mode the test command runs whole, and the selection is named as shadow", async () => {
    const f = setup("implement", { ...GATES, selection: selection("shadow") });
    oneFile(f);
    f.sandbox.agent = stopper([]);
    const result = await drive(f, mode);
    expect(npm(f)).toEqual(["npm run typecheck", "npm test"]);
    expect(result.stop_selections).toEqual([
      "test selection (shadow): 2 files, 1 reaching the 1 changed source and test files, plus 1 always-run: tests/a.test.ts tests/always.test.ts",
    ]);
  });

  it("with no selection the check list runs as it is and nothing is named; selection reads no git", async () => {
    const f = setup();
    oneFile(f);
    f.sandbox.agent = stopper([]);
    const result = await drive(f, mode);
    expect(npm(f)).toEqual(["npm run typecheck", "npm test"]);
    expect(result.stop_selections).toBeUndefined();
    expect(f.sandbox.commands.filter((c) => c.startsWith("git diff --name-only") || c.startsWith("git ls-files") || c.startsWith("git grep"))).toEqual([]);
  });
});

describe.runIf(canListen)("gate hooks: Stop and the stall clock", () => {
  it("a Stop check that runs longer than stall_ms is not a stall: the run completes", async () => {
    const f = setup();
    // The hook process itself takes time to start under load: the limit leaves room for it, the check runs well past it.
    f.spec = { ...f.spec, stall_ms: 1_500, first_output_ms: 1_500 };
    f.sandbox.checks["npm test"] = { exit: 0, out: "", ms: 4_000 };
    const reasons: string[] = [];
    f.sandbox.agent = stopper(reasons);
    const result = await f.runner.run(f.spec);
    expect(reasons).toEqual([]);
    expect(result.status).toBe("completed");
  });
});

// The Stop check's own time limit (design §4, issue #717): separate from the run's timeout_ms, which it does not use up.
describe("gate hooks: the Stop check's time limit", () => {
  it.runIf(canListen)("the Stop hook's timeout comes from the Stop check's limit, not the run's timeout_ms", async () => {
    const timeouts: number[] = [];
    for (const [stopCheckMs, timeout_ms] of [[undefined, 60_000], [undefined, 7_200_000], [4_000, 60_000]] as const) {
      const f = setup("implement", GATES, stopCheckMs);
      f.spec = { ...f.spec, timeout_ms };
      const settings = await hookSettings(f);
      timeouts.push(settings.Stop![0]!.hooks[0]!.timeout);
    }
    const limit = Math.ceil((agentStopCheck.default! + STOP_HOOK_SLACK_MS) / 1000);
    expect(timeouts).toEqual([limit, limit, Math.ceil((4_000 + STOP_HOOK_SLACK_MS) / 1000)]);
  });

  it.runIf(canListen)("a spec with no stop_check_ms gets 40 minutes, the agent_stop_check_ms default", async () => {
    expect(agentStopCheck.default).toBe(2_400_000);
    const settings = await hookSettings(setup("implement", GATES));
    expect(settings.Stop![0]!.hooks[0]!.timeout).toBe(2_400 + STOP_HOOK_SLACK_MS / 1000);
  });

  it.runIf(canListen)("the same runner uses each run's own stop_check_ms: a value set between runs applies to the next one", async () => {
    const f = setup("implement", GATES);
    const timeouts: number[] = [];
    for (const stop_check_ms of [600_000, 3_600_000]) {
      f.spec = { ...f.spec, stop_check_ms };
      timeouts.push((await hookSettings(f)).Stop![0]!.hooks[0]!.timeout);
    }
    expect(timeouts).toEqual([600 + STOP_HOOK_SLACK_MS / 1000, 3_600 + STOP_HOOK_SLACK_MS / 1000]);
  });

  it("a check within its limit passes as before, with nothing killed", async () => {
    const f = setup("implement", GATES, 3_000);
    f.sandbox.checks["npm test"] = { exit: 0, out: "", ms: 200 };
    const answers = await answerer(f, 3_000);
    expect(await answers.answer({ event: "stop" })).toBeNull();
    expect(answers.stopTimeout()).toBeNull();
    expect(f.sandbox.killed).toEqual([]);
  });

  it("a check over its limit is killed, the stop allowed and the timeout kept naming the check; no later stop runs a check", async () => {
    const f = setup("implement", GATES, 300);
    f.sandbox.checks["npm test"] = { exit: 0, out: "", ms: 60_000 };
    const answers = await answerer(f, 300);
    expect(await answers.answer({ event: "stop" })).toBeNull();
    expect(f.sandbox.killed).toEqual(["npm test"]);
    expect(answers.stopTimeout()).toEqual({ check: "npm test", ms: 300 });
    const before = f.sandbox.commands.length;
    expect(await answers.answer({ event: "stop" })).toBeNull();
    expect(f.sandbox.commands.length).toBe(before);
  });

  it.runIf(canListen)("a run whose Stop check runs out fails naming the check, not as timed out; it waited for the check", async () => {
    const f = setup("implement", GATES, 800);
    f.sandbox.checks["npm test"] = { exit: 0, out: "", ms: 60_000 };
    const reasons: string[] = [];
    f.sandbox.agent = stopper(reasons);
    const result = await f.runner.run(f.spec);
    expect(result.status).toBe("failed");
    expect(result.error).toContain(`${STOP_CHECK_TIMED_OUT}: `);
    expect(result.error).toContain("`npm test`");
    expect(result.error).toContain("800 ms");
    expect(f.sandbox.killed).toEqual(["npm test"]);
  });

  it.runIf(canListen)("the Stop check's time does not count against the run's timeout_ms", async () => {
    const f = setup("implement", GATES, 20_000);
    f.spec = { ...f.spec, timeout_ms: 1_500, stall_ms: 60_000, first_output_ms: 60_000 };
    f.sandbox.checks["npm test"] = { exit: 0, out: "", ms: 3_000 };
    const reasons: string[] = [];
    f.sandbox.agent = stopper(reasons);
    const result = await f.runner.run(f.spec);
    expect(reasons).toEqual([]);
    expect(result.status).toBe("completed");
    expect(f.sandbox.killed).toEqual([]);
  });

  it("an agent over the run's timeout_ms is still timed out", async () => {
    const f = setup("implement", GATES, 20_000);
    f.spec = { ...f.spec, timeout_ms: 300, stall_ms: 60_000, first_output_ms: 60_000 };
    f.sandbox.agent = () => new Promise((r) => setTimeout(r, 3_000));
    const result = await f.runner.run(f.spec);
    expect(result.status).toBe("timed_out");
    expect(result.error).toBeUndefined();
  });
});

describe("the run deadline", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("ends the run at timeout_ms with no Stop check", async () => {
    const d = runDeadline(150, () => false, after);
    await sleep(400);
    expect(d.signal.aborted).toBe(true);
  });

  it("does not count the time a Stop check runs", async () => {
    const start = Date.now();
    // A Stop check that runs from the start for 600 ms.
    const d = runDeadline(150, () => Date.now() - start < 600, after);
    await sleep(500);
    expect(d.signal.aborted).toBe(false);
    await sleep(600);
    expect(d.signal.aborted).toBe(true);
    d.stop();
  });

  it("stops without firing", async () => {
    const d = runDeadline(100, () => false, after);
    d.stop();
    await sleep(250);
    expect(d.signal.aborted).toBe(false);
  });
});
