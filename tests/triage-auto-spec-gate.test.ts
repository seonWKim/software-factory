import { describe, expect, it } from "vitest";
import { NO_FILES_REFUSAL } from "../src/core/commands.js";
import { triageSpec } from "./helpers/fakes/config.js";
import { autoTriage } from "./helpers/classifier.js";

// The triage outcome in auto mode (design 03-risk, 04-spec-gate-commands 2026-11-20): auto mode approves a spec it may,
// never one that changes no file in this repo, which waits at the spec gate with the comment a person gets.

describe("auto mode and a spec that changes no file in this repo", () => {
  it("auto mode approves a spec that changes a file (the setup reaches auto mode)", async () => {
    const r = await autoTriage(triageSpec);
    expect(r.changes.map((c) => c.reason)).toContain("spec_approved");
  });

  it("is not approved: it waits at the spec gate with the same comment, naming /revise and /reject and not /approve", async () => {
    const r = await autoTriage({ ...triageSpec, files_to_change: [] });
    expect(r.it).toMatchObject({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    expect(r.changes.map((c) => c.reason)).not.toContain("spec_approved");
    expect((await r.store.listRuns(r.it.id)).map((x) => x.kind)).toEqual(["triage"]);
    const spec = r.source.comments.find((c) => c.marker.includes("spec:"))!.body;
    expect(spec).toContain(`This spec cannot be approved: ${NO_FILES_REFUSAL}.`);
    expect(spec).not.toContain("Auto mode is on");
    expect(spec).not.toContain("/approve");
  });
});
