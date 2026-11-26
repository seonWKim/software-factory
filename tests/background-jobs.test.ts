import { describe, expect, it } from "vitest";
import { BACKGROUND_JOBS, activityOf, logRef, transcriptRef } from "../src/controller/background-jobs.js";
import * as store from "../src/impl/store/sql/activity.js";

// The background-job list (design 08-schedules-actions): every job the factory runs on its own, with its Activity kind
// and system actor ID. The guard test (phase 2) reads it; the store keeps its own copy of the actors it writes.

describe("BACKGROUND_JOBS", () => {
  it("lists each autonomous job with its Activity kind and a system actor ID, one job per kind", () => {
    const kinds = BACKGROUND_JOBS.map((j) => j.kind);
    expect(kinds).toEqual(expect.arrayContaining(["lease_expiry", "retention", "cleanup", "auto_grant", "schedule_run", "restart", "migration"]));
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const j of BACKGROUND_JOBS) {
      expect(j.actor_id, j.job).toMatch(/^system:/);
      expect(j.writes, j.job).toMatch(/\.ts: /);
    }
  });

  it("the store's actor IDs are the list's", () => {
    for (const [kind, actor] of Object.entries(store.STORE_ACTORS)) {
      expect(BACKGROUND_JOBS.find((j) => j.kind === kind)?.actor_id, kind).toBe(actor);
    }
  });

  it("activityOf fills in the kind's actor ID", () => {
    expect(activityOf("cleanup", { subject: "s", outcome: "o", reason: "r", ref: null })).toEqual({ actor_id: "system:cleanup", kind: "cleanup", subject: "s", outcome: "o", reason: "r", ref: null });
  });

  it("the unit's and the store's reference formats give the same text", () => {
    expect(transcriptRef("wi_1", "run_1")).toBe(store.transcriptRef("wi_1", "run_1"));
    expect(logRef("controller", "cleanup sweep")).toBe(store.logRef("controller", "cleanup sweep"));
  });
});
