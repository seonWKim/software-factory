// The triage run (RFC 0015 §8): reads the work item and the repository, writes a spec. Read-only tools; the spec
// goes through the spec gate before anything acts on it.

import { defineRole } from "../../shared/role.js";

export default defineRole({
  name: "triage",
  prompt: "triage.md",
  tools: ["Read", "Glob", "Grep"],
  autonomous: true,
  // Issue text is from outside the trust set; the repository may be private; it pushes and sends nothing.
  rule_of_two: { untrusted_input: true, sensitive_access: true, external_effect: false },
  proposes: ["spec"],
  approves: [],
  golden: { min_cases: 1 },
});
