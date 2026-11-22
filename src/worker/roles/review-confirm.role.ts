// The review's confirm step (design 04-agents): one fresh run per review finding, holding only the finding text and
// the diff, that says whether the finding holds. Read-only tools, no kept session; it runs inside a review run, on
// the review's model class, so it is no review loop of its own.

import { defineRole } from "../../shared/role.js";

export default defineRole({
  name: "review-confirm",
  prompt: "review-confirm.md",
  tools: ["Read", "Glob", "Grep"],
  autonomous: true,
  // The finding and the diff may quote outside text; the repository may be private; it writes and sends nothing.
  rule_of_two: { untrusted_input: true, sensitive_access: true, external_effect: false },
  proposes: ["verdict"],
  approves: [],
  golden: { min_cases: 1 },
});
