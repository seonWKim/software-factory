// The review run (RFC 0015 §8): judges a change against its spec. It never approves a change it proposed: the
// implement and resolve roles propose changes, this one only passes a verdict on them.

import { defineRole } from "../../shared/role.js";

export default defineRole({
  name: "review",
  prompt: "review.md",
  tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
  autonomous: true,
  // The diff was written from a spec that may quote outside text; the repository may be private; it pushes nothing.
  rule_of_two: { untrusted_input: true, sensitive_access: true, external_effect: false },
  proposes: ["verdict"],
  approves: ["change"],
  golden: { min_cases: 1 },
});
