import { describe, expect, it } from "vitest";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import { config, triageSpec } from "./helpers/fakes/config.js";
import { autoTriage } from "./helpers/classifier.js";

// Migration timestamps (design 04-triage): the triage branch moves a new migration whose timestamp the base branch
// uses to the next free minute before parseTriage, so the stored spec and its comment show the new path.
describe("the triage branch and taken migration timestamps", () => {
  const mig = (stamp: string, component = "controller", slug = "new-thing") => `src/${component}/migrations/${stamp}-${component}-${slug}.migration.ts`;
  const listed: { ref: string; path: string }[] = [];
  const base = {
    listLocalFiles: async (s: { ref: string; path: string }) => {
      listed.push({ ref: s.ref, path: s.path });
      return [mig("20261122T1200", "controller", "schedules"), mig("20261122T1201", "worker", "cancel-closed-item-runs"), "src/core/policy.ts"];
    },
  } as unknown as Sandbox;
  const draft = (stamp: string) => ({
    ...triageSpec,
    allowed_paths: [mig(stamp), `tests/${stamp}-controller-new-thing.test.ts`],
    files_to_change: [mig(stamp), `tests/${stamp}-controller-new-thing.test.ts`],
    done_checks: [{ line: triageSpec.done_criteria[0], test_file: `tests/${stamp}-controller-new-thing.test.ts` }],
  });

  it("gives a spec draft naming a taken timestamp the next free one before it is shown", async () => {
    const r = await autoTriage(draft("20261122T1200"), base);
    expect(listed).toContainEqual({ ref: config.repo.base_branch, path: "src/" });
    // Companion rules may add paths after the drafted ones (the schema snapshot for a migration).
    expect(r.it.allowed_paths.slice(0, 2)).toEqual([mig("20261122T1202"), "tests/20261122T1202-controller-new-thing.test.ts"]);
    expect(r.it.files_to_change).toEqual([mig("20261122T1202"), "tests/20261122T1202-controller-new-thing.test.ts"]);
    const spec = r.source.comments.find((c) => c.marker.includes("spec:"))!.body;
    expect(spec).toContain(mig("20261122T1202"));
    expect(spec).not.toContain("20261122T1200-controller-new-thing");
  });

  it("leaves a spec whose migration timestamps are all free unchanged", async () => {
    const r = await autoTriage(draft("20261123T0900"), base);
    expect(r.it.allowed_paths.slice(0, 2)).toEqual(draft("20261123T0900").allowed_paths);
    expect(r.it.files_to_change).toEqual(draft("20261123T0900").files_to_change);
  });
});
