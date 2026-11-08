// The resolve run (RFC 0015 §8): resolves a merge conflict on the change's branch and pushes it.

import { defineRole } from "../../shared/role.js";

export default defineRole({
  name: "resolve",
  prompt: "resolve.md",
  tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
  // It runs on a change whose spec was approved, or on a person's `/resolve`, and holds all three facts.
  autonomous: false,
  // A person's /resolve notes are untrusted text; the repository may be private; its branch is pushed.
  rule_of_two: { untrusted_input: true, sensitive_access: true, external_effect: true },
  proposes: ["change"],
  approves: [],
  golden: { min_cases: 1 },
});
