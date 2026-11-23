// The routine run: an owner-set instruction run on its own schedule, that reads the repository and the one web page
// the owner set (Browse, GET only) and proposes suggestions. Read-only tools; it pushes, posts and merges nothing.

import { defineRole } from "../../shared/role.js";

export default defineRole({
  name: "routine",
  prompt: "routine.md",
  tools: ["Read", "Glob", "Grep", "Browse"],
  autonomous: true,
  // The web page is outside the trust set; the repository may be private; a GET of the fixed owner-set URL carries
  // nothing the run chooses, so it sends nothing out.
  rule_of_two: { untrusted_input: true, sensitive_access: true, external_effect: false },
  proposes: ["verdict"],
  approves: [],
  golden: { min_cases: 1 },
});
