import { describe, expect, it } from "vitest";
import implementKind from "../src/worker/runs/implement/implement.run.js";
import runTimeout from "../src/worker/settings/run-timeout-ms.setting.js";
import { DEFAULT_TIMEOUTS } from "../src/worker/run-kind.js";

// Issue #671: the implement agent step holds the toolchain warm-up and the agent, each with its own
// `run_timeout_ms` budget, then the pack checks and the bundle save. One hour per step was too short.
describe("implement run timeouts", () => {
  it("gives the run-agent step more than twice the default run_timeout_ms", () => {
    const budget = implementKind.timeouts.steps?.["run-agent"]?.start_to_close_ms;
    expect(budget).toBeDefined();
    expect(budget!).toBeGreaterThan(2 * Number(runTimeout.default));
    expect(budget).toBe(2 * 3_600_000);
  });

  it("keeps the shared defaults for everything else", () => {
    const { steps: _steps, ...rest } = implementKind.timeouts;
    expect(rest).toEqual(DEFAULT_TIMEOUTS);
    expect(DEFAULT_TIMEOUTS.start_to_close_ms).toBe(3_600_000);
  });
});
