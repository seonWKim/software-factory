// A fixture hook for tests/hooks.test.ts: discovery finds it under this fixture root.

import { defineHook } from "../../../../../../src/shared/hook.js";

export default defineHook({
  name: "sample",
  point: "before_merge",
  budget_ms: 1_000,
  async run(input) {
    return input.subject === "wi_veto" ? { kind: "veto", reason: "sample veto" } : { kind: "pass" };
  },
});
