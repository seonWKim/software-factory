// The implement run (RFC 0015 §8): changes the code to an approved spec and pushes its branch.

import { defineRole } from "../../shared/role.js";

export default defineRole({
  name: "implement",
  prompt: "implement.md",
  tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
  // It starts only after a spec approval, and holds all three facts: ruleOfTwoRefusal asks for a person's approval.
  autonomous: false,
  // The spec may quote outside text; the repository may be private; its branch is pushed.
  rule_of_two: { untrusted_input: true, sensitive_access: true, external_effect: true },
  proposes: ["change"],
  approves: [],
  golden: { min_cases: 1 },
});
