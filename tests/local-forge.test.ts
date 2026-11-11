// The local forge (docs/plugins/forge.md): change refs are branch names with no link, it makes no read, write or
// outbound call, and with no forge selected the kernel reads revert and fix-forward links through it (compose
// builds it through the registry and gives it as the controller's `links`).

import { describe, expect, it } from "vitest";
import type { WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalForge } from "../src/impl/forge/local-forge.js";
import { githubLinks } from "../src/impl/github/github-forge.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { REGISTRY } from "../src/plugins.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { HealthMonitor } from "../src/ui/health.js";
import { renderItem } from "../src/ui/pages.js";
import { FakeAuth, FakeSource, alice, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { issue, newStore, system } from "./helpers/store.js";

const SHA = "0123abcd0123abcd0123abcd0123abcd0123abcd";

describe("LocalForge.parseLinks", () => {
  const forge = new LocalForge("factory/");

  it("reads branch names as change refs: a Revert subject's branches, no reverting change, and Fixes / Follow-up to", () => {
    expect(forge.parseLinks(`Revert "Merge factory/wi_1 into main"\n\nThis reverts commit ${SHA}.`)).toEqual({
      reverted_shas: [SHA], reverted_refs: ["factory/wi_1"], reverting_ref: null, fix_refs: [],
    });
    expect(forge.parseLinks("Gate breaks\nFixes factory/wi_2. Follow-up to factory/wi_3, also fixes factory/wi_2")).toMatchObject({
      reverted_refs: [], fix_refs: ["factory/wi_2", "factory/wi_3"],
    });
  });

  it("reads no GitHub form: #N in a Revert subject or after Fixes names no change", () => {
    expect(forge.parseLinks('Revert "Title (#34)" (#50)\n\nFixes #34')).toEqual({
      reverted_shas: [], reverted_refs: [], reverting_ref: null, fix_refs: [],
    });
    expect(forge.parseLinks("Merge factory/wi_1 into main")).toMatchObject({ reverted_refs: [] });
  });

  it("the GitHub forge reads the same message in its #N forms, as PR numbers in text", () => {
    expect(githubLinks('Revert "Title (#34)" (#50)\n\nFixes #34')).toEqual({
      reverted_shas: [], reverted_refs: ["34"], reverting_ref: "50", fix_refs: ["34"],
    });
  });
});

describe("LocalForge: no reads, no writes, no outbound call", () => {
  it("answers every method with nothing and holds no state", async () => {
    const forge = new LocalForge("factory/");
    expect(await forge.poll(null)).toEqual({ events: [], next_cursor: "" });
    expect(await forge.poll("c1")).toEqual({ events: [], next_cursor: "c1" });
    expect(await forge.postPrComment()).toEqual({ url: null });
    expect(await forge.prChecks()).toEqual({ state: "passed" });
    expect(await forge.prCheckResults()).toEqual([]);
    expect(await forge.prFiles()).toEqual([]);
    expect(await forge.commitAuthor()).toBeNull();
    expect(await forge.commitsBetween()).toBeNull();
    expect(await forge.closePr()).toBe("not_open");
    expect(await forge.mergePr()).toMatchObject({ merged: false });
    expect(forge.prRef(7).link).toBe("");
    expect(forge.prNumberOf(forge.prRef(7))).toBe(7);
    for (const m of ["pushBase", "pushBranch", "openPr", "projectIdentity"]) expect(forge).not.toHaveProperty(m);
  });

  it("is discovered by the plugin registry as the forge `local`, not a default", async () => {
    expect(Object.keys(REGISTRY.forge.plugins)).toContain("local");
    expect(REGISTRY.forge.defaults.fallback).toBeUndefined();
    const d = (await import("../src/impl/forge/local.plugin.js")).default;
    expect(d).toMatchObject({ kind: "forge", name: "local" });
  });
});

async function setup(forge: LocalForge | null, links?: LocalForge) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const controller = new ControllerRole({
    store, source, ...(forge ? { forge } : {}), ...(links ? { links } : {}), auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner,
  });
  /** A factory item waiting for its merge, its change named by its branch, with no change link. */
  const inReview = async (n: number): Promise<WorkItem> => {
    const { item } = await store.createWorkItem(issue(n), system);
    const branch = `factory/${item.id}`;
    const r = await store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "session_finished",
      patch: { stage: "REVIEW", change_ref: branch, change_url: null, blocked_on: "human", blocked_reason: "merge_pending" },
    });
    if (!r.ok) throw new Error(r.reason);
    return r.item;
  };
  const ui = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 60_000, health: new HealthMonitor(async () => [{ ok: true, msg: "ok" }], clock) };
  return { store, source, controller, inReview, ui };
}

describe("a local-forge flow", () => {
  it("merges an item whose change_ref is its branch name, with change_url null; its page shows no GitHub link", async () => {
    const f = await setup(new LocalForge(config.branch_prefix));
    const it0 = await f.inReview(1);
    const branch = it0.change_ref!;
    await f.controller.handleEvent({ kind: "change_merged", change_ref: branch, head_branch: branch, merge_sha: "m1", merger: alice });
    const done = (await f.store.getWorkItem(it0.id))!;
    expect(done).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m1", change_ref: branch, change_url: null });

    const page = (await renderItem(f.ui, done.id))!;
    expect(page).toContain(branch);
    expect(page).not.toMatch(/github\.com\/[^"]*\/pull\//);
    expect(page).not.toContain(`href="${branch}"`);
  });

  it("with no forge selected, links are read through the local forge: a branch-named revert and fix-forward, never #N", async () => {
    const f = await setup(null, new LocalForge(config.branch_prefix));
    expect(f.controller.kernel.forge).toBeNull();
    const orig = await f.inReview(1);
    const branch = orig.change_ref!;
    await f.controller.handleEvent({ kind: "change_merged", change_ref: branch, head_branch: branch, merge_sha: SHA, merger: alice });

    // A GitHub-form revert names no change here; a branch-named one and a sha do.
    await f.controller.handleEvent({ kind: "base_commit", sha: "r0", message: 'Revert "Title (#34)" (#50)' });
    expect((await f.store.listStateChanges(orig.id)).filter((c) => c.reason === "reverted")).toEqual([]);
    await f.controller.handleEvent({ kind: "base_commit", sha: "r1", message: `Revert "Merge ${branch} into main"` });
    const reverted = (await f.store.listStateChanges(orig.id)).filter((c) => c.reason === "reverted");
    expect(reverted.map((c) => c.detail)).toEqual([{ reverting_commit: "r1", reverting_pr: null }]);

    f.source.queue.push({ kind: "item_requested", source: issueRef(60), requester: alice, title: "Gate breaks", body: `Fixes ${branch}` });
    await f.controller.tickIntake();
    const fix = (await f.store.getWorkItemBySource("github_issue", issueRef(60).id))!;
    // The store keeps fixes_pr as a number: a branch ref records only the forward link.
    expect(fix.fixes_pr).toBeNull();
    const forward = (await f.store.listStateChanges(orig.id)).filter((c) => c.reason === "fixed_forward");
    expect(forward.map((c) => c.detail)).toEqual([{ fix_work_item_id: fix.id }]);
  });
});
