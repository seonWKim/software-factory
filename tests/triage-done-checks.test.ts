import { describe, expect, it } from "vitest";
import { triageSpec } from "./helpers/fakes/config.js";
import { autoTriage } from "./helpers/classifier.js";

// Done-when checks (design 04-triage, 2026-11-22): the triage branch passes the repo's check commands to parseTriage
// and stores the list on the item; the worker's own parse has no command list, so these refusals are the branch's.
describe("the triage branch and done_checks", () => {
  it("stores the answer's done_checks on the item and shows each line's check in the spec comment", async () => {
    const r = await autoTriage(triageSpec);
    expect(r.it.done_checks).toEqual(triageSpec.done_checks);
    const spec = r.source.comments.find((c) => c.marker.includes("spec:"))!.body;
    expect(spec).toContain(`- ${triageSpec.done_criteria[0]} (check: \`tests/scope-gate.test.ts\`)`);
  });

  it("refuses an answer without done_checks: nothing is stored and the item does not move on", async () => {
    const { done_checks: _, ...without } = triageSpec;
    const r = await autoTriage(without);
    expect(r.it).toMatchObject({ stage: "NEW", done_checks: null, done_criteria: null });
    expect(r.changes.map((c) => c.reason)).not.toContain("spec_approved");
  });

  it("refuses a command that is not one of the repo's check commands", async () => {
    const r = await autoTriage({ ...triageSpec, done_checks: [{ line: triageSpec.done_criteria[0], command: "rm -rf /" }] });
    expect(r.it).toMatchObject({ stage: "NEW", done_checks: null });
  });
});
