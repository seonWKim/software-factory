import { describe, expect, it } from "vitest";
import { triageSpec } from "./helpers/fakes/config.js";
import { autoTriage } from "./helpers/classifier.js";

// The size checkpoint (design 04-split-specs): an answer over 85% of a cap with no phases waits at the spec gate,
// never approved without a person, auto mode included; 1 phase or more than 4 is refused as before.
describe("the triage branch and the size checkpoint", () => {
  const phase = (n: number) => ({ title: `Part ${n}`, problem: `Problem ${n}`, done_criteria: [`part ${n} works`], allowed_paths: [`src/p${n}/`] });

  it("an estimate over 85% of a cap with no phases waits at the spec gate with the size checkpoint note, not approved by auto mode", async () => {
    const r = await autoTriage({ ...triageSpec, estimated_lines: 1400 });
    expect(r.it).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    expect(r.changes.map((c) => c.reason)).not.toContain("spec_approved");
    const spec = r.source.comments.find((c) => c.marker.includes("spec:"))!.body;
    expect(spec).toContain("at the size checkpoint");
    expect(spec).toContain("1275 lines or 34 files");
    expect(spec).toContain("/approve");
  });

  it("at the threshold it is an ordinary spec: auto mode approves it", async () => {
    const r = await autoTriage({ ...triageSpec, estimated_lines: 1275, estimated_files: 34 });
    expect(r.changes.map((c) => c.reason)).toContain("spec_approved");
  });

  it("1 phase or more than 4 is refused: nothing is stored and the item does not move on", async () => {
    for (const n of [1, 5]) {
      const r = await autoTriage({ ...triageSpec, estimated_lines: 1400, phases: Array.from({ length: n }, (_, i) => phase(i + 1)) });
      expect(r.it).toMatchObject({ stage: "NEW", done_criteria: null });
      expect(r.source.comments.some((c) => c.marker.includes("spec:"))).toBe(false);
    }
  });
});
