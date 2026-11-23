// The judge (design 04-split-specs): one run per goal phase that closed completed with a merge sha, that reads the
// goal lines, the phase and the base the phase merged into, and proposes a verdict (next, fix, done, ask). Read-only
// tools; the controller applies the verdict, so it approves nothing. Pinned to the strong class by the runner.

import { defineRole } from "../../shared/role.js";

export default defineRole({
  name: "judge",
  prompt: "judge.md",
  tools: ["Read", "Glob", "Grep"],
  autonomous: true,
  // Goal and phase text may quote outside text; the repository may be private; it writes and sends nothing.
  rule_of_two: { untrusted_input: true, sensitive_access: true, external_effect: false },
  proposes: ["verdict"],
  approves: [],
  golden: { min_cases: 1 },
});
