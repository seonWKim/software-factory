import { describe, expect, it } from "vitest";
import type { Run, WorkItem } from "../src/core/types.js";
import { waitingSpec } from "../src/ui/commands.js";
import { triageSpec } from "./helpers/fakes.js";

// The item API's waiting spec (design 09-dashboard-item-commands, 2026-11-21): each decision carries its options'
// extra paths and done-when changes, and which of those paths the item's allowed_paths do not cover yet.

const item = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending", allowed_paths: [".github/workflows/", "docs/a.md"] } as unknown as WorkItem;
const triage = (spec: object) =>
  ({ kind: "triage", acknowledged_at: "2026-11-21T00:00:00.000Z", outcome: { status: "succeeded", data: { spec } } }) as unknown as Run;
const ask = { question: "Fail the job, or only warn?", reason: "A failing job blocks merges.", options: ["Fail the job", "Only warn"], default: "Fail the job", owner_only: false };
const same = async (v: string | null) => v;

describe("waitingSpec", () => {
  it("carries each option's extra paths, done-when changes and uncovered paths", async () => {
    const option_changes = [{ option: "Only warn", extra_paths: ["docs/a.md", "docs/ci.md"], done_when: ["CI warns on an outside path"] }];
    const spec = await waitingSpec(item, [triage({ ...triageSpec, decisions: [{ ...ask, option_changes }] })], same);
    expect(spec?.decisions[0]?.option_changes).toEqual([
      { option: "Only warn", extra_paths: ["docs/a.md", "docs/ci.md"], done_when: ["CI warns on an outside path"], uncovered_paths: ["docs/ci.md"] },
    ]);
  });

  it("an older spec whose options change nothing has no option changes", async () => {
    const spec = await waitingSpec(item, [triage({ ...triageSpec, decisions: [ask] })], same);
    expect(spec?.decisions[0]).toMatchObject({ options: ask.options, default: "Fail the job", option_changes: [] });
  });
});
